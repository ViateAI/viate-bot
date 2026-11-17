import { MACHINED_PORT } from "@viate-bot/protocol";
import { decrypt } from "../crypto.js";
import { machineRepository } from "../db/machines.js";
import type { DockerDriver } from "../machines/docker.js";
import { userScope } from "../scope.js";
import type { EgressEndpoint, EgressHub } from "./hub.js";

/** 只连已经在跑的机器，不把停着的机器拉起来。 */
export async function readRunningEndpoint(
  db: Parameters<typeof machineRepository>[0],
  driver: DockerDriver,
  key: Buffer,
  userId: string,
): Promise<EgressEndpoint | undefined> {
  const record = machineRepository(db).find(userScope(userId));
  if (!record || record.state === "deleted") return undefined;
  const info = await driver.inspect(userId);
  if (!info?.State.Running) return undefined;
  const host = firstAddress(info.NetworkSettings.Networks);
  if (!host) return undefined;
  return { host, port: MACHINED_PORT, token: decrypt(key, record.tokenEnc) };
}

export function startEgressConnector(
  db: Parameters<typeof machineRepository>[0],
  driver: DockerDriver,
  key: Buffer,
  hub: EgressHub,
  intervalMs = 10_000,
): () => void {
  let stopped = false;
  const inflight = new Set<string>();
  const tick = () => {
    if (stopped) return;
    const rows = db.$client.prepare("select user_id as userId from machines where state = 'running'").all() as Array<{ userId: string }>;
    for (const row of rows) {
      if (hub.machineConnected(row.userId) || inflight.has(row.userId)) continue;
      inflight.add(row.userId);
      readRunningEndpoint(db, driver, key, row.userId)
        .then((endpoint) => {
          if (endpoint && !stopped) hub.connectEndpoint(row.userId, endpoint);
        })
        .catch(() => undefined)
        .finally(() => inflight.delete(row.userId));
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function firstAddress(networks: Record<string, { IPAddress?: string } | undefined> | undefined): string | undefined {
  if (!networks) return undefined;
  for (const network of Object.values(networks)) {
    if (network?.IPAddress) return network.IPAddress;
  }
  return undefined;
}
