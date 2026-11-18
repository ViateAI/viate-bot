import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { authenticated } from "../auth.js";
import { openDatabase } from "../db/index.js";
import { appPublishRequests, appVersions } from "../db/schema.js";
import { userRepository, type UserRecord } from "../db/users.js";
import type { ResolvedSession } from "../session.js";
import { validatePackage, type PackageFile } from "./archive.js";
import { listAdminCatalog, listUserCatalog, publishValidatedPackage, registerCatalogRoutes, type CatalogDeps } from "./catalog.js";
import { installForUser } from "./catalog.js";
import { requestAppPublish } from "./publish-request.js";
import { adminScope } from "../scope.js";
import { decidePublishReview, publishReviewDetail } from "./publish-review.js";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const CAP = 256 * 1024;
const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-review-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => db.$client.close());
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const users = userRepository(db);
  const alice = users.insert({ id: "alice", email: "alice@example.com", name: "Alice", status: "active", isAdmin: false });
  const bob = users.insert({ id: "bob", email: "bob@example.com", name: "Bob", status: "active", isAdmin: false });
  const carol = users.insert({ id: "carol", email: "carol@example.com", name: "Carol", status: "active", isAdmin: true });
  db.$client.exec("insert into bots(id,user_id,name,model,created_at,updated_at) values ('bot','alice','helper','model','now','now');");
  db.$client.exec("insert into tasks(id,bot_id,state,trigger) values ('task','bot','running','user');");
  const deps: CatalogDeps = {
    db,
    key: Buffer.alloc(32, 4),
    dataDir: dir,
    installer: { async install() {}, async uninstall() {} },
  };
  return { db, deps, alice, bob, carol };
}

function plugin(name: string): PackageFile {
  return {
    path: "plugin.json",
    data: Buffer.from(JSON.stringify({
      $schema: PLUGIN,
      name,
      extensions: {
        "ai.viate.bot": {
          config: [{ key: "TOKEN", secret: true, description: "token" }],
          routines: [{ cron: "0 9 * * *", timezone: "UTC", prompt: "<b>ping</b>" }],
        },
      },
    })),
  };
}

function skill(name: string): PackageFile {
  return { path: `skills/${name}/SKILL.md`, data: Buffer.from(`---\nname: ${name}\ndescription: private notes\n---\nhello\n`) };
}

function mcp(): PackageFile {
  return {
    path: "mcp.json",
    data: Buffer.from(JSON.stringify({
      $schema: MCP,
      mcpServers: { notes: { type: "stdio", command: "./bin/mcp", args: ["--serve"] } },
    })),
  };
}

async function publish(deps: CatalogDeps, version: string, extra: PackageFile[]) {
  const pkg = validatePackage([plugin("notes"), skill("notes"), mcp(), ...extra]);
  return publishValidatedPackage(deps, "alice", pkg, { version, privateUserId: "alice" });
}

