import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { adminScope, userScope } from "../scope.js";
import { botRepository } from "./bots.js";
import { credentialRepository } from "./credentials.js";
import { openDatabase } from "./index.js";
import { machineRepository, type MachineRecord } from "./machines.js";
import { ensureDevUser } from "./users.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), "vb-access-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  ensureDevUser(db, "user-a");
  ensureDevUser(db, "user-b");
  return db;
}

function machine(id: string, userId: string, state = "stopped"): MachineRecord {
  return {
    id,
    userId,
    state,
    containerId: null,
    networkId: null,
    volumeName: `vb-home-${userId}`,
    imageVersion: "viate-bot/machine:dev",
    spec: { cpu: 1, memMb: 1024, diskGb: 10 },
    tokenEnc: `enc-${userId}`,
  };
}

describe("scoped machine and bot access", () => {
  it("does not let user A read or change user B's machine or bot", () => {
    const db = database();
    const machines = machineRepository(db);
    const bots = botRepository(db);
    const scopeA = userScope("user-a");
    const scopeB = userScope("user-b");
    machines.insert(scopeA, machine("machine-a", "user-a"));
    machines.insert(scopeB, machine("machine-b", "user-b"));
    bots.insert(scopeA, { id: "bot-a", name: "A", model: "m" });
    bots.insert(scopeB, { id: "bot-b", name: "B", model: "m" });

    expect(machines.findById(scopeA, "machine-b")).toBeUndefined();
    expect(machines.find(scopeA)?.id).toBe("machine-a");
    expect(machines.updateById(scopeA, "machine-b", { state: "running" })).toBe(false);
    expect(machines.update(scopeA, { state: "running" })).toBe(true);
    expect(machines.findById(scopeB, "machine-b")?.state).toBe("stopped");
    expect(machines.find(scopeA)?.state).toBe("running");

    expect(bots.findById(scopeA, "bot-b")).toBeUndefined();
    expect(bots.list(scopeA).map((bot) => bot.id)).toEqual(["bot-a"]);
    expect(bots.update(scopeA, "bot-b", { name: "stolen" })).toBe(false);
    expect(bots.findById(scopeB, "bot-b")?.name).toBe("B");
    expect(() => machines.insert(scopeA, machine("machine-x", "user-b"))).toThrow(/别的用户/);

    const admin = adminScope("admin-1");
    expect(machines.findOwned(admin, "user-a", "machine-b")).toBeUndefined();
    expect(machines.findOwned(admin, "user-b", "machine-b")?.userId).toBe("user-b");
    expect(machines.updateOwned(admin, "user-a", "machine-b", { state: "error" })).toBe(false);
    expect(machines.findById(scopeB, "machine-b")?.state).toBe("stopped");
    expect(machines.list(admin).map((item) => item.id).sort()).toEqual(["machine-a", "machine-b"]);

    const credentials = credentialRepository(db);
    credentials.insertOwned(scopeA, {
      id: "cred-a",
      botId: "bot-a",
      provider: "test",
      externalId: "ext-a",
      secretEnc: "enc-a",
      policyRef: null,
    });
    expect(credentials.findById(scopeB, "cred-a")).toBeUndefined();
    expect(credentials.markRevoked(scopeB, "cred-a", new Date().toISOString())).toBe(false);
    expect(credentials.findById(scopeA, "cred-a")?.revokedAt).toBeNull();
    expect(bots.remove(scopeB, "bot-a")).toBe(false);
    expect(bots.findById(scopeA, "bot-a")?.id).toBe("bot-a");
    db.$client.close();
  });
});
