import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encrypt, loadOrCreateKey } from "../crypto.js";
import { auditRepository } from "../db/audit.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { machineRepository } from "../db/machines.js";
import { schedulerScope, userScope } from "../scope.js";
import type { DockerDriver } from "./docker.js";
import { prepareMachineEndpoint } from "./ready.js";
import { reconcileOnce, resetReconcileRuntime } from "./loop.js";
import { dockerMachineControl } from "../admin/docker-control.js";
import { rebuildMachine } from "../admin/service.js";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  resetReconcileRuntime();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(): { db: AppDatabase; key: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "vb-protocol-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  db.$client.prepare(
    "insert into users(id,email,name,status,is_admin,created_at) values ('user-1','user@example.com','User','active',0,'now')",
  ).run();
  const key = loadOrCreateKey(join(dir, "secret.key"));
  machineRepository(db).insert(userScope("user-1"), {
    id: "machine-1",
    userId: "user-1",
    state: "running",
    containerId: "container-1",
    networkId: "net-1",
    volumeName: "vb-home-user-1",
    imageVersion: "viate-bot/machine:dev",
    spec: { cpu: 1, memMb: 1024, diskGb: 10 },
    tokenEnc: encrypt(key, "machine-token"),
  });
  return { db, key };
}

function driver(stopped: { value: boolean }): DockerDriver {
  return {
    create: async () => {
      throw new Error("不应创建");
    },
    start: async () => {
      throw new Error("不应启动");
    },
    stop: async () => {
      stopped.value = true;
    },
    inspect: async () => ({
      NetworkSettings: { Networks: { n: { IPAddress: "10.1.0.2" } } },
    }),
    actualState: async () => "running",
  } as unknown as DockerDriver;
}

function healthFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

