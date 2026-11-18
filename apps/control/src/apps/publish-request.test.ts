import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticated } from "../auth.js";
import { openDatabase } from "../db/index.js";
import { appPublishRequests, appVersions } from "../db/schema.js";
import { userRepository, type UserRecord } from "../db/users.js";
import type { ResolvedSession } from "../session.js";
import { createApprovalGate } from "../approvals/gate.js";
import { validatePackage, type PackageFile } from "./archive.js";
import { registerCatalogRoutes, type CatalogDeps } from "./catalog.js";
import { packageAppFromArchive } from "./package-app.js";
import { describePublish, requestAppPublish, requestAppPublishTool } from "./publish-request.js";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-pubreq-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => db.$client.close());
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const users = userRepository(db);
  const alice = users.insert({ id: "alice", email: "alice@example.com", name: "Alice", status: "active", isAdmin: false });
  users.insert({ id: "bob", email: "bob@example.com", name: "Bob", status: "active", isAdmin: false });
  db.$client.exec("insert into bots(id,user_id,name,model,created_at,updated_at) values ('bot','alice','bot','model','now','now'); insert into tasks(id,bot_id,state,trigger) values ('task','bot','running','user');");
  const deps: CatalogDeps = {
    db,
    key: Buffer.alloc(32, 4),
    dataDir: dir,
    installer: { async install() {}, async uninstall() {} },
  };
  return { db, deps, alice };
}

function files(name: string): PackageFile[] {
  return [
    {
      path: "plugin.json",
      data: Buffer.from(JSON.stringify({
        $schema: PLUGIN,
        name,
        extensions: { "ai.viate.bot": { routines: [{ cron: "0 9 * * *", timezone: "UTC", prompt: "ping" }] } },
      })),
    },
    { path: `skills/${name}/SKILL.md`, data: Buffer.from(`---\nname: ${name}\ndescription: private notes\n---\nhello\n`) },
    {
      path: "mcp.json",
      data: Buffer.from(JSON.stringify({
        $schema: MCP,
        mcpServers: { notes: { type: "stdio", command: "./bin/mcp", args: ["--serve"] } },
      })),
    },
  ];
}

async function packed(deps: CatalogDeps, name: string, version: string) {
  const archive = validatePackage(files(name)).archive;
  return packageAppFromArchive(deps, "alice", { version, archive, secrets: [] });
}

