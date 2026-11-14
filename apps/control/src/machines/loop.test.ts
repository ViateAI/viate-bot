import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { MachineRecord, MachineStore } from "../db/machines.js";
import { adminScope } from "../scope.js";
import type { ActivityProbe } from "./reconcile.js";
import { reconcileOnce, resetReconcileRuntime, type ReconcileDriver } from "./loop.js";

const key = randomBytes(32);
const spec = { cpu: 1, memMb: 1024, diskGb: 10 };
const idle: ActivityProbe = {
  hasActiveTask: () => false,
  hasAttachedViewer: () => false,
  hasRoutineSoon: () => false,
};
const busy: ActivityProbe = {
  hasActiveTask: () => true,
  hasAttachedViewer: () => false,
  hasRoutineSoon: () => false,
};

beforeEach(() => {
  resetReconcileRuntime();
});

function machine(userId: string, state: string): MachineRecord {
  return {
    id: userId,
    userId,
    state,
    containerId: `c-${userId}`,
    networkId: "net",
    volumeName: `vb-home-${userId}`,
    imageVersion: "viate-bot/machine:dev",
    spec,
    tokenEnc: "enc",
  };
}

function memory(rows: MachineRecord[]): MachineStore {
  return {
    find(scope) {
      return rows.find((row) => row.userId === scope.userId);
    },
    findById(scope, id) {
      return rows.find((row) => row.userId === scope.userId && row.id === id);
    },
    insert() {
      throw new Error("测试桩不插入机器");
    },
    update(scope, patch) {
      const row = rows.find((item) => item.userId === scope.userId);
      if (!row) return false;
      if (patch.state !== undefined) row.state = patch.state;
      return true;
    },
    updateById() {
      return false;
    },
    list() {
      return rows.map((row) => ({ id: row.id, userId: row.userId, state: row.state }));
    },
    findOwned() {
      return undefined;
    },
    updateOwned() {
      return false;
    },
  };
}

describe("reconcile orchestration", () => {
  it("keeps reconciling the next user when one machine fails", async () => {
    const starts: string[] = [];
    const driver: ReconcileDriver = {
      actualState: async (userId) => (userId === "user-a" ? "missing" : "stopped"),
      inspect: async () => ({ NetworkSettings: { Networks: {} } }),
      create: async () => {
        throw new Error("用户已经有一台机器");
      },
      start: async (userId) => {
        starts.push(userId);
      },
      stop: async () => {},
      delete: async () => {},
    };
    const actions = await reconcileOnce({
      driver,
      store: memory([machine("user-a", "running"), machine("user-b", "running")]),
      admin: adminScope("scheduler"),
      probe: idle,
      idleStopMinutes: 10_000,
      key,
    });
    expect(actions["user-a"]).toBe("failed");
    expect(actions["user-b"]).toBe("start");
    expect(starts).toEqual(["user-b"]);
  });

  it("restarts after the startup grace and keeps the error state reachable", async () => {
    const rows = [machine("grace", "running")];
    const starts: string[] = [];
    const driver: ReconcileDriver = {
      actualState: async () => "running",
      inspect: async () => ({ NetworkSettings: { Networks: {} } }),
      create: async () => {
        throw new Error("不应创建");
      },
      start: async () => {
        starts.push("restart");
      },
      stop: async () => {},
      delete: async () => {},
    };
    let elapsed = 0;
    const deps = {
      driver,
      store: memory(rows),
      admin: adminScope("scheduler"),
      probe: idle,
      idleStopMinutes: 10_000,
      key,
      now: () => new Date(elapsed),
    };
    for (let step = 0; step < 4; step += 1) {
      await reconcileOnce(deps);
      elapsed += 30_000;
    }
    expect(starts).toEqual([]);
    let steps = 4;
    while (rows[0]?.state !== "error" && steps < 40) {
      await reconcileOnce(deps);
      elapsed += 30_000;
      steps += 1;
    }
    expect(rows[0]?.state).toBe("error");
    expect(starts).toHaveLength(3);
  });

  it("starts the stop wait at zero even when a task is active", async () => {
    const rows = [machine("stop-user", "stopped")];
    const stops: string[] = [];
    const driver: ReconcileDriver = {
      actualState: async () => "running",
      inspect: async () => null,
      create: async () => {
        throw new Error("不应创建");
      },
      start: async () => {},
      stop: async (userId) => {
        stops.push(userId);
      },
      delete: async () => {},
    };
    let elapsed = 0;
    const deps = {
      driver,
      store: memory(rows),
      admin: adminScope("scheduler"),
      probe: busy,
      idleStopMinutes: 10_000,
      key,
      now: () => new Date(elapsed),
    };
    expect((await reconcileOnce(deps))["stop-user"]).toBe("wait-stop");
    expect(stops).toEqual([]);
    elapsed = 59_000;
    expect((await reconcileOnce(deps))["stop-user"]).toBe("wait-stop");
    elapsed = 60_000;
    expect((await reconcileOnce(deps))["stop-user"]).toBe("stop");
    expect(stops).toEqual(["stop-user"]);
  });

  it("stops an errored machine without clearing the error state", async () => {
    const rows = [machine("error-user", "error")];
    const stops: string[] = [];
    const driver: ReconcileDriver = {
      actualState: async () => "running",
      inspect: async () => null,
      create: async () => {
        throw new Error("不应创建");
      },
      start: async () => {},
      stop: async (userId) => {
        stops.push(userId);
      },
      delete: async () => {},
    };
    let elapsed = 0;
    const deps = {
      driver,
      store: memory(rows),
      admin: adminScope("scheduler"),
      probe: idle,
      idleStopMinutes: 10_000,
      key,
      now: () => new Date(elapsed),
    };
    expect((await reconcileOnce(deps))["error-user"]).toBe("wait-stop");
    expect(rows[0]?.state).toBe("error");
    elapsed = 60_000;
    expect((await reconcileOnce(deps))["error-user"]).toBe("stop");
    expect(stops).toEqual(["error-user"]);
    expect(rows[0]?.state).toBe("error");
  });
});