describe("machine protocol", () => {
  it("rejects an incompatible administrative start before reporting success", async () => {
    const { db, key } = open();
    const stopped = { value: false };
    const testDriver = driver(stopped);
    testDriver.start = async () => {};
    vi.stubGlobal("fetch", healthFetch({ ok: true, protocol: 2 }));
    try {
      const control = dockerMachineControl({ db, driver: testDriver, key });
      await expect(control.start("user-1")).rejects.toThrow("机器镜像协议版本 2");
      expect(stopped.value).toBe(true);
      expect(machineRepository(db).find(userScope("user-1"))?.state).toBe("error");
    } finally { db.$client.close(); }
  });

  it("rebuilds through the configured compatible image instead of pinning the machine's old release", async () => {
    const { db, key } = open();
    let selected: string | undefined;
    const control = {
      ...dockerMachineControl({ db, key, driver: driver({ value: false }) }),
      rebuild: async (_userId: string, _spec: unknown, image = "ghcr.io/viateai/viate-bot-machine:v0.2.0") => {
        selected = image;
        machineRepository(db).update(userScope("user-1"), { imageVersion: image });
      },
    };
    try {
      await rebuildMachine(control, db, schedulerScope, "machine-1");
      expect(selected).toBe("ghcr.io/viateai/viate-bot-machine:v0.2.0");
      expect(auditRepository(db).list(schedulerScope, 10)[0]?.attrs).toMatchObject({ image: selected });
    } finally { db.$client.close(); }
  });

  it("stops a protocol mismatch on its first heartbeat without restarting or reconciling apps", async () => {
    const { db, key } = open();
    let stopped = false;
    let elapsed = 0;
    const apps = vi.fn();
    const testDriver = driver({ value: false });
    testDriver.actualState = async () => stopped ? "stopped" : "running";
    testDriver.stop = async () => { stopped = true; };
    vi.stubGlobal("fetch", healthFetch({ ok: true, protocol: 2 }));
    const deps = {
      db, key, driver: testDriver, store: machineRepository(db), admin: schedulerScope,
      idleStopMinutes: 120, now: () => new Date(elapsed), reconcileApps: apps,
      probe: { hasActiveTask: () => true, hasAttachedViewer: () => false, hasRoutineSoon: () => false },
    };
    try {
      await reconcileOnce(deps);
      elapsed = 60_000;
      expect((await reconcileOnce(deps))["user-1"]).toBe("stop");
      expect(stopped).toBe(true);
      expect(machineRepository(db).find(userScope("user-1"))).toMatchObject({ state: "error", statusDetail: expect.stringContaining("协议版本 2") });
      for (let step = 0; step < 4; step++) await reconcileOnce(deps);
      expect(auditRepository(db).list(schedulerScope, 10)).toHaveLength(1);
      expect(apps).not.toHaveBeenCalled();
    } finally { db.$client.close(); }
  });

  it("keeps a recovered compatible machine running instead of applying a stale error stop", async () => {
    const { db, key } = open();
    const store = machineRepository(db);
    store.update(userScope("user-1"), { state: "error", statusDetail: "机器镜像协议版本 2，控制面需要 1，请重建机器" });
    const stopped = { value: false };
    let elapsed = 0;
    vi.stubGlobal("fetch", healthFetch({ ok: true, protocol: 1 }));
    const deps = {
      db, key, driver: driver(stopped), store, admin: schedulerScope,
      idleStopMinutes: 120, now: () => new Date(elapsed),
      probe: { hasActiveTask: () => true, hasAttachedViewer: () => false, hasRoutineSoon: () => false },
    };
    try {
      await reconcileOnce(deps);
      elapsed = 60_000;
      await reconcileOnce(deps);
      expect(stopped.value).toBe(false);
      expect(store.find(userScope("user-1"))).toMatchObject({ state: "running", statusDetail: null });
      elapsed += 60_000;
      expect((await reconcileOnce(deps))["user-1"]).toBe("none");
    } finally { db.$client.close(); }
  });

  it("accepts protocol 1 and a health body that omits the field", async () => {
    for (const body of [{ ok: true, version: "0.0.0", protocol: 1 }, { ok: true, version: "0.0.0" }]) {
      const { db, key } = open();
      const stopped = { value: false };
      const endpoint = await prepareMachineEndpoint(
        { db, driver: driver(stopped), key },
        "user-1",
        () => {},
        healthFetch(body),
      );
      expect(endpoint).toMatchObject({ host: "10.1.0.2", port: 7070, token: "machine-token" });
      expect(stopped.value).toBe(false);
      expect(machineRepository(db).find(userScope("user-1"))?.state).toBe("running");
      expect(auditRepository(db).list(schedulerScope, 10)).toEqual([]);
      db.$client.close();
    }
  });

  it("refuses protocol 2, records the reason once, and does not return an endpoint", async () => {
    const { db, key } = open();
    const stopped = { value: false };
    const host = { db, driver: driver(stopped), key };
    const fetchImpl = healthFetch({ ok: true, version: "0.0.0", protocol: 2 });
    await expect(prepareMachineEndpoint(host, "user-1", () => {}, fetchImpl)).rejects.toThrow(
      "机器镜像协议版本 2，控制面需要 1，请重建机器",
    );
    expect(stopped.value).toBe(true);
    const machine = machineRepository(db).findAdmin(schedulerScope, "machine-1");
    expect(machine?.state).toBe("error");
    expect(machine?.statusDetail).toBe("机器镜像协议版本 2，控制面需要 1，请重建机器");
    await expect(prepareMachineEndpoint(host, "user-1", () => {}, fetchImpl)).rejects.toThrow(
      "机器镜像协议版本 2，控制面需要 1，请重建机器",
    );
    const audits = auditRepository(db).list(schedulerScope, 10);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "machine.protocol",
      target: "machine-1",
      attrs: { userId: "user-1", reported: 2, need: "1" },
    });
    db.$client.close();
  });

  it("clears a protocol refusal after a compatible health check", async () => {
    const { db, key } = open();
    db.$client.prepare("update machines set state='error', status_detail='机器镜像协议版本 2，控制面需要 1，请重建机器' where id='machine-1'").run();
    const stopped = { value: false };
    const endpoint = await prepareMachineEndpoint(
      { db, driver: driver(stopped), key },
      "user-1",
      () => {},
      healthFetch({ ok: true, protocol: 1 }),
    );
    expect(endpoint.host).toBe("10.1.0.2");
    expect(stopped.value).toBe(false);
    const machine = machineRepository(db).findAdmin(schedulerScope, "machine-1");
    expect(machine?.state).toBe("running");
    expect(machine?.statusDetail).toBeNull();
    db.$client.close();
  });
});
