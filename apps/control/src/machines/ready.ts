import type { MachineEndpoint } from "@viate-bot/protocol";
import { decrypt, encrypt } from "../crypto.js";
import type { AppDatabase } from "../db/index.js";
import { machineRepository } from "../db/machines.js";
import { quotaRepository } from "../db/quotas.js";
import { ulid } from "../id.js";
import { userScope } from "../scope.js";
import type { DockerDriver } from "./docker.js";
import type { MachineSpec } from "./policy.js";
import { devSpec } from "../runtime.js";

const MACHINED_PORT = 7070;
const READY_TIMEOUT_MS = 90_000;

export interface MachineHost {
  db: AppDatabase;
  driver: DockerDriver;
  key: Buffer;
  /** 机器健康后按容器身份重装期望仍在的应用。失败不得让就绪变成机器重启。 */
  reconcileApps?: (input: { userId: string; machineId: string; containerId: string; force?: boolean }) => Promise<void>;
}

/** 该用户第一台机器在创建 bot 时建好，先停着。之后的 bot 直接复用。 */
export async function ensureUserMachine(ctx: MachineHost, userId: string, requestedSpec?: MachineSpec): Promise<void> {
  const store = machineRepository(ctx.db);
  const scope = userScope(userId);
  const existing = store.find(scope);
  if (existing && existing.state !== "deleted") return;
  const spec = requestedSpec ?? quotaRepository(ctx.db).find(scope)?.spec ?? devSpec;
  await ctx.driver.create(store, scope, spec);
}

/**
 * 任务开始时如果机器停着，就启动并等到 machined 健康。
 * token 只放进返回值，不写日志。
 */
export async function prepareMachineEndpoint(
  ctx: MachineHost,
  userId: string,
  onPhase: (phase: "starting" | "ready") => void,
  fetchImpl: typeof fetch = fetch,
): Promise<MachineEndpoint> {
  const store = machineRepository(ctx.db);
  const scope = userScope(userId);
  let record = store.find(scope);
  if (!record || record.state === "deleted") {
    await ensureUserMachine(ctx, userId);
    record = store.find(scope);
  }
  if (!record) throw new Error("机器没有创建成功");
  const actual = await ctx.driver.actualState(userId);
  if (actual !== "running") {
    onPhase("starting");
    if (actual === "missing") {
      await ctx.driver.create(store, scope, record.spec);
      record = store.find(scope);
      if (!record) throw new Error("机器没有创建成功");
    }
    await ctx.driver.start(userId);
    store.update(scope, { state: "running" });
  }
  const token = decrypt(ctx.key, record.tokenEnc);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await ctx.driver.inspect(userId);
    const host = firstAddress(info?.NetworkSettings.Networks);
    if (host) {
      try {
        const response = await fetchImpl(`http://${host}:${MACHINED_PORT}/health`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          onPhase("ready");
          const current = store.find(scope) ?? record;
          if (ctx.reconcileApps && current.containerId) {
            await ctx.reconcileApps({ userId, machineId: current.id, containerId: current.containerId });
          }
          return { host, port: MACHINED_PORT, token };
        }
      } catch {
        // 容器刚起来时健康检查会失败，继续等。
      }
    }
    await delay(500);
  }
  throw new Error("机器没有在 90 秒内就绪");
}

function firstAddress(
  networks: Record<string, { IPAddress?: string } | undefined> | undefined,
): string | undefined {
  if (!networks) return undefined;
  for (const network of Object.values(networks)) {
    if (network?.IPAddress) return network.IPAddress;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
 
 export function devMachineBypass(env: NodeJS.ProcessEnv = process.env): MachineEndpoint | undefined {
   if (env.VB_DEV !== "1" || !env.VB_DEV_MACHINE) return undefined;
   const [host, portText, token] = env.VB_DEV_MACHINE.split(",");
   const port = Number(portText);
   if (!host || !token || !Number.isInteger(port) || port < 1) throw new Error("VB_DEV_MACHINE 必须是 host,port,token");
   return { host, port, token };
 }
 
 export function rememberDevMachine(db: AppDatabase, key: Buffer, userId: string, endpoint: MachineEndpoint): void {
   const store = machineRepository(db);
   const scope = userScope(userId);
   const tokenEnc = encrypt(key, endpoint.token);
   const existing = store.find(scope);
   if (existing && existing.state !== "deleted") {
     store.update(scope, { state: "running", tokenEnc });
     return;
   }
   store.insert(scope, {
     id: ulid(),
     userId,
     state: "running",
     containerId: null,
     networkId: null,
     volumeName: "dev-bypass",
     imageVersion: "dev-bypass",
     spec: devSpec,
     tokenEnc,
   });
 }