describe("admin app publish review", () => {
  it("rolls back the decision if its audit record cannot be written", async () => {
    const ctx = boot();
    await publish(ctx.deps, "1.0.0", []);
    const pending = requestAppPublish(ctx.deps, "alice", { name: "notes", version: "1.0.0", note: "publish" });
    ctx.db.$client.exec("create trigger reject_review_audit before insert on audit_log when NEW.action='app.publish_review' begin select raise(abort, 'audit unavailable'); end");
    expect(() => decidePublishReview(ctx.deps, adminScope("carol"), pending.id, { decision: "approve" })).toThrow("audit unavailable");
    expect(ctx.db.select().from(appPublishRequests).get()?.state).toBe("pending");
    expect(listUserCatalog(ctx.deps, "bob")).toEqual([]);
  });

  it("refuses to display or approve bytes that no longer match the submitted version", async () => {
    const ctx = boot();
    await publish(ctx.deps, "1.0.0", []);
    const pending = requestAppPublish(ctx.deps, "alice", { name: "notes", version: "1.0.0", note: "publish" });
    const version = ctx.db.select().from(appVersions).get()!;
    writeFileSync(version.archivePath, validatePackage([plugin("notes"), skill("notes"), { path: "changed.txt", data: Buffer.from("changed") }]).archive);
    expect(() => publishReviewDetail(ctx.deps, adminScope("carol"), pending.id)).toThrow(/校验/);
    expect(() => decidePublishReview(ctx.deps, adminScope("carol"), pending.id, { decision: "approve" })).toThrow(/校验/);
    expect(ctx.db.select().from(appPublishRequests).get()?.state).toBe("pending");
    expect(listUserCatalog(ctx.deps, "bob")).toEqual([]);
  });

  it("shows the pending package as text, approves without changing bytes, and retires it without opening a push", async () => {
    const ctx = boot();
    await publish(ctx.deps, "1.0.0", [
      { path: "a.txt", data: Buffer.from("old") },
      { path: "gone.txt", data: Buffer.from("x") },
    ]);
    await publish(ctx.deps, "2.0.0", [
      { path: "a.txt", data: Buffer.from("new") },
      { path: "added.txt", data: Buffer.from("y") },
      { path: "bin/run", data: Buffer.from("#!/bin/sh\n"), executable: true },
      { path: "assets/blob", data: Buffer.from([0, 1, 2, 3]) },
      { path: "notes/big.txt", data: Buffer.alloc(CAP + 10, 0x61) },
    ]);
    const shaBefore = ctx.db.select().from(appVersions).where(eq(appVersions.version, "2.0.0")).get()?.sha256;
    requestAppPublish(ctx.deps, "alice", { name: "notes", version: "1.0.0", note: "first", botId: "bot", taskId: "task" });
    const firstId = ctx.db.select().from(appPublishRequests).all().find((row) => row.note === "first")?.id;
    if (!firstId) throw new Error("missing first request");
    ctx.db.update(appPublishRequests).set({ state: "approved", reviewerUserId: "carol" }).where(eq(appPublishRequests.id, firstId)).run();
    const pending = requestAppPublish(ctx.deps, "alice", {
      name: "notes",
      version: "2.0.0",
      note: "please <b>publish</b>",
      botId: "bot",
      taskId: "task",
    });

    const holder: { user?: UserRecord } = { user: ctx.bob };
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (request) => {
      if (holder.user) authenticated.set(request, sessionFor(holder.user));
    });
    registerCatalogRoutes(app, ctx.deps);
    await app.ready();
    closers.push(() => { void app.close(); });

    const hidden = await app.inject({ method: "GET", url: "/api/admin/app-reviews" });
    expect(hidden.statusCode).toBe(404);
    for (const url of [`/api/admin/app-reviews/${pending.id}`, `/api/admin/app-reviews/${pending.id}/files?path=plugin.json`]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "POST", url: `/api/admin/app-reviews/${pending.id}/approve` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/admin/app-reviews/${pending.id}/reject`, payload: { reason: "no" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/apps/notes/install", payload: { version: "2.0.0" } })).statusCode).toBe(404);
    holder.user = ctx.carol;
    const listed = await app.inject({ method: "GET", url: "/api/admin/app-reviews" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      pendingCount: 1,
      requests: expect.arrayContaining([expect.objectContaining({
        id: pending.id,
        name: "notes",
        version: "2.0.0",
        requester: "Alice",
        bot: "helper",
        state: "pending",
      })]),
    });
    const row = (listed.json() as { requests: Array<{ id: string; kinds: string[]; createdAt: string }> }).requests.find((item) => item.id === pending.id);
    expect(row?.kinds).toEqual(expect.arrayContaining(["技能", "本地 MCP", "定时任务"]));
    expect(row?.createdAt).toEqual(expect.any(String));

    const detail = await app.inject({ method: "GET", url: `/api/admin/app-reviews/${pending.id}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      note: string;
      sha256: string;
      manifest: string;
      files: Array<{ path: string; size: number; executable: boolean }>;
      mcp: Array<{ name: string; command?: string; args?: string[] }>;
      config: Array<{ key: string; secret: boolean }>;
      routines: Array<{ cron: string; timezone: string; prompt: string }>;
      diff: { added: string[]; removed: string[]; modified: string[] };
    };
    expect(body.note).toBe("please <b>publish</b>");
    expect(body.sha256).toBe(shaBefore);
    expect(body.manifest).toContain("notes");
    expect(body.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "bin/run", executable: true, size: Buffer.from("#!/bin/sh\n").length }),
      expect.objectContaining({ path: "assets/blob", executable: false, size: 4 }),
    ]));
    expect(body.mcp).toEqual([expect.objectContaining({ name: "notes", command: "./bin/mcp", args: ["--serve"] })]);
    expect(body.config).toEqual([expect.objectContaining({ key: "TOKEN", secret: true })]);
    expect(body.routines).toEqual([{ cron: "0 9 * * *", timezone: "UTC", prompt: "<b>ping</b>" }]);
    expect(body.diff).toEqual({
      added: ["added.txt", "assets/blob", "bin/run", "notes/big.txt"],
      removed: ["gone.txt"],
      modified: ["a.txt"],
    });

    const text = await app.inject({ method: "GET", url: `/api/admin/app-reviews/${pending.id}/files?path=${encodeURIComponent("notes/big.txt")}` });
    expect(text.statusCode).toBe(200);
    const textBody = text.json() as { binary: boolean; text: string; truncated: boolean; sha256: string; size: number };
    expect(textBody.binary).toBe(false);
    expect(textBody.truncated).toBe(true);
    expect(textBody.text).toHaveLength(CAP);
    expect(textBody.size).toBe(CAP + 10);
    expect(textBody.sha256).toMatch(/^[a-f0-9]{64}$/);
    const binary = await app.inject({ method: "GET", url: `/api/admin/app-reviews/${pending.id}/files?path=${encodeURIComponent("assets/blob")}` });
    const binaryBody = binary.json() as { binary: boolean; text?: string; sha256: string; size: number };
    expect(binaryBody).toMatchObject({ binary: true, size: 4 });
    expect(binaryBody.text).toBeUndefined();
    expect(binary.json()).not.toHaveProperty("text");
    expect(binaryBody.sha256).toMatch(/^[a-f0-9]{64}$/);

    const empty = await app.inject({
      method: "POST",
      url: `/api/admin/app-reviews/${pending.id}/reject`,
      headers: { "content-type": "application/json" },
      payload: { reason: "  " },
    });
    expect(empty.statusCode).toBe(400);
    const approved = await app.inject({ method: "POST", url: `/api/admin/app-reviews/${pending.id}/approve` });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ state: "approved" });
    expect(ctx.db.select().from(appVersions).where(eq(appVersions.version, "2.0.0")).get()?.sha256).toBe(shaBefore);
    const audit = ctx.db.$client.prepare("select action, attrs_json as attrs from audit_log where action='app.publish_review'").get() as { action: string; attrs: string };
    expect(audit.action).toBe("app.publish_review");
    const event = ctx.db.$client.prepare("select type, attrs_json as attrs from events where type='app.publish_reviewed'").get() as { type: string; attrs: string };
    expect(event.type).toBe("app.publish_reviewed");
    expect(event.attrs).not.toContain("please");
    expect(event.attrs).not.toContain("ping");
    expect(listUserCatalog(ctx.deps, "bob").find((entry) => entry.name === "notes")).toMatchObject({ version: { version: "2.0.0" } });
    expect(listAdminCatalog(ctx.deps, adminScope("carol"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "notes", source: "user", ownerUserId: "alice", ownerName: "Alice" }),
    ]));

    const versionId = ctx.db.select().from(appVersions).where(eq(appVersions.version, "2.0.0")).get()?.id;
    const appId = ctx.db.select().from(appVersions).where(eq(appVersions.version, "2.0.0")).get()?.appId;
    const pushed = await app.inject({
      method: "POST",
      url: `/api/admin/apps/${appId}/push`,
      headers: { "content-type": "application/json" },
      payload: { versionId, userIds: ["bob"] },
    });
    expect(pushed.statusCode).toBe(404);
    const retired = await app.inject({ method: "POST", url: `/api/admin/apps/${appId}/versions/${versionId}/retire` });
    expect(retired.statusCode).toBe(200);
    expect(listUserCatalog(ctx.deps, "bob").find((entry) => entry.name === "notes")).toMatchObject({ version: { version: "1.0.0" } });
    await expect(installForUser(ctx.deps, "bob", "notes", { version: "2.0.0" })).rejects.toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});

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