describe("request_app_publish", () => {
  it("does not submit if stopped immediately before tool execution", async () => {
    const { db, deps } = boot();
    await packed(deps, "notes", "1.0.0");
    const tool = requestAppPublishTool({ userId: "alice", botId: "bot", taskId: "task", catalog: deps });
    await expect(tool.execute("call", { name: "notes", version: "1.0.0", note: "publish" }, AbortSignal.abort())).rejects.toThrow();
    expect(db.select().from(appPublishRequests).all()).toEqual([]);
  });

  it.each(["deny", "timeout", "stop"] as const)("does not insert a request when owner approval ends with %s", async (outcome) => {
    const { db, deps } = boot();
    await packed(deps, "notes", "1.0.0");
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const gate = createApprovalGate({ db, waitMs: 100 });
      const args = { name: "notes", version: "1.0.0", note: "publish" };
      const waiting = gate.bind("task").beforeToolCall!({ toolCall: { name: "request_app_publish" }, args } as never, controller.signal);
      const row = db.$client.prepare("select id from approvals where state='pending'").get() as { id: string };
      expect(db.select().from(appPublishRequests).all()).toEqual([]);
      expect(gate.decide("bob", row.id, "allow")).toBe("not_found");
      if (outcome === "deny") gate.decide("alice", row.id, "deny");
      else if (outcome === "stop") controller.abort();
      else await vi.advanceTimersByTimeAsync(100);
      const result = await waiting;
      if (!result?.block) await requestAppPublishTool({ userId: "alice", botId: "bot", taskId: "task", catalog: deps }).execute("call", args, controller.signal);
      expect(result?.block).toBe(true);
      expect(db.select().from(appPublishRequests).all()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks approval if the packaged bytes change while the owner is deciding", async () => {
    const { db, deps } = boot();
    await packed(deps, "notes", "1.0.0");
    const gate = createApprovalGate({ db, waitMs: 5000, summarize: (_task, _tool, args) => JSON.stringify(describePublish(deps, "alice", args)) });
    const args = { name: "notes", version: "1.0.0", note: "publish" };
    const waiting = gate.bind("task").beforeToolCall!({ toolCall: { name: "request_app_publish" }, args } as never);
    const row = db.$client.prepare("select id from approvals where state='pending'").get() as { id: string };
    const version = db.select().from(appVersions).get()!;
    writeFileSync(version.archivePath, validatePackage([...files("notes"), { path: "hidden.txt", data: Buffer.from("unapproved") }]).archive);
    gate.decide("alice", row.id, "allow");
    expect((await waiting)?.block).toBe(true);
    expect(db.select().from(appPublishRequests).all()).toEqual([]);
  });

  it("requires the owner approval even in approveNone mode", async () => {
    const { db } = boot();
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify({ approveNone: true }));
    const gate = createApprovalGate({ db, waitMs: 5000 });
    const waiting = gate.bind("task").beforeToolCall!({ toolCall: { name: "request_app_publish" }, args: { name: "notes", version: "1.0.0", note: "publish" } } as never);
    const row = db.$client.prepare("select id from approvals where state='pending'").get() as { id: string } | undefined;
    if (row) gate.decide("alice", row.id, "deny");
    const result = await waiting;
    expect(row).toBeDefined();
    expect(result?.block).toBe(true);
    expect(db.select().from(appPublishRequests).all()).toEqual([]);
  });

  it("requires approval even when rules and alwaysAllow would pass, and the card shows the publish warning", async () => {
    const { db, deps } = boot();
    await packed(deps, "notes", "1.0.0");
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify({ alwaysAllow: ["shell", "mcp", "app_install"] }));
    db.$client.prepare("insert into approval_rules(id,user_id,bot_id,category,match_json,hit_count,created_at) values ('rule','alice','bot','shell',?,0,'now')")
      .run(JSON.stringify({ prefix: ["echo"] }));
    const gate = createApprovalGate({
      db,
      waitMs: 5000,
      summarize: (_taskId, tool, args) => {
        if (tool !== "request_app_publish") return tool;
        const card = describePublish(deps, "alice", args);
        return card ? JSON.stringify(card) : tool;
      },
    });
    const waiting = gate.bind("task").beforeToolCall!({ toolCall: { name: "request_app_publish" }, args: { name: "notes", version: "1.0.0", note: "please publish" } } as never);
    const row = db.$client.prepare("select tool, summary from approvals where state='pending'").get() as { tool: string; summary: string };
    expect(row.tool).toBe("request_app_publish");
    const card = JSON.parse(row.summary) as { name: string; version: string; kinds: string[]; files: number; command: string; routines: number; note: string; warning: string };
    expect(card).toMatchObject({
      name: "notes",
      version: "1.0.0",
      files: 3,
      routines: 1,
      note: "please publish",
    });
    expect(card.kinds).toEqual(expect.arrayContaining(["技能", "本地 MCP", "定时任务"]));
    expect(card.command).toContain("./bin/mcp");
    expect(card.warning).toContain("批准后会提交给管理员");
    expect(card.warning).toContain("所有用户可见可安装");
    gate.decide("alice", db.$client.prepare("select id from approvals where state='pending'").pluck().get() as string, "deny");
    expect((await waiting)?.block).toBe(true);
  });

  it("rejects duplicates, rejected versions, and apps the user does not own", async () => {
    const ctx = boot();
    await packed(ctx.deps, "notes", "1.0.0");
    await packed(ctx.deps, "notes", "2.0.0");
    await packed(ctx.deps, "notes", "3.0.0");
    const first = requestAppPublish(ctx.deps, "alice", { name: "notes", version: "1.0.0", note: "first", botId: "bot", taskId: "task" });
    expect(first).toMatchObject({ state: "pending", note: "first" });
    expect(() => requestAppPublish(ctx.deps, "alice", { name: "notes", version: "1.0.0", note: "again" })).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => requestAppPublish(ctx.deps, "bob", { name: "notes", version: "2.0.0", note: "steal" })).toThrow(expect.objectContaining({ statusCode: 404 }));
    ctx.db.update(appPublishRequests).set({ state: "rejected", reason: "no", reviewerUserId: "bob" }).where(eq(appPublishRequests.id, first.id)).run();
    expect(() => requestAppPublish(ctx.deps, "alice", { name: "notes", version: "1.0.0", note: "retry" })).toThrow(/新版本/);
    const second = requestAppPublish(ctx.deps, "alice", { name: "notes", version: "2.0.0", note: "next" });
    expect(second.state).toBe("pending");
    ctx.db.update(appPublishRequests).set({ state: "approved" }).where(eq(appPublishRequests.id, second.id)).run();
    expect(() => requestAppPublish(ctx.deps, "alice", { name: "notes", version: "2.0.0", note: "again" })).toThrow(expect.objectContaining({ statusCode: 409 }));

    const holder: { user: UserRecord | undefined } = { user: ctx.alice };
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (request) => {
      if (holder.user) authenticated.set(request, sessionFor(holder.user));
    });
    registerCatalogRoutes(app, ctx.deps);
    await app.ready();
    closers.push(() => { void app.close(); });
    const denied = await app.inject({
      method: "POST",
      url: "/api/apps/notes/publish",
      headers: { "content-type": "application/json" },
      payload: { version: "2.0.0", note: "from page" },
    });
    expect(denied.statusCode).toBe(409);
    const page = await app.inject({
      method: "POST",
      url: "/api/apps/notes/publish",
      headers: { "content-type": "application/json" },
      payload: { version: "3.0.0", note: "from page" },
    });
    expect(page.statusCode).toBe(201);
    expect(page.json()).toMatchObject({ state: "pending", note: "from page", botId: null });
    holder.user = undefined;
    const anon = await app.inject({ method: "POST", url: "/api/apps/notes/publish", headers: { "content-type": "application/json" }, payload: { version: "1.0.0", note: "x" } });
    expect(anon.statusCode).toBe(401);
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
