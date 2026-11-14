import { decrypt } from "../crypto.js";
import type { MachineRecord, MachineStore } from "../db/machines.js";
import { userScope, type AdminScope } from "../scope.js";
import type { DockerDriver } from "./docker.js";
import {
  decideReconcile,
  type ActivityProbe,
  type ActualState,
  type DesiredState,
  type ReconcileAction,
} from "./reconcile.js";

export interface ReconcileDeps {
  driver: DockerDriver;
  store: MachineStore;
  admin: AdminScope;
  probe: ActivityProbe;
  idleStopMinutes: number;
  key: Buffer;
  now?: () => Date;
}

interface MachineRuntime {
  heartbeatFailures: number;
  restartFailures: number;
  stopRequestedAt: Date | null;
  idleSince: Date | null;
  /** 至少成功心跳过一次。启动后的第一次成功之前，不把失败计为需要重启。 */
  seenHealthy: boolean;
}

const runtime = new Map<string, MachineRuntime>();

function runtimeOf(userId: string): MachineRuntime {
  const current = runtime.get(userId);
  if (current) return current;
  const created: MachineRuntime = {
    heartbeatFailures: 0,
    restartFailures: 0,
    stopRequestedAt: null,
    idleSince: null,
    seenHealthy: false,
  };
  runtime.set(userId, created);
  return created;
}

/** 跑一轮对账。返回每个用户实际执行的动作，方便开发和测试观察。 */
export async function reconcileOnce(deps: ReconcileDeps): Promise<Record<string, ReconcileAction["type"]>> {
  const now = deps.now?.() ?? new Date();
  const actions: Record<string, ReconcileAction["type"]> = {};
  // 调度器只用 AdminScope 列出机器元数据。完整记录（含 token）改用该行自己的 UserScope 读取。
  for (const meta of deps.store.list(deps.admin)) {
    const record = deps.store.find(userScope(meta.userId));
    if (!record || record.id !== meta.id) continue;
    actions[record.userId] = await reconcileUser(deps, record, now);
  }
  return actions;
}

async function reconcileUser(deps: ReconcileDeps, record: MachineRecord, now: Date): Promise<ReconcileAction["type"]> {
  const state = runtimeOf(record.userId);
  const desired = nextDesired(deps, record, state, now);
  const actual = await deps.driver.actualState(record.userId);
  if (actual === "running") await observeHeartbeat(deps, record, state);
  else {
    state.heartbeatFailures = 0;
    state.seenHealthy = false;
  }

  const action = decideReconcile({
    desired,
    actual,
    heartbeatFailures: state.seenHealthy ? state.heartbeatFailures : 0,
    restartFailures: state.restartFailures,
    stopWaitedSec: state.stopRequestedAt ? (now.getTime() - state.stopRequestedAt.getTime()) / 1000 : 60,
  });
  if (action.type === "wait-stop") state.stopRequestedAt ??= now;
  else state.stopRequestedAt = null;
  await apply(deps, record, actual, action);
  return action.type;
}

function nextDesired(
  deps: ReconcileDeps,
  record: MachineRecord,
  state: MachineRuntime,
  now: Date,
): DesiredState {
  if (record.state !== "running") {
    state.idleSince = null;
    return record.state === "deleted" ? "deleted" : "stopped";
  }
  const busy =
    deps.probe.hasActiveTask(record.userId) ||
    deps.probe.hasAttachedViewer(record.userId) ||
    deps.probe.hasRoutineSoon(record.userId);
  if (busy) {
    state.idleSince = null;
    return "running";
  }
  state.idleSince ??= now;
  const idleMs = now.getTime() - state.idleSince.getTime();
  if (idleMs < deps.idleStopMinutes * 60_000) return "running";
  deps.store.update(userScope(record.userId), { state: "stopped" });
  return "stopped";
}

async function observeHeartbeat(deps: ReconcileDeps, record: MachineRecord, state: MachineRuntime): Promise<void> {
  const healthy = await ping(deps, record);
  if (healthy) {
    state.heartbeatFailures = 0;
    state.restartFailures = 0;
    state.seenHealthy = true;
    return;
  }
  state.heartbeatFailures += 1;
}

async function ping(deps: ReconcileDeps, record: MachineRecord): Promise<boolean> {
  const info = await deps.driver.inspect(record.userId);
  const address = info ? firstAddress(info.NetworkSettings.Networks) : undefined;
  if (!address) return false;
  try {
    const response = await fetch(`http://${address}:7070/health`, {
      headers: { authorization: `Bearer ${decrypt(deps.key, record.tokenEnc)}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    deps.store.update(userScope(record.userId), { lastHeartbeatAt: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

async function apply(
  deps: ReconcileDeps,
  record: MachineRecord,
  actual: ActualState,
  action: ReconcileAction,
): Promise<void> {
  const state = runtimeOf(record.userId);
  const scope = userScope(record.userId);
  if (action.type === "create") {
    await deps.driver.create(deps.store, scope, record.spec);
    await deps.driver.start(record.userId);
    deps.store.update(scope, { state: "running" });
  } else if (action.type === "start") {
    await deps.driver.start(record.userId);
    deps.store.update(scope, { state: "running" });
  } else if (action.type === "restart") {
    await deps.driver.stop(record.userId);
    try {
      await deps.driver.start(record.userId);
      state.restartFailures += 1;
      state.heartbeatFailures = 0;
      state.seenHealthy = false;
    } catch (error) {
      state.restartFailures += 1;
      throw error;
    }
  } else if (action.type === "stop") {
    await deps.driver.stop(record.userId);
    deps.store.update(scope, { state: "stopped" });
  } else if (action.type === "mark-error") {
    deps.store.update(scope, { state: "error" });
  } else if (action.type === "delete" && actual !== "missing") {
    await deps.driver.delete(deps.store, scope);
  }
}

function firstAddress(networks: DockerNetworkMap | undefined): string | undefined {
  if (!networks) return undefined;
  for (const network of Object.values(networks)) {
    if (network?.IPAddress) return network.IPAddress;
  }
  return undefined;
}

interface DockerNetworkMap {
  [name: string]: { IPAddress?: string } | undefined;
}
