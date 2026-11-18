import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { installMcpBlock } from "../agent/app-tools.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { machineRepository } from "../db/machines.js";
import { appInstalls, appPublishRequests, appPushTargets, appPushes, appVersions } from "../db/schema.js";
import { userRepository } from "../db/users.js";
import { adminScope, userScope } from "../scope.js";
import {
  createPrivateApp,
  createPush,
  findVisibleApp,
  installForUser,
  listUserCatalog,
  publishCatalogVersion,
  reconcileMachineApps,
  recommendVersion,
  retireVersion,
  runPush,
  searchApps,
  setVisibility,
  updateInstallConfig,
  withdrawPublishRequest,
  type CatalogDeps,
  type CatalogInstaller,
} from "./catalog.js";

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-publish-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => db.$client.close());
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const users = userRepository(db);
  users.insert({ id: "admin", email: "admin@example.com", name: "Admin", status: "active", isAdmin: true });
  users.insert({ id: "alice", email: "alice@example.com", name: "Alice", status: "active", isAdmin: false });
  users.insert({ id: "bob", email: "bob@example.com", name: "Bob", status: "active", isAdmin: false });
  const installed: Array<{ name: string; version: string; userId: string }> = [];
  const jobs: Array<() => Promise<void>> = [];
  const installer: CatalogInstaller = {
    async install(command) {
      installed.push({ name: command.name, version: command.version, userId: command.userId });
    },
    async uninstall() {},
  };
  let tick = 0;
  const deps: CatalogDeps = {
    db,
    key: Buffer.alloc(32, 7),
    installer,
    dataDir: dir,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    schedule(work) {
      jobs.push(work);
    },
  };
  machineRepository(db).insert(userScope("alice"), machine("machine-alice", "alice"));
  machineRepository(db).insert(userScope("bob"), machine("machine-bob", "bob"));
  return { db, deps, installed, jobs };
}

function machine(id: string, userId: string) {
  return {
    id,
    userId,
    state: "running",
    containerId: "c",
    networkId: "n",
    volumeName: `vol-${userId}`,
    imageVersion: "dev",
    spec: { cpu: 1, memMb: 512, diskGb: 10 },
    tokenEnc: "enc",
  };
}

function privateVersion(deps: CatalogDeps, version: string) {
  return createPrivateApp(deps, userScope("alice"), {
    name: "notes",
    version,
    manifestJson: "{}",
    archivePath: `/tmp/notes-${version}.tar.zst`,
    sha256: version === "1.0.0" ? "ab".repeat(32) : "cd".repeat(32),
  });
}

function request(
  db: AppDatabase,
  versionId: string,
  state: "pending" | "approved" | "rejected" | "withdrawn",
  id = `req-${versionId}-${state}`,
) {
  db.insert(appPublishRequests).values({
    id,
    appVersionId: versionId,
    requesterUserId: "alice",
    botId: null,
    taskId: null,
    note: "公开这个版本",
    state,
    reason: state === "rejected" ? "不行" : null,
    reviewerUserId: state === "pending" ? null : "admin",
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: state === "pending" ? null : "2026-01-02T00:00:00.000Z",
  }).run();
  return id;
}

function catalogArgs(version?: string) {
  return {
    catalog: version ? { name: "notes", version } : { name: "notes" },
    reason: "需要这个应用",
  };
}

