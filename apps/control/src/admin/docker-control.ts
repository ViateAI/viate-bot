import type { MachineControl } from "./service.js";
import { machineRepository } from "../db/machines.js";
import type { AppDatabase } from "../db/index.js";
import type { DockerDriver } from "../machines/docker.js";
import type { MachineSpec } from "../machines/policy.js";
import { prepareMachineEndpoint, type MachineHost } from "../machines/ready.js";
import { userScope } from "../scope.js";

export function dockerMachineControl(host: MachineHost): MachineControl {
  const { db, driver } = host;
  const store = machineRepository(db);
  return {
    async start(userId) {
      await driver.start(userId);
      store.update(userScope(userId), { state: "running" });
      await prepareMachineEndpoint(host, userId, () => {});
    },
    async stop(userId) {
      await driver.stop(userId);
      store.update(userScope(userId), { state: "stopped" });
    },
    async restart(userId) {
      await driver.stop(userId);
      await driver.start(userId);
      store.update(userScope(userId), { state: "running" });
      await prepareMachineEndpoint(host, userId, () => {});
    },
    async rebuild(userId, spec: MachineSpec) {
      const record = await driver.rebuild(store, userScope(userId), spec);
      if (record.state === "running") await prepareMachineEndpoint(host, userId, () => {});
    },
    async remove(userId) {
      const scope = userScope(userId);
      if (!store.find(scope)) return;
      await driver.delete(store, scope);
    },
    async stats(userId) {
      return summarizeDockerStats(await driver.stats(userId));
    },
  };
}

export async function deleteCreatedMachine(db: AppDatabase, driver: DockerDriver, userId: string): Promise<void> {
  const store = machineRepository(db);
  const scope = userScope(userId);
  // createContainer 失败时还没有机器行，但网络已经创建；删除按用户命名的残片，卷不动。
  await driver.delete(store, scope);
}

interface DockerStatsLike {
  cpu_stats?: {
    online_cpus?: number;
    system_cpu_usage?: number;
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
  };
  precpu_stats?: {
    system_cpu_usage?: number;
    cpu_usage?: { total_usage?: number };
  };
  memory_stats?: { usage?: number };
}

export function summarizeDockerStats(stats: DockerStatsLike): { cpuPct: number; memMb: number } {
  const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cpuPct = systemDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0;
  const memMb = (stats.memory_stats?.usage ?? 0) / (1024 * 1024);
  return { cpuPct: round1(cpuPct), memMb: round1(memMb) };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
