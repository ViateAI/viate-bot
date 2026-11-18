import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { authenticated } from "../auth.js";
import { decrypt } from "../crypto.js";
import { botRepository } from "../db/bots.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { machineRepository } from "../db/machines.js";
import { appInstalls, appVersions, appVisibility, auditLog, botApps, events, secrets } from "../db/schema.js";
import { userRepository, type UserRecord } from "../db/users.js";
import type { ResolvedSession } from "../session.js";
import { adminScope, userScope } from "../scope.js";
import {
  catalogSecretName,
  createPrivateApp,
  headersAfterRedirect,
  createPush,
  installForUser,
  installsForModelContext,
  listAdminCatalog,
  listUserCatalog,
  listUserInstalls,
  privateSkillStorage,
  publishCatalogVersion,
  readPush,
  reconcileMachineApps,
  recommendVersion,
  registerCatalogRoutes,
  resolveMcpLaunch,
  retireVersion,
  setVisibility,
  uninstallForUser,
  updateInstallConfig,
  VISIBILITY_SENTINEL,
  type CatalogDeps,
  type CatalogInstaller,
  type CatalogMachineInstall,
} from "./catalog.js";
import { readTar, wrapMcpUrl } from "./archive.js";
import { applyBotProfile } from "../agent/profile-tool.js";

const dirs: string[] = [];
const closers: Array<() => void> = [];
let shaByte = 1;
const SECRET = "super-secret-value-9f3a";
const NEXT = "next-secret-value-9f3b";

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-catalog-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => db.$client.close());
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const key = randomBytes(32);
  const users = userRepository(db);
  const admin = users.insert({ id: "admin", email: "admin@example.com", name: "Admin", status: "active", isAdmin: true });
  const alice = users.insert({ id: "alice", email: "alice@example.com", name: "Alice", status: "active", isAdmin: false });
  users.insert({ id: "bob", email: "bob@example.com", name: "Bob", status: "active", isAdmin: false });
  machineRepository(db).insert(userScope("alice"), {
    id: "machine-alice",
    userId: "alice",
    state: "running",
    containerId: "c",
    networkId: "n",
    volumeName: "vol-alice",
    imageVersion: "dev",
    spec: { cpu: 1, memMb: 512, diskGb: 10 },
    tokenEnc: "enc",
  });
  botRepository(db).insert(userScope("alice"), { id: "bot-alice", name: "Helper", model: "fake" });
  const installed: CatalogMachineInstall[] = [];
  const uninstalled: string[] = [];
  const woken: string[] = [];
  const jobs: Array<() => Promise<void>> = [];
  let waiting: Promise<void> | undefined;
  let resumeWait: (() => void) | undefined;
  const installer: CatalogInstaller = {
    async install(command) {
      installed.push(command);
      if (waiting) await waiting;
    },
    async uninstall(command) {
      uninstalled.push(command.name);
    },
  };
  const deps: CatalogDeps = {
    db,
    key,
    installer,
    schedule(work) {
      jobs.push(work);
    },
    wake(userId) {
      woken.push(userId);
    },
    dataDir: dir,
  };
  return {
    dir,
    db,
    key,
    deps,
    installer,
    admin,
    alice,
    installed,
    uninstalled,
    woken,
    jobs,
    hold() {
      const gate = Promise.withResolvers<void>();
      waiting = gate.promise;
      resumeWait = gate.resolve;
    },
    resume() {
      const finish = resumeWait;
      waiting = undefined;
      resumeWait = undefined;
      finish?.();
    },
  };
}

function publish(deps: CatalogDeps, name: string, version: string, manifestJson = "{}") {
  shaByte += 1;
  return publishCatalogVersion(deps, adminScope("admin"), {
    name,
    version,
    manifestJson,
    archivePath: `/var/lib/viate/apps/${name}/${version}.tar.zst`,
    sha256: shaByte.toString(16).padStart(2, "0").repeat(32),
  });
}

function sessionFor(user: UserRecord): ResolvedSession {
  const now = new Date().toISOString();
  return {
    token: `token-${user.id}`,
    user,
    session: {
      id: `session-${user.id}`,
      userId: user.id,
      tokenHash: "hash",
      csrf: "csrf",
      refreshTokenEnc: "enc",
      expiresAt: now,
      lastSeenAt: now,
      lastValidatedAt: now,
      createdAt: now,
    },
  };
}