describe("user app publish visibility", () => {
  it("rejects moderation of unapproved versions without changing the public selection", () => {
    const ctx = boot();
    const first = privateVersion(ctx.deps, "1.0.0");
    const second = privateVersion(ctx.deps, "2.0.0");
    const pending = privateVersion(ctx.deps, "3.0.0");
    request(ctx.db, first.versionId, "approved");
    request(ctx.db, second.versionId, "approved");
    request(ctx.db, pending.versionId, "pending");
    recommendVersion(ctx.deps, adminScope("admin"), first.appId, first.versionId);
    expect(() => recommendVersion(ctx.deps, adminScope("admin"), first.appId, pending.versionId)).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(() => retireVersion(ctx.deps, adminScope("admin"), first.appId, pending.versionId)).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(findVisibleApp(ctx.deps, "bob", "notes")?.version).toBe("1.0.0");
    expect(ctx.db.select().from(appVersions).where(eq(appVersions.id, first.versionId)).get()?.recommended).toBe(true);
    expect(ctx.db.select().from(appVersions).where(eq(appVersions.id, pending.versionId)).get()?.status).toBe("active");
  });

  it("hides an unapproved user version from every other-user catalog, search, install, push, and reconcile path", async () => {
    const ctx = boot();
    const first = privateVersion(ctx.deps, "1.0.0");
    privateVersion(ctx.deps, "2.0.0");

    expect(listUserCatalog(ctx.deps, "bob").map((entry) => entry.name)).not.toContain("notes");
    expect(findVisibleApp(ctx.deps, "bob", "notes")).toBeUndefined();
    expect(findVisibleApp(ctx.deps, "bob", "notes", "1.0.0")).toBeUndefined();
    expect(searchApps(ctx.deps, "bob", "notes")).toEqual([]);
    await expect(installForUser(ctx.deps, "bob", "notes")).rejects.toMatchObject({ statusCode: 404 });
    await expect(installForUser(ctx.deps, "bob", "notes", { version: "2.0.0" })).rejects.toMatchObject({ statusCode: 404 });
    expect(installMcpBlock(ctx.deps, "bob", catalogArgs("1.0.0"))).toBe("找不到");
    expect(ctx.installed).toEqual([]);

    expect(() => createPush(ctx.deps, adminScope("admin"), first.appId, { versionId: first.versionId, userIds: ["bob"] })).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
    expect(ctx.jobs).toEqual([]);
    ctx.db.insert(appPushes).values({
      id: "push-secret",
      appVersionId: first.versionId,
      actorUserId: "admin",
      forced: false,
      wake: false,
      state: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    }).run();
    ctx.db.insert(appPushTargets).values({
      pushId: "push-secret",
      userId: "bob",
      machineId: null,
      installId: null,
      state: "pending",
      error: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).run();
    await runPush(ctx.deps, "push-secret");
    expect(ctx.installed).toEqual([]);

    ctx.db.insert(appInstalls).values({
      id: "sneak",
      machineId: "machine-bob",
      appVersionId: first.versionId,
      forced: false,
      desired: "present",
      state: "installed",
      configJson: "{}",
      error: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).run();
    const reconciled = await reconcileMachineApps(ctx.deps, "machine-bob");
    expect(ctx.installed).toEqual([]);
    expect(reconciled.installIds).not.toContain("sneak");
    await expect(updateInstallConfig(ctx.deps, "bob", "sneak", {})).rejects.toMatchObject({ statusCode: 404 });
    expect(ctx.installed).toEqual([]);

    const owner = findVisibleApp(ctx.deps, "alice", "notes");
    expect(owner?.version).toBe("2.0.0");
    expect(owner?.versions.slice().sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(listUserCatalog(ctx.deps, "alice").find((entry) => entry.name === "notes")).toMatchObject({
      visibility: "private",
      version: { version: "2.0.0" },
    });
    const installed = await installForUser(ctx.deps, "alice", "notes", { version: "1.0.0" });
    expect(installed.version).toBe("1.0.0");
    expect(ctx.installed).toEqual([{ name: "notes", version: "1.0.0", userId: "alice" }]);
    ctx.installed.length = 0;
    const again = await reconcileMachineApps(ctx.deps, "machine-alice");
    expect(again.installIds).toEqual([installed.id]);
    expect(ctx.installed.map((call) => call.userId)).toEqual(["alice"]);
  });

  it("shows other users the recommended approved version, otherwise the newest approved version, without moving an existing install", async () => {
    const ctx = boot();
    const first = privateVersion(ctx.deps, "1.0.0");
    const second = privateVersion(ctx.deps, "2.0.0");
    request(ctx.db, first.versionId, "approved");
    request(ctx.db, second.versionId, "pending");

    expect(listUserCatalog(ctx.deps, "bob").find((entry) => entry.name === "notes")).toMatchObject({
      source: "user",
      version: { version: "1.0.0" },
    });
    expect(findVisibleApp(ctx.deps, "bob", "notes")).toMatchObject({ version: "1.0.0", versions: ["1.0.0"] });
    expect(findVisibleApp(ctx.deps, "bob", "notes", "2.0.0")).toBeUndefined();
    expect(searchApps(ctx.deps, "bob", "notes")).toMatchObject([{ name: "notes", version: "1.0.0" }]);
    expect(installMcpBlock(ctx.deps, "bob", catalogArgs("2.0.0"))).toBe("找不到");
    expect(installMcpBlock(ctx.deps, "bob", catalogArgs("1.0.0"))).toBeUndefined();
    await expect(installForUser(ctx.deps, "bob", "notes", { version: "2.0.0" })).rejects.toMatchObject({ statusCode: 404 });
    expect(ctx.installed).toEqual([]);
    const installed = await installForUser(ctx.deps, "bob", "notes", { version: "1.0.0" });
    expect(installed).toMatchObject({ version: "1.0.0", versionId: first.versionId });

    ctx.db.update(appVersions).set({ recommended: true }).where(eq(appVersions.id, second.versionId)).run();
    expect(listUserCatalog(ctx.deps, "alice").find((entry) => entry.name === "notes")?.version.version).toBe("2.0.0");
    expect(listUserCatalog(ctx.deps, "bob").find((entry) => entry.name === "notes")?.version.version).toBe("1.0.0");

    ctx.db.update(appPublishRequests).set({ state: "approved", reviewerUserId: "admin", decidedAt: "2026-01-03T00:00:00.000Z" }).where(eq(appPublishRequests.id, `req-${second.versionId}-pending`)).run();
    ctx.db.update(appVersions).set({ recommended: false }).where(eq(appVersions.id, second.versionId)).run();
    expect(listUserCatalog(ctx.deps, "bob").find((entry) => entry.name === "notes")?.version.version).toBe("2.0.0");
    expect(findVisibleApp(ctx.deps, "bob", "notes")?.versions.slice().sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(ctx.db.select().from(appInstalls).where(eq(appInstalls.id, installed.id)).get()?.appVersionId).toBe(first.versionId);
    ctx.installed.length = 0;
    await reconcileMachineApps(ctx.deps, "machine-bob");
    expect(ctx.installed).toEqual([{ name: "notes", version: "1.0.0", userId: "bob" }]);

    ctx.db.update(appVersions).set({ recommended: true }).where(eq(appVersions.id, first.versionId)).run();
    expect(listUserCatalog(ctx.deps, "bob").find((entry) => entry.name === "notes")?.version.version).toBe("1.0.0");
    expect(searchApps(ctx.deps, "bob", "notes")[0]?.version).toBe("1.0.0");

    ctx.db.update(appVersions).set({ status: "retired", recommended: false }).where(eq(appVersions.id, second.versionId)).run();
    expect(findVisibleApp(ctx.deps, "bob", "notes")).toMatchObject({ version: "1.0.0", versions: ["1.0.0"] });
    await expect(installForUser(ctx.deps, "bob", "notes", { version: "2.0.0" })).rejects.toMatchObject({ statusCode: 404 });
    ctx.db.update(appVersions).set({ status: "retired", recommended: false }).where(eq(appVersions.id, first.versionId)).run();
    expect(listUserCatalog(ctx.deps, "bob").map((entry) => entry.name)).not.toContain("notes");
    await expect(installForUser(ctx.deps, "bob", "notes")).rejects.toMatchObject({ statusCode: 404 });
    ctx.installed.length = 0;
    const kept = await reconcileMachineApps(ctx.deps, "machine-bob");
    expect(kept.installIds).toEqual([installed.id]);
    expect(ctx.installed).toEqual([{ name: "notes", version: "1.0.0", userId: "bob" }]);

    const weather = publishCatalogVersion(ctx.deps, adminScope("admin"), {
      name: "weather",
      version: "1.0.0",
      manifestJson: "{}",
      archivePath: "/tmp/weather.tar.zst",
      sha256: "ef".repeat(32),
    });
    setVisibility(ctx.deps, adminScope("admin"), weather.appId, { scope: "all" });
    expect(listUserCatalog(ctx.deps, "bob").map((entry) => entry.name)).toEqual(["weather"]);
    expect(() => createPush(ctx.deps, adminScope("admin"), first.appId, { versionId: first.versionId, userIds: ["bob"] })).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it("lets only the owner withdraw a pending request, and a withdrawn version stays private", () => {
    const ctx = boot();
    const first = privateVersion(ctx.deps, "1.0.0");
    const pending = request(ctx.db, first.versionId, "pending");
    const approved = privateVersion(ctx.deps, "2.0.0");
    const kept = request(ctx.db, approved.versionId, "approved");

    expect(() => withdrawPublishRequest(ctx.deps, "bob", pending)).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(withdrawPublishRequest(ctx.deps, "alice", pending)).toMatchObject({ id: pending, state: "withdrawn" });
    expect(ctx.db.select().from(appPublishRequests).where(eq(appPublishRequests.id, pending)).get()).toMatchObject({
      state: "withdrawn",
      decidedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(() => withdrawPublishRequest(ctx.deps, "alice", pending)).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => withdrawPublishRequest(ctx.deps, "alice", kept)).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(listUserCatalog(ctx.deps, "bob").map((entry) => entry.name)).toEqual(["notes"]);
    expect(findVisibleApp(ctx.deps, "bob", "notes", "1.0.0")).toBeUndefined();
    expect(findVisibleApp(ctx.deps, "bob", "notes")?.version).toBe("2.0.0");
  });
});
