import { decrypt } from "../crypto.js";
import type { MachineRecord, MachineStore } from "../db/machines.js";
import { userScope, type AdminScope, type UserScope } from "../scope.js";
import {
  decideReconcile,
  type ActivityProbe,
  type ActualState,
  type DesiredState,
  type ReconcileAction,
} from "./reconcile.js";

export interface ReconcileDriver {
  create(store: MachineStore, scope: UserScope, spec: MachineRecord["spec"]): Promise<MachineRecord>;
  start(userId: string): Promise<void>;
  stop(userId: string, timeoutSec?: number): Promise<void>;
  delete(store: MachineStore, scope: UserScope): Promise<void>;
  inspect(userId: string): Promise<{ NetworkSettings?: { Networks?: DockerNetworkMap } } | null>;
  actualState(userId: string): Promise<ActualState>;
}

export interface ReconcileDeps {
  driver: ReconcileDriver;
  store: MachineStore;
  admin: AdminScope;
  probe: ActivityProbe;
  idleStopMinutes: number;
  key: Buffer;
  now?: () => Date;
  /** 测试替换健康检查。缺省打 machined /health。 */
  ping?: (record: MachineRecord) => Promise<boolean>;
  /**
   * 容器身份变化且健康后重装 desired=present。
   * 抛错只记应用失败，不得因此重启或把机器打成 error。
   */
  reconcileApps?: (input: { userId: string; machineId: string; containerId: string; force?: boolean }) => Promise<void>;
}

/** 容器刚启动时 machined 可能还没监听。这段时间内的心跳失败不触发重启。 */
export const STARTUP_GRACE_MS = 60_000;

interface MachineRuntime {
  heartbeatFailures: number;
  restartFailures: number;
  stopRequestedAt: Date | null;
  idleSince: Date | null;
  /** 此时间之前不计心跳失败。null 表示还没观察到这次启动。 */
  healthyAfter: Date | null;
  /** 已经对过账的容器。失败也记在这里，避免安装失败把机器重启循环打满。 */
  reconciledContainerId: string | null;
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
    healthyAfter: null,
    reconciledContainerId: null,
  };
  runtime.set(userId, created);
  return created;
}

export type ReconcileOutcome = ReconcileAction["type"] | "failed";

/** 跑一轮对账。返回每个用户实际执行的动作，方便开发和测试观察。 */
export async function reconcileOnce(deps: ReconcileDeps): Promise<Record<string, ReconcileOutcome>> {
  const now = deps.now?.() ?? new Date();
  const actions: Record<string, ReconcileOutcome> = {};
  // 调度器只用 AdminScope 列出机器元数据。完整记录（含 token）改用该行自己的 UserScope 读取。
  for (const meta of deps.store.list(deps.admin)) {
    const record = deps.store.find(userScope(meta.userId));
    if (!record || record.id !== meta.id) continue;
    try {
      actions[record.userId] = await reconcileUser(deps, record, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`对账 ${record.userId} 失败：${message}`);
      actions[record.userId] = "failed";
    }
  }
  return actions;
}

/** 运行时计数放在进程内存里。测试在用例之间清掉，避免互相影响。 */
export function resetReconcileRuntime(): void {
  runtime.clear();
}

async function reconcileUser(deps: ReconcileDeps, record: MachineRecord, now: Date): Promise<ReconcileAction["type"]> {
  const state = runtimeOf(record.userId);
  const desired = nextDesired(deps, record, state, now);
  const actual = await deps.driver.actualState(record.userId);
  if (actual === "running") {
    const healthyAfter = state.healthyAfter ?? new Date(now.getTime() + STARTUP_GRACE_MS);
    state.healthyAfter = healthyAfter;
    if (now < healthyAfter) state.heartbeatFailures = 0;
    else await observeHeartbeat(deps, record, state);
  } else {
    state.heartbeatFailures = 0;
    state.healthyAfter = null;
  }

  const stopWaitedSec = state.stopRequestedAt ? (now.getTime() - state.stopRequestedAt.getTime()) / 1000 : 0;
  const action = decideReconcile({
    desired,
    actual,
    heartbeatFailures: state.heartbeatFailures,
    restartFailures: state.restartFailures,
    stopWaitedSec,
  });
  if (action.type === "wait-stop") state.stopRequestedAt ??= now;
  else state.stopRequestedAt = null;
  await apply(deps, record, actual, action, now);
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
    if (record.state === "deleted") return "deleted";
    // error 只表示对账无法自行恢复。容器仍按 stopped 收敛，但数据库状态留给 apply 保留。
    return "stopped";
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
  const healthy = deps.ping ? await deps.ping(record) : await ping(deps, record);
  if (healthy) {
    state.heartbeatFailures = 0;
    state.restartFailures = 0;
    const containerId = record.containerId;
    if (deps.reconcileApps && containerId && state.reconciledContainerId !== containerId) {
      state.reconciledContainerId = containerId;
      try {
        await deps.reconcileApps({ userId: record.userId, machineId: record.id, containerId });
      } catch (error) {
        console.error("应用对账失败", error instanceof Error ? error.message : "unknown");
      }
    }
    return;
  }
  state.heartbeatFailures += 1;
}

async function ping(deps: ReconcileDeps, record: MachineRecord): Promise<boolean> {
  const info = await deps.driver.inspect(record.userId);
  const address = info ? firstAddress(info.NetworkSettings?.Networks) : undefined;
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
  now: Date,
): Promise<void> {
  const state = runtimeOf(record.userId);
  const scope = userScope(record.userId);
  if (action.type === "create") {
    await deps.driver.create(deps.store, scope, record.spec);
    await deps.driver.start(record.userId);
    deps.store.update(scope, { state: "running" });
    state.healthyAfter = new Date(now.getTime() + STARTUP_GRACE_MS);
  } else if (action.type === "start") {
    await deps.driver.start(record.userId);
    deps.store.update(scope, { state: "running" });
    state.healthyAfter = new Date(now.getTime() + STARTUP_GRACE_MS);
  } else if (action.type === "restart") {
    await deps.driver.stop(record.userId);
    try {
      await deps.driver.start(record.userId);
      noteRestart(state, now);
    } catch (error) {
      noteRestart(state, now);
      throw error;
    }
  } else if (action.type === "stop") {
    await deps.driver.stop(record.userId);
    if (record.state !== "error") deps.store.update(scope, { state: "stopped" });
  } else if (action.type === "mark-error") {
    deps.store.update(scope, { state: "error" });
  } else if (action.type === "delete" && actual !== "missing") {
    await deps.driver.delete(deps.store, scope);
  }
}

function noteRestart(state: MachineRuntime, now: Date): void {
  state.restartFailures += 1;
  state.heartbeatFailures = 0;
  state.healthyAfter = new Date(now.getTime() + STARTUP_GRACE_MS);
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