async function http(deps: CatalogDeps, holder: { user?: UserRecord }) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    if (holder.user) authenticated.set(request, sessionFor(holder.user));
  });
  registerCatalogRoutes(app, deps);
  await app.ready();
  return app;
}

function persisted(db: AppDatabase): string {
  const chunks: string[] = [];
  for (const row of db.select().from(appInstalls).all()) chunks.push(row.configJson, row.error ?? "");
  for (const row of db.select().from(events).all()) chunks.push(row.type, row.attrsJson);
  for (const row of db.select().from(auditLog).all()) chunks.push(row.action, row.target, row.attrsJson);
  for (const row of db.select().from(secrets).all()) chunks.push(row.name, row.scope, row.valueEnc);
  return chunks.join("\n");
}

describe("catalog", () => {
  it("finishes a user install when machine reconcile re-enters that same install", async () => {
    const ctx = boot();
    createPrivateApp(ctx.deps, userScope("alice"), {
      name: "notes",
      version: "1.0.0",
      manifestJson: "{}",
      archivePath: "/tmp/notes.tar.zst",
      sha256: "cd".repeat(32),
    });
    ctx.deps.installer = {
      async install() {
        await reconcileMachineApps(ctx.deps, "machine-alice");
      },
      async uninstall() {},
    };
    const outcome = await Promise.race([
      installForUser(ctx.deps, "alice", "notes").then(() => "done" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(outcome).toBe("done");
    expect(ctx.db.select().from(appInstalls).all()).toMatchObject([{ state: "installed", error: null }]);
  });

  it("keeps private apps owner-only and scopes catalog visibility with a sentinel user", () => {
    const { db, deps } = boot();
    const notes = createPrivateApp(deps, userScope("alice"), {
      name: "notes",
      version: "1.0.0",
      manifestJson: "{}",
      archivePath: "/var/lib/viate/apps/notes/1.0.0.tar.zst",
      sha256: "ab".repeat(32),
    });
    expect(() => publish(deps, "notes", "1.0.0")).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => setVisibility(deps, adminScope("admin"), notes.appId, { scope: "all" })).toThrow(expect.objectContaining({ statusCode: 404 }));

    const weather = publish(deps, "weather", "1.0.0");
    expect(() => {
      db.insert(appVisibility).values({ appId: weather.appId, scope: "all", userId: VISIBILITY_SENTINEL }).run();
    }).toThrow(/FOREIGN KEY/);
    setVisibility(deps, adminScope("admin"), weather.appId, { scope: "all" });
    expect(db.select().from(appVisibility).where(eq(appVisibility.appId, weather.appId)).all()).toEqual([
      { appId: weather.appId, scope: "all", userId: VISIBILITY_SENTINEL },
    ]);
    expect(userRepository(db).findById(VISIBILITY_SENTINEL)).toMatchObject({ status: "disabled", isAdmin: false });
    expect(listUserCatalog(deps, "alice").map((entry) => entry.name).sort()).toEqual(["notes", "weather"]);
    expect(listUserCatalog(deps, "alice").find((entry) => entry.name === "notes")).toMatchObject({ visibility: "private" });
    expect(listUserCatalog(deps, "bob").map((entry) => entry.name)).toEqual(["weather"]);
    expect(listUserCatalog(deps, "admin").map((entry) => entry.name)).toEqual(["weather"]);
    expect(listAdminCatalog(deps, adminScope("admin")).map((entry) => entry.name)).toEqual(["weather"]);

    setVisibility(deps, adminScope("admin"), weather.appId, { scope: "user", userIds: ["alice", "alice"] });
    expect(db.select().from(appVisibility).where(eq(appVisibility.appId, weather.appId)).all()).toEqual([
      { appId: weather.appId, scope: "user", userId: "alice" },
    ]);
    expect(listUserCatalog(deps, "bob").map((entry) => entry.name)).toEqual([]);
    expect(listAdminCatalog(deps, adminScope("admin"))[0]).toMatchObject({ visibility: "user", userIds: ["alice"] });

    setVisibility(deps, adminScope("admin"), weather.appId, { scope: "push" });
    expect(db.select().from(appVisibility).where(eq(appVisibility.appId, weather.appId)).all()).toEqual([
      { appId: weather.appId, scope: "push", userId: VISIBILITY_SENTINEL },
    ]);
    expect(listUserCatalog(deps, "alice").map((entry) => entry.name)).toEqual(["notes"]);
  });

  it("keeps a single recommended version and refuses retired installs", async () => {
    const { db, deps, jobs } = boot();
    const first = publish(deps, "pager", "1.0.0");
    const second = publish(deps, "pager", "2.0.0");
    setVisibility(deps, adminScope("admin"), first.appId, { scope: "all" });
    recommendVersion(deps, adminScope("admin"), first.appId, first.versionId);
    recommendVersion(deps, adminScope("admin"), first.appId, second.versionId);
    expect(db.select().from(appVersions).where(eq(appVersions.recommended, true)).all().map((row) => row.version)).toEqual(["2.0.0"]);
    expect(listUserCatalog(deps, "alice").find((entry) => entry.name === "pager")?.version).toMatchObject({
      version: "2.0.0",
      recommended: true,
    });

    retireVersion(deps, adminScope("admin"), first.appId, second.versionId);
    expect(db.select().from(appVersions).where(eq(appVersions.recommended, true)).all()).toEqual([]);
    expect(() => recommendVersion(deps, adminScope("admin"), first.appId, second.versionId)).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(listUserCatalog(deps, "alice").find((entry) => entry.name === "pager")?.version.version).toBe("1.0.0");
    await expect(installForUser(deps, "alice", "pager", { version: "2.0.0" })).rejects.toMatchObject({ statusCode: 409 });
    retireVersion(deps, adminScope("admin"), first.appId, first.versionId);
    await expect(installForUser(deps, "alice", "pager")).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      Promise.resolve().then(() => createPush(deps, adminScope("admin"), first.appId, { versionId: second.versionId, userIds: ["alice"] })),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(jobs).toEqual([]);
  });

  it("installs once, uninstalls unforced apps, and reinstalls only desired present rows", async () => {
    const ctx = boot();
    const alpha = publish(ctx.deps, "alpha", "1.0.0");
    const betaApp = publish(ctx.deps, "beta", "1.0.0");
    setVisibility(ctx.deps, adminScope("admin"), alpha.appId, { scope: "all" });
    setVisibility(ctx.deps, adminScope("admin"), betaApp.appId, { scope: "all" });

    ctx.hold();
    const first = installForUser(ctx.deps, "alice", "alpha");
    const second = installForUser(ctx.deps, "alice", "alpha");
    expect(ctx.installed).toHaveLength(1);
    ctx.resume();
    const [left, right] = await Promise.all([first, second]);
    expect(left.id).toBe(right.id);
    expect(ctx.installed).toHaveLength(1);
    expect(ctx.db.select().from(appInstalls).all()).toHaveLength(1);
    expect(ctx.db.select().from(botApps).all().map((row) => row.appInstallId)).toEqual([left.id]);

    const beta = await installForUser(ctx.deps, "alice", "beta");
    await uninstallForUser(ctx.deps, "alice", beta.id);
    expect(ctx.uninstalled).toEqual(["beta"]);
    expect(listUserInstalls(ctx.deps, "alice").find((row) => row.id === beta.id)).toMatchObject({ desired: "absent", state: "removed" });
    expect(ctx.db.select().from(botApps).all().map((row) => row.appInstallId)).toEqual([left.id]);
    await expect(uninstallForUser(ctx.deps, "bob", left.id)).rejects.toMatchObject({ statusCode: 404 });

    const reconciled = await reconcileMachineApps(ctx.deps, "machine-alice");
    expect(reconciled).toEqual({ installIds: [left.id], failedIds: [] });
    expect(ctx.installed.map((call) => call.name)).toEqual(["alpha", "beta", "alpha"]);
    expect(listUserInstalls(ctx.deps, "alice").find((row) => row.id === beta.id)?.desired).toBe("absent");
  });

  it("runs a push asynchronously and blocks user uninstall when it is forced", async () => {
    const ctx = boot();
    const relay = publish(ctx.deps, "relay", "1.0.0");
    setVisibility(ctx.deps, adminScope("admin"), relay.appId, { scope: "push" });
    expect(listUserCatalog(ctx.deps, "alice").map((entry) => entry.name)).not.toContain("relay");
    await expect(installForUser(ctx.deps, "alice", "relay")).rejects.toMatchObject({ statusCode: 404 });

    const push = createPush(ctx.deps, adminScope("admin"), relay.appId, {
      versionId: relay.versionId,
      userIds: ["alice", "bob", "alice"],
      forced: true,
      wake: true,
    });
    expect(push.state).toBe("pending");
    expect(push.targets.map((target) => target.userId).sort()).toEqual(["alice", "bob"]);
    expect(push.targets.every((target) => target.state === "pending")).toBe(true);
    const job = ctx.jobs[0];
    if (!job) throw new Error("push was not scheduled");
    expect(readPush(ctx.deps, adminScope("admin"), push.id).state).toBe("pending");
    await job();

    const done = readPush(ctx.deps, adminScope("admin"), push.id);
    expect(done.state).toBe("failed");
    expect(done.targets.find((target) => target.userId === "alice")).toMatchObject({ state: "installed", error: null });
    expect(done.targets.find((target) => target.userId === "bob")).toMatchObject({ state: "failed", error: "no_machine" });
    expect(ctx.woken.sort()).toEqual(["alice", "bob"]);
    const installed = listUserInstalls(ctx.deps, "alice");
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({ forced: true, desired: "present", state: "installed", name: "relay" });
    await expect(uninstallForUser(ctx.deps, "alice", installed[0]!.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(ctx.uninstalled).toEqual([]);
    expect(listUserInstalls(ctx.deps, "alice")[0]).toMatchObject({ desired: "present", forced: true });
    expect(listUserCatalog(ctx.deps, "alice").map((entry) => entry.name)).not.toContain("relay");
  });

  it("removes disabled applications from a bot's model tools without affecting other bots", async () => {
    const ctx = boot();
    const pkg = publish(ctx.deps, "switchable", "1.0.0");
    setVisibility(ctx.deps, adminScope("admin"), pkg.appId, { scope: "all" });
    await installForUser(ctx.deps, "alice", "switchable");
    botRepository(ctx.db).insert(userScope("alice"), { id: "other-alice", name: "Other", model: "fake" });
    await applyBotProfile({ db: ctx.db, dataDir: ctx.dir, userId: "alice", botId: "bot-alice", taskId: "task", allowModel: () => true, readFile: async () => { throw new Error("not needed"); } }, { enabledAppIds: [] });
    expect(installsForModelContext(ctx.deps, "alice", "bot-alice")).toEqual([]);
    expect(installsForModelContext(ctx.deps, "alice", "other-alice").map((app) => app.name)).toEqual(["switchable"]);
  });

  it("stores secret config as ciphertext and keeps values out of rows, events, and http", async () => {
    const ctx = boot();
    const manifest = JSON.stringify({ config: { TOKEN: { secret: true }, REGION: { secret: false } } });
    const vault = publish(ctx.deps, "vault", "1.0.0", manifest);
    setVisibility(ctx.deps, adminScope("admin"), vault.appId, { scope: "all" });
    const holder: { user?: UserRecord } = { user: ctx.alice };
    const app = await http(ctx.deps, holder);
    const installed = await installForUser(ctx.deps, "alice", "vault", {
      config: { TOKEN: SECRET, REGION: `edge-${SECRET}` },
    });
    const row = ctx.db.select().from(secrets).where(eq(secrets.name, catalogSecretName(installed.id, "TOKEN"))).get();
    if (!row) throw new Error("missing secret row");
    expect(row.scope).toBe("app");
    expect(row.userId).toBe("alice");
    expect(decrypt(ctx.key, row.valueEnc)).toBe(SECRET);
    expect(JSON.parse(ctx.db.select().from(appInstalls).where(eq(appInstalls.id, installed.id)).get()?.configJson ?? "{}")).toEqual({
      REGION: "edge-{{secret:TOKEN}}",
      TOKEN: { secret: true },
    });
    expect(resolveMcpLaunch(ctx.deps, "alice", "vault").env).toEqual({ REGION: "edge-{{secret:TOKEN}}", TOKEN: SECRET });
    expect(JSON.stringify(ctx.installed)).not.toContain(SECRET);
    expect(() => resolveMcpLaunch(ctx.deps, "bob", "vault")).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(JSON.stringify(installsForModelContext(ctx.deps, "alice"))).not.toContain(SECRET);
    const listed = await app.inject({ method: "GET", url: "/api/apps/installs" });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(SECRET);
    expect(persisted(ctx.db)).not.toContain(SECRET);

    await updateInstallConfig(ctx.deps, "alice", installed.id, {
      TOKEN: { secret: true, value: NEXT },
      REGION: "us",
    });
    expect(decrypt(ctx.key, ctx.db.select().from(secrets).where(eq(secrets.name, catalogSecretName(installed.id, "TOKEN"))).get()?.valueEnc ?? "")).toBe(NEXT);
    expect(persisted(ctx.db)).not.toContain(SECRET);
    expect(persisted(ctx.db)).not.toContain(NEXT);

    await updateInstallConfig(ctx.deps, "alice", installed.id, { TOKEN: { secret: true }, REGION: "us" });
    expect(decrypt(ctx.key, ctx.db.select().from(secrets).where(eq(secrets.name, catalogSecretName(installed.id, "TOKEN"))).get()?.valueEnc ?? "")).toBe(NEXT);

    ctx.deps.installer.install = async () => {
      throw new Error(SECRET);
    };
    const failed = await app.inject({
      method: "PUT",
      url: `/api/apps/installs/${installed.id}/config`,
      headers: { "content-type": "application/json" },
      payload: { config: { TOKEN: { secret: true }, REGION: "us" } },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: "安装失败" });
    expect(failed.body).not.toContain(SECRET);
    expect(ctx.db.select().from(appInstalls).where(eq(appInstalls.id, installed.id)).get()?.error).toBe("install_failed");
    expect(persisted(ctx.db)).not.toContain(SECRET);

    ctx.deps.installer.install = async (command) => {
      ctx.installed.push(command);
    };
    await updateInstallConfig(ctx.deps, "alice", installed.id, { REGION: "eu" });
    expect(ctx.db.select().from(secrets).all()).toEqual([]);
    expect(JSON.parse(ctx.db.select().from(appInstalls).where(eq(appInstalls.id, installed.id)).get()?.configJson ?? "{}")).toEqual({
      REGION: "eu",
    });
    await app.close();
  });

  it("hides admin app routes from non-admins and rejects forced uninstall over http", async () => {
    const ctx = boot();
    const signal = publish(ctx.deps, "signal", "1.0.0");
    setVisibility(ctx.deps, adminScope("admin"), signal.appId, { scope: "all" });
    const holder: { user?: UserRecord } = {};
    const app = await http(ctx.deps, holder);
    const userRoutes = [
      ["GET", "/api/apps"],
      ["GET", "/api/apps/installs"],
      ["POST", "/api/apps/signal/install"],
      ["POST", "/api/apps/installs/missing/uninstall"],
      ["PUT", "/api/apps/installs/missing/config"],
      ["POST", "/api/apps/private/upload"],
      ["POST", "/api/apps/private"],
    ] as const;
    for (const [method, url] of userRoutes) {
      const response = await app.inject({
        method,
        url,
        ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, payload: {} }),
      });
      expect(response.statusCode, url).toBe(401);
    }
    const adminUrls = [
      ["GET", "/api/admin/apps"],
      ["PUT", `/api/admin/apps/${signal.appId}/visibility`],
      ["POST", `/api/admin/apps/${signal.appId}/versions/${signal.versionId}/recommend`],
      ["POST", `/api/admin/apps/${signal.appId}/versions/${signal.versionId}/retire`],
      ["POST", `/api/admin/apps/${signal.appId}/push`],
      ["GET", "/api/admin/apps/pushes/missing"],
      ["POST", "/api/admin/apps/upload"],
      ["POST", "/api/admin/apps/ingest"],
    ] as const;
    for (const [method, url] of adminUrls) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `anon ${url}`).toBe(404);
    }

    holder.user = ctx.alice;
    for (const [method, url] of adminUrls) {
      const response = await app.inject({
        method,
        url,
        ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, payload: { scope: "push", versionId: signal.versionId, userIds: ["alice"], forced: true } }),
      });
      expect(response.statusCode, `user ${url}`).toBe(404);
    }

    const pushed = createPush(ctx.deps, adminScope("admin"), signal.appId, {
      versionId: signal.versionId,
      userIds: ["alice"],
      forced: true,
    });
    const job = ctx.jobs[0];
    if (!job) throw new Error("push was not scheduled");
    await job();
    const install = listUserInstalls(ctx.deps, "alice")[0];
    if (!install) throw new Error("missing install");
    const denied = await app.inject({
      method: "POST",
      url: `/api/apps/installs/${install.id}/uninstall`,
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "管理员推送的应用不能卸载" });
    expect(ctx.uninstalled).toEqual([]);
    expect(listUserInstalls(ctx.deps, "alice")[0]).toMatchObject({ forced: true, desired: "present" });

    holder.user = ctx.admin;
    const listed = await app.inject({ method: "GET", url: "/api/admin/apps" });
    expect(listed.statusCode).toBe(200);
    const recommended = await app.inject({
      method: "POST",
      url: `/api/admin/apps/${signal.appId}/versions/${signal.versionId}/recommend`,
    });
    expect(recommended.statusCode).toBe(200);
    expect(ctx.db.select().from(appVersions).where(eq(appVersions.recommended, true)).all()).toHaveLength(1);
    expect(pushed.forced).toBe(true);
    await app.close();
  });

  it("stores an admin upload and a private MCP url, and does not fetch a rejected git url", async () => {
    const ctx = boot();
    const holder: { user?: UserRecord } = {};
    const app = await http(ctx.deps, holder);
    const packed = wrapMcpUrl("weather", "https://example.com/mcp");
    holder.user = ctx.alice;
    const denied = await app.inject({
      method: "POST",
      url: "/api/admin/apps/upload?kind=archive&version=1.2.3&filename=weather.tar.zst",
      headers: { "content-type": "application/octet-stream" },
      payload: packed.archive,
    });
    expect(denied.statusCode).toBe(404);
    expect(existsSync(join(ctx.dir, "apps"))).toBe(false);

    holder.user = ctx.admin;
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/admin/apps/upload?kind=archive&version=1.2.3&filename=weather.tar.zst",
      headers: { "content-type": "application/octet-stream" },
      payload: packed.archive,
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({ name: "weather", version: "1.2.3", warnings: [] });
    const stored = ctx.db.select().from(appVersions).where(eq(appVersions.version, "1.2.3")).get();
    if (!stored) throw new Error("missing uploaded version");
    expect(stored.archivePath).toBe(join(ctx.dir, "apps", stored.appId, "1.2.3.tar.zst"));
    expect(stored.sha256).toBe(createHash("sha256").update(readFileSync(stored.archivePath)).digest("hex"));
    expect(ctx.db.select().from(auditLog).where(eq(auditLog.action, "app.publish")).all().map((entry) => entry.target)).toEqual([stored.appId]);

    const arbitraryVersion = await app.inject({
      method: "POST",
      url: "/api/admin/apps/upload?kind=archive&version=1.0.0%2Bbuild",
      headers: { "content-type": "application/octet-stream" },
      payload: packed.archive,
    });
    expect(arbitraryVersion.statusCode).toBe(201);
    const arbitrary = ctx.db.select().from(appVersions).where(eq(appVersions.version, "1.0.0+build")).get();
    expect(arbitrary?.archivePath).toBe(join(ctx.dir, "apps", stored.appId, `${packed.sha256}.tar.zst`));

    const ingested = await app.inject({
      method: "POST",
      url: "/api/admin/apps/ingest",
      headers: { "content-type": "application/json" },
      payload: { kind: "git", gitUrl: "http://example.com/app.git" },
    });
    expect(ingested.statusCode).toBe(400);
    expect(ingested.json()).toEqual({ error: "无法获取应用包" });
    expect(ingested.body).not.toContain("example.com");
    expect(ctx.db.select().from(appVersions).all()).toHaveLength(2);

    holder.user = ctx.alice;
    const created = await app.inject({
      method: "POST",
      url: "/api/apps/private",
      headers: { "content-type": "application/json" },
      payload: { name: "notes", version: "0.1.0", mcpUrl: "https://example.com/mcp" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "notes", version: "0.1.0" });
    expect(listUserCatalog(ctx.deps, "alice").find((entry) => entry.name === "notes")).toMatchObject({ visibility: "private", source: "user" });
    expect(listUserCatalog(ctx.deps, "bob").map((entry) => entry.name)).not.toContain("notes");
    expect(listAdminCatalog(ctx.deps, adminScope("admin")).map((entry) => entry.name)).not.toContain("notes");
    const notes = ctx.db.select().from(appVersions).where(eq(appVersions.version, "0.1.0")).get();
    if (!notes) throw new Error("missing private version");
    expect(notes.archivePath).toBe(join(ctx.dir, "apps", notes.appId, "0.1.0.tar.zst"));
    expect(readFileSync(notes.archivePath).length).toBeGreaterThan(0);
    await app.close();
  });

  it("treats an archive config list as secret declarations", async () => {
    const ctx = boot();
    const vault = publish(ctx.deps, "vault", "1.0.0", JSON.stringify({
      extensions: { "ai.viate.bot": { config: [{ key: "TOKEN", secret: true }] } },
    }));
    setVisibility(ctx.deps, adminScope("admin"), vault.appId, { scope: "all" });
    const installed = await installForUser(ctx.deps, "alice", "vault", { config: { TOKEN: SECRET } });
    const row = ctx.db.select().from(secrets).where(eq(secrets.name, catalogSecretName(installed.id, "TOKEN"))).get();
    if (!row) throw new Error("missing secret row");
    expect(row.scope).toBe("app");
    expect(row.userId).toBe("alice");
    expect(decrypt(ctx.key, row.valueEnc)).toBe(SECRET);
    expect(persisted(ctx.db)).not.toContain(SECRET);
    expect(resolveMcpLaunch(ctx.deps, "alice", "vault").env).toEqual({ TOKEN: SECRET });
    expect(resolveMcpLaunch(ctx.deps, "alice", "vault").headers).toEqual({});
  });

  it("injects declared env and headers without rewriting placeholders", async () => {
    const ctx = boot();
    const archivePath = "/var/lib/viate/apps/relay/1.0.0.tar.zst";
    const relay = publishCatalogVersion(ctx.deps, adminScope("admin"), {
      name: "relay",
      version: "1.0.0",
      manifestJson: JSON.stringify({
        extensions: {
          "ai.viate.bot": {
            config: [
              { key: "API_TOKEN", secret: true, env: "API_TOKEN", header: "Authorization" },
              { key: "HOOK", secret: true, header: "X-Hook" },
              { key: "REGION", secret: false },
              { key: "NOTE", secret: false },
            ],
          },
        },
      }),
      archivePath,
      sha256: "ab".repeat(32),
    });
    setVisibility(ctx.deps, adminScope("admin"), relay.appId, { scope: "all" });
    const installed = await installForUser(ctx.deps, "alice", "relay", {
      config: { API_TOKEN: SECRET, HOOK: SECRET, REGION: "eu", NOTE: "${config.API_TOKEN}" },
    });
    expect(ctx.installed[0]).toMatchObject({ archivePath });
    expect(JSON.stringify(ctx.installed)).not.toContain(SECRET);
    expect(resolveMcpLaunch(ctx.deps, "alice", "relay")).toMatchObject({
      env: { API_TOKEN: SECRET, REGION: "eu", NOTE: "${config.API_TOKEN}" },
      headers: { Authorization: SECRET, "X-Hook": SECRET },
    });
    expect(resolveMcpLaunch(ctx.deps, "alice", "relay").env).not.toHaveProperty("HOOK");
    expect(JSON.parse(ctx.db.select().from(appInstalls).where(eq(appInstalls.id, installed.id)).get()?.configJson ?? "{}")).toEqual({
      API_TOKEN: { secret: true },
      HOOK: { secret: true },
      REGION: "eu",
      NOTE: "${config.API_TOKEN}",
    });
    expect(JSON.stringify(installsForModelContext(ctx.deps, "alice"))).not.toContain(SECRET);
    expect(persisted(ctx.db)).not.toContain(SECRET);

    const same = { Authorization: SECRET, "X-Trace": "keep" };
    expect(headersAfterRedirect("https://mcp.example/rpc", "https://mcp.example/v2", same, ["Authorization"])).toEqual(same);
    expect(headersAfterRedirect("https://mcp.example/rpc", "https://mcp.example:443/rpc", same, ["X-Hook"])).toEqual(same);
    expect(headersAfterRedirect(
      "https://mcp.example/rpc",
      "https://other.example/rpc",
      { Authorization: SECRET, "X-Hook": SECRET, "X-Trace": "keep" },
      ["X-Hook"],
    )).toEqual({ "X-Trace": "keep" });
    expect(headersAfterRedirect(
      "https://mcp.example/rpc",
      "http://mcp.example/rpc",
      { Authorization: SECRET, "X-Trace": "keep" },
      [],
    )).toEqual({ "X-Trace": "keep" });
    expect(headersAfterRedirect(
      "https://mcp.example/rpc",
      "https://mcp.example:8443/rpc",
      { Authorization: SECRET },
      [],
    )).toEqual({});
  });

  it("stores a masked private skill as an owned archive, not the machine path", async () => {
    const ctx = boot();
    const storage = privateSkillStorage(ctx.deps, "alice");
    const machinePath = "/home/bot/.viate/skills/demo-skill/SKILL.md";
    const markdown = "---\nname: demo-skill\ndescription: summarize a note\n---\nUse {{secret:API}} and [redacted].\n";
    const saved = await storage.saveUserSkill({
      ownerUserId: "alice",
      name: "demo-skill",
      version: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      description: "summarize a note",
      skillMarkdown: markdown,
      manifestJson: JSON.stringify({ name: "demo-skill", description: "summarize a note" }),
      archivePath: machinePath,
      sha256: "ab".repeat(32),
    });
    expect(saved).toMatchObject({ name: "demo-skill", source: "user", ownerUserId: "alice" });
    const row = ctx.db.select().from(appVersions).where(eq(appVersions.id, saved.versionId)).get();
    expect(row?.archivePath.startsWith(ctx.dir)).toBe(true);
    expect(row?.archivePath).not.toContain("/home/bot");
    expect(row?.archivePath).not.toBe(machinePath);
    expect(row?.sha256).not.toBe("ab".repeat(32));
    expect(existsSync(row?.archivePath ?? "")).toBe(true);
    const packed = readTar(readFileSync(row?.archivePath ?? ""));
    expect(packed.map((file) => file.path).sort()).toEqual(["plugin.json", "skills/demo-skill/SKILL.md"]);
    expect(packed.find((file) => file.path.endsWith("SKILL.md"))?.data.toString("utf8")).toBe(markdown);
    expect(listUserCatalog(ctx.deps, "alice").map((item) => item.name)).toContain("demo-skill");
    expect(listUserCatalog(ctx.deps, "bob").map((item) => item.name)).not.toContain("demo-skill");
    expect(listAdminCatalog(ctx.deps, adminScope("admin")).map((item) => item.name)).not.toContain("demo-skill");
    await expect(storage.saveUserSkill({
      ownerUserId: "bob",
      name: "other-skill",
      version: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      description: "no",
      skillMarkdown: "---\nname: other-skill\ndescription: no\n---\n",
      manifestJson: "{}",
      archivePath: machinePath,
      sha256: "cd".repeat(32),
    })).rejects.toThrow(/找不到/);
    await expect(storage.saveUserSkill({
      ownerUserId: "alice",
      name: "broken",
      version: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      description: "no",
      skillMarkdown: "no frontmatter\n",
      manifestJson: "{}",
      archivePath: machinePath,
      sha256: "ef".repeat(32),
    })).rejects.toThrow(/技能无效/);
  });

  it("saves app routine templates as unconfirmed drafts and skips a bad one", async () => {
    const ctx = boot();
    const published = publish(ctx.deps, "planner", "1.0.0");
    setVisibility(ctx.deps, adminScope("admin"), published.appId, { scope: "all" });
    ctx.deps.installer = {
      async install(command) {
        ctx.installed.push(command);
        return {
          routines: [
            { cron: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "整理收件箱" },
            { cron: "not cron", timezone: "Not/AZone", prompt: "不要创建" },
          ],
        };
      },
      uninstall: ctx.deps.installer.uninstall,
    };
    await installForUser(ctx.deps, "alice", "planner");
    const rows = ctx.db.$client.prepare("select cron,timezone,prompt,state,enabled from routines").all() as Array<{ cron: string; timezone: string; prompt: string; state: string; enabled: number }>;
    expect(rows).toEqual([{ cron: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "整理收件箱", state: "draft", enabled: 0 }]);
    await reconcileMachineApps(ctx.deps, "machine-alice");
    expect(ctx.db.$client.prepare("select count(*) as n from routines").get()).toEqual({ n: 1 });
  });
});
