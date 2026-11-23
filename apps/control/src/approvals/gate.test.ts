import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalTools } from "../agent/approval-tools.js";
import { authenticated } from "../auth.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { argsHash, canonicalJson } from "../m2/risk.js";
import { createApprovalGate } from "./gate.js";
import { applyProposedRule, proposalSummary } from "./propose-tool.js";
import { registerApprovalRoutes } from "./routes.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vb-approval-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  cleanups.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }); });
  db.$client.exec(`insert into users(id,email,name,status,created_at) values ('a','a','a','active','now'),('b','b','b','active','now');
    insert into bots(id,user_id,name,model,created_at,updated_at) values ('bot','a','bot','model','now','now');
    insert into tasks(id,bot_id,state,trigger) values ('task','bot','running','user');`);
  return { dir, db };
}
function context(name: string, args: unknown): BeforeToolCallContext {
  return { toolCall: { name }, args } as BeforeToolCallContext;
}
function pending(db: AppDatabase) {
  return db.$client.prepare("select id from approvals where state='pending' order by rowid desc limit 1").get() as { id: string };
}

describe("approval gate", () => {
  it.each([
    ["全免审批", { approveNone: true }],
    ["类别免审批", { alwaysAllow: ["shell"] }],
    ["规则免审批", {}],
  ])("requires the owner to approve a bot-triggered tool despite %s", async (label, settings) => {
    const { db } = fixture();
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify(settings));
    if (label === "规则免审批") {
      db.$client.prepare("insert into approval_rules(id,user_id,bot_id,category,match_json,created_at) values ('rule','a','bot','shell',?,'now')")
        .run(JSON.stringify({ prefix: ["echo", "ok"] }));
    }
    const gate = createApprovalGate({ db, waitMs: 5000 });
    const hook = gate.bind("task").beforeToolCall!;
    expect(await hook(context("shell_exec", { cmd: "echo ok" }))).toBeUndefined();
    db.$client.prepare("update tasks set trigger='bot_message' where id='task'").run();
    expect(await hook(context("send_to_bot", { bot: "peer", text: "job" }))).toBeUndefined();
    const signal = new AbortController();
    const waiting = hook(context("shell_exec", { cmd: "echo ok" }), signal.signal);
    try {
      const approval = pending(db);
      expect(approval).toBeDefined();
      expect(gate.decide("b", approval.id, "allow")).toBe("not_found");
      expect(gate.decide("a", approval.id, "deny")).toBe("ok");
      expect((await waiting)?.block).toBe(true);
    } finally {
      signal.abort();
      await waiting;
    }
  });

  it("rejects changed profile edits and a takeover acquired during approval", async () => {
    const { db } = fixture();
    const gate = createApprovalGate({ db, waitMs: 5000 });
    const args = { instructions: "approved prompt" };
    const edit = gate.bind("task").beforeToolCall!(context("update_bot_profile", args));
    args.instructions = "unapproved prompt";
    gate.decide("a", pending(db).id, "allow");
    expect((await edit)?.block).toBe(true);
    const shell = gate.bind("task").beforeToolCall!(context("shell_exec", { cmd: "echo ok" }));
    db.$client.prepare("insert into takeover_leases(id,bot_id,user_id,state,created_at,updated_at) values ('lease','bot','a','active','now','now')").run();
    gate.decide("a", pending(db).id, "allow");
    expect((await shell)?.reason).toBe("用户正在接管，已拒绝执行");
  });

  it("rejects mutation of the approved install arguments during the wait", async () => {
    const { db } = fixture();
    const gate = createApprovalGate({ db, waitMs: 5000 });
    const args = { remote: { name: "demo", url: "https://approved.example/mcp" }, reason: "install" };
    const waiting = gate.bind("task").beforeToolCall!(context("install_mcp", args));
    const id = pending(db).id;
    args.remote.url = "https://different.example/mcp";
    gate.decide("a", id, "allow");
    expect((await waiting)?.block).toBe(true);
    expect(db.$client.prepare("select consumed_at from approvals where id=?").get(id)).toEqual({ consumed_at: null });
  });

  it("preserves a complete install summary instead of truncating its JSON", async () => {
    const { db } = fixture();
    const summary = JSON.stringify({ source: "remote", title: "https://approved.example/mcp", reason: "x".repeat(4500) });
    const gate = createApprovalGate({ db, waitMs: 5000, summarize: () => summary });
    const waiting = gate.bind("task").beforeToolCall!(context("install_mcp", { reason: "install" }));
    expect(db.$client.prepare("select summary from approvals where id=?").get(pending(db).id)).toEqual({ summary });
    gate.decide("a", pending(db).id, "deny");
    await waiting;
  });

  it("expires a waiting approval and refuses a late decision", async () => {
    const { db } = fixture();
    vi.useFakeTimers();
    try {
      const gate = createApprovalGate({ db, waitMs: 100 });
      const waiting = gate.bind("task").beforeToolCall!(context("shell_exec", { cmd: "write" }));
      const approval = pending(db);
      await vi.advanceTimersByTimeAsync(100);
      expect((await waiting)?.block).toBe(true);
      expect(gate.decide("a", approval.id, "allow")).toBe("decided");
      expect(db.$client.prepare("select state,consumed_at from approvals where id=?").get(approval.id)).toEqual({ state: "timeout", consumed_at: null });
      expect(db.$client.prepare("select state from tasks where id='task'").get()).toEqual({ state: "running" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds one decision to canonical arguments and denies without executing", async () => {
    const { db, dir } = fixture();
    const gate = createApprovalGate({ db, waitMs: 5000 });
    const hook = gate.bind("task").beforeToolCall!;
    const path = join(dir, "approved");
    const other = join(dir, "other");
    writeFileSync(path, "a"); writeFileSync(other, "b");
    const tools = approvalTools({ delete: async (p) => { if (p !== path && p !== other) throw new Error("outside fixture"); rmSync(p); } });
    const deletion = tools.find((tool) => tool.name === "bulk_delete_action")!;
    const first = hook(context("bulk_delete_action", { paths: [path] }));
    let settled = false; void first.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    expect(db.$client.prepare("select state from tasks where id='task'").get()).toEqual({ state: "waiting_approval" });
    expect((await hook(context("bulk_delete_action", { paths: [other] })))?.block).toBe(true);
    expect(gate.decide("a", pending(db).id, "allow")).toBe("ok");
    expect(await first).toBeUndefined();
    await deletion.execute("1", { paths: [path] }, undefined, undefined);
    expect(existsSync(path)).toBe(false); expect(existsSync(other)).toBe(true);
    const again = hook(context("bulk_delete_action", { paths: [path] }));
    expect(gate.decide("a", pending(db).id, "deny")).toBe("ok");
    expect((await again)?.block).toBe(true);
    const different = hook(context("bulk_delete_action", { paths: [other] }));
    expect(gate.decide("a", pending(db).id, "deny")).toBe("ok");
    expect((await different)?.block).toBe(true); expect(existsSync(other)).toBe(true);
    expect(db.$client.prepare("select count(*) as n from approvals where consumed_at is not null").get()).toEqual({ n: 1 });
  });

  it("consumes an allowed decision once after a restart and does not ask again", async () => {
    const { db } = fixture();
    db.$client.prepare("update tasks set state='waiting_approval' where id='task'").run();
    const hash = argsHash("shell_exec", { cmd: "echo hi" });
    db.$client.prepare("insert into approvals (id,task_id,tool,summary,args_json,state,args_hash,decided_by,decided_at) values ('allow-1','task','shell_exec','shell_exec',?,'allowed',?,'a','now')")
      .run(canonicalJson({ cmd: "echo hi" }), hash);
    let rearmed = 0;
    const gate = createApprovalGate({ db, waitMs: 5000, onRearm: () => { rearmed += 1; } });
    expect(gate.arm().map((item) => item.id)).toEqual(["allow-1"]);
    expect(rearmed).toBe(1);
    expect(db.$client.prepare("select state from tasks where id='task'").get()).toEqual({ state: "waiting_approval" });
    const hook = gate.bind("task").beforeToolCall!;
    expect(await hook(context("shell_exec", { cmd: "echo hi" }))).toBeUndefined();
    expect(db.$client.prepare("select consumed_at is not null as consumed from approvals where id='allow-1'").get()).toEqual({ consumed: 1 });
    const again = hook(context("shell_exec", { cmd: "echo hi" }));
    expect(gate.decide("a", pending(db).id, "deny")).toBe("ok");
    expect((await again)?.block).toBe(true);
  });

  it("requires approval for shell, browser, and unknown tools", async () => {
    const { db } = fixture();
    const gate = createApprovalGate({ db, waitMs: 5000, riskyToolNames: new Set(["plugin_danger"]) });
    const hook = gate.bind("task").beforeToolCall!;
    const args = { cmd: "echo rm pay", cwd: "/tmp", env: { B: "2", A: "1" }, timeoutSec: 3 };
    const waiting = hook(context("shell_exec", args));
    const row = db.$client.prepare("select * from approvals where state='pending'").get() as { id: string; args_json: string; args_hash: string };
    const bound = { cmd: args.cmd, cwd: args.cwd, env: args.env };
    expect(row.args_json).toBe(canonicalJson(bound));
    expect(row.args_hash).toBe(argsHash("shell_exec", bound));
    gate.decide("a", row.id, "allow");
    expect(await waiting).toBeUndefined();
    const changed = hook(context("shell_exec", { ...args, env: { A: "different" } }));
    gate.decide("a", pending(db).id, "deny");
    expect((await changed)?.block).toBe(true);
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify({ alwaysAllow: ["risky_tool"], approveShell: true }));
    expect(await hook(context("plugin_danger", {}))).toBeUndefined();
    const shellStill = hook(context("shell_exec", args));
    const extra = hook(context("plugin_danger_extra", {}));
    expect((await extra)?.block).toBe(true);
    gate.decide("a", pending(db).id, "deny");
    expect((await shellStill)?.block).toBe(true);
    const lone = hook(context("foreign_mcp", { pay: true }));
    expect(db.$client.prepare("select tool from approvals where state='pending'").get()).toEqual({ tool: "foreign_mcp" });
    gate.decide("a", pending(db).id, "deny");
    expect((await lone)?.block).toBe(true);
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify({ alwaysAllow: ["shell"] }));
    expect(await hook(context("shell_exec", args))).toBeUndefined();
    const write = hook(context("fs_write", { path: "/tmp/a", content: "x" }));
    expect(db.$client.prepare("select tool from approvals where state='pending' order by rowid desc limit 1").get()).toEqual({ tool: "fs_write" });
    gate.decide("a", pending(db).id, "deny");
    expect((await write)?.block).toBe(true);
    expect(await hook(context("fs_read", { path: "/tmp/a" }))).toBeUndefined();
    const click = hook(context("browser_click", { ref: "e1" }));
    gate.decide("a", pending(db).id, "deny");
    expect((await click)?.block).toBe(true);
    const names = new Set<string>(["plugin_danger"]);
    const dynamic = createApprovalGate({ db, waitMs: 5000, riskyToolNames: () => names });
    const dynamicHook = dynamic.bind("task").beforeToolCall!;
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify({ alwaysAllow: ["risky_tool"] }));
    expect(await dynamicHook(context("plugin_danger", {}))).toBeUndefined();
    names.delete("plugin_danger");
    const becameMcp = dynamicHook(context("plugin_danger", {}));
    expect(db.$client.prepare("select tool from approvals where state='pending' order by rowid desc limit 1").get()).toEqual({ tool: "plugin_danger" });
    dynamic.decide("a", pending(db).id, "deny");
    expect((await becameMcp)?.block).toBe(true);
  });

  it("leaves a fixture unchanged when shell or browser is denied and runs an allow once", async () => {
    const { db, dir } = fixture();
    const gate = createApprovalGate({ db, waitMs: 5000 });
    const hook = gate.bind("task").beforeToolCall!;
    const ledger = join(dir, "ledger");
    writeFileSync(ledger, "0");
    const shellArgs = { cmd: "apply pay", cwd: dir, env: {} };
    const deniedShell = hook(context("shell_exec", shellArgs));
    expect(readFileSync(ledger, "utf8")).toBe("0");
    gate.decide("a", pending(db).id, "deny");
    expect((await deniedShell)?.block).toBe(true);
    expect(readFileSync(ledger, "utf8")).toBe("0");
    const deniedClick = hook(context("browser_click", { ref: "pay" }));
    gate.decide("a", pending(db).id, "deny");
    expect((await deniedClick)?.block).toBe(true);
    expect(readFileSync(ledger, "utf8")).toBe("0");
    const allowed = hook(context("shell_exec", shellArgs));
    gate.decide("a", pending(db).id, "allow");
    expect(await allowed).toBeUndefined();
    writeFileSync(ledger, "paid");
    const repeat = hook(context("shell_exec", shellArgs));
    const during = hook(context("browser_click", { ref: "pay" }));
    expect((await during)?.block).toBe(true);
    gate.decide("a", pending(db).id, "deny");
    expect((await repeat)?.block).toBe(true);
    expect(readFileSync(ledger, "utf8")).toBe("paid");
    db.$client.prepare("insert into takeover_leases(id,bot_id,user_id,state,created_at,updated_at) values ('lease','bot','a','active','now','now')").run();
    expect((await hook(context("fs_write", { path: ledger, content: "x" })))?.block).toBe(true);
    expect(await hook(context("fs_read", { path: ledger }))).toBeUndefined();
    expect(readFileSync(ledger, "utf8")).toBe("paid");
    expect((await hook(context("foreign_mcp", { pay: true })))?.block).toBe(true);
  });

  it("re-arms persisted waits and hides decisions from other users", async () => {
    const { db } = fixture();
    const args = { recipient: "local" };
    db.$client.prepare("update tasks set state='waiting_approval' where id='task'").run();
    db.$client.prepare("insert into approvals(id,task_id,tool,summary,args_json,state,args_hash) values ('old','task','foreign_mcp','mcp',?,'pending',?)")
      .run(canonicalJson(args), argsHash("foreign_mcp", args));
    const resumed: string[] = [];
    const gate = createApprovalGate({ db, waitMs: 5000, onRearm: (taskId) => resumed.push(taskId) });
    gate.arm(); expect(resumed).toEqual(["task"]);
    const app = Fastify();
    app.addHook("preHandler", async (request) => { authenticated.set(request, { user: { id: String(request.headers["x-test-user"]) } } as never); });
    registerApprovalRoutes(app, { db, gate });
    cleanups.push(() => app.close());
    const outsider = await app.inject({ method: "POST", url: "/api/approvals/old/decide", headers: { "x-test-user": "b" }, payload: { decision: "allow" } });
    expect(outsider.statusCode).toBe(404);
    const hook = gate.bind("task").beforeToolCall!;
    expect((await hook(context("foreign_mcp", { recipient: "different" })))?.block).toBe(true);
    const wait = hook(context("foreign_mcp", args));
    const allowed = await app.inject({ method: "POST", url: "/api/approvals/old/decide", headers: { "x-test-user": "a" }, payload: { decision: "allow" } });
    expect(allowed.statusCode).toBe(200); expect(await wait).toBeUndefined();
    expect(db.$client.prepare("select consumed_at from approvals where id='old'").get()).toEqual({ consumed_at: expect.any(String) });
  });

  it("still prompts for install_mcp when alwaysAllow contains app_install, and a different hash cannot reuse the approval", async () => {
    const { db } = fixture();
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify({ alwaysAllow: ["app_install", "mcp", "shell"] }));
    const secret = "vb-mcpinst-plaintext-should-not-appear";
    const args = {
      package: { name: "demo", ecosystem: "npm", package: "left-pad", version: "1.2.3" },
      config: { API_TOKEN: "{{secret:api_token}}" },
      secretKeys: ["API_TOKEN"],
      reason: "需要这个包",
    };
    const gate = createApprovalGate({
      db,
      waitMs: 5000,
      summarize: (_taskId, tool, value) => tool === "install_mcp"
        ? JSON.stringify({ source: "package", title: "npm left-pad 1.2.3", command: "./bin/mcp", config: [{ key: "API_TOKEN", display: "已填写的密钥" }], reason: "需要这个包", riskyTools: [], runsInstallScript: true })
        : tool,
    });
    const hook = gate.bind("task").beforeToolCall!;
    const waiting = hook(context("install_mcp", args));
    await Promise.resolve();
    const row = db.$client.prepare("select id, summary, args_json, args_hash from approvals where state='pending'").get() as { id: string; summary: string; args_json: string; args_hash: string };
    expect(row.summary).toContain("已填写的密钥");
    expect(row.summary).not.toContain(secret);
    expect(row.args_json).toContain("{{secret:api_token}}");
    expect(row.args_json).not.toContain(secret);
    expect(row.args_hash).toBe(argsHash("install_mcp", args));
    expect((await hook(context("install_mcp", { ...args, reason: "换成别的理由" })))?.reason).toBe("待审批的参数与当前调用不一致");
    gate.decide("a", row.id, "allow");
    expect(await waiting).toBeUndefined();
    const changed = hook(context("install_mcp", { ...args, reason: "换成别的理由" }));
    await Promise.resolve();
    expect(db.$client.prepare("select id from approvals where state='pending'").get()).toBeDefined();
    expect(db.$client.prepare("select consumed_at is not null as consumed from approvals where id=?").get(row.id)).toEqual({ consumed: 1 });
    gate.decide("a", pending(db).id, "deny");
    expect((await changed)?.reason).toBe("用户拒绝安装");
  });

  it("auto-approves a matching shell rule, still asks for metacharacters, and refuses during takeover", async () => {
    const { db } = fixture();
    db.$client.prepare("insert into approval_rules(id,user_id,bot_id,category,match_json,hit_count,created_at) values ('rule','a','bot','shell',?,0,'now')")
      .run(JSON.stringify({ prefix: ["echo", "ok"] }));
    const gate = createApprovalGate({ db, waitMs: 5000 });
    const hook = gate.bind("task").beforeToolCall!;
    expect(await hook(context("shell_exec", { cmd: "echo ok" }))).toBeUndefined();
    expect((db.$client.prepare("select hit_count as hitCount from approval_rules where id='rule'").get() as { hitCount: number }).hitCount).toBe(1);
    const install = hook(context("install_mcp", { reason: "no" }));
    expect(db.$client.prepare("select tool from approvals where state='pending'").get()).toEqual({ tool: "install_mcp" });
    gate.decide("a", pending(db).id, "deny");
    expect((await install)?.block).toBe(true);
    const blocked = hook(context("shell_exec", { cmd: "echo ok; rm" }));
    expect(db.$client.prepare("select id from approvals where state='pending'").get()).toBeDefined();
    gate.decide("a", pending(db).id, "deny");
    expect((await blocked)?.block).toBe(true);
    db.$client.prepare("insert into takeover_leases(id,bot_id,user_id,state,created_at,updated_at) values ('lease','bot','a','active','now','now')").run();
    expect((await hook(context("shell_exec", { cmd: "echo ok" })))?.reason).toBe("用户正在接管，已拒绝执行");
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify({ alwaysAllow: ["shell", "bot_profile"] }));
    db.$client.prepare("delete from takeover_leases").run();
    const profile = hook(context("update_bot_profile", { instructions: "新的提示词" }));
    expect(db.$client.prepare("select tool from approvals where state='pending'").get()).toEqual({ tool: "update_bot_profile" });
    gate.decide("a", pending(db).id, "deny");
    expect((await profile)?.block).toBe(true);
    const app = Fastify();
    app.addHook("preHandler", async (request) => { authenticated.set(request, { user: { id: String(request.headers["x-test-user"]) } } as never); });
    registerApprovalRoutes(app, { db, gate });
    cleanups.push(() => app.close());
    const foreign = await app.inject({ method: "GET", url: "/api/bots/bot/approval-rules", headers: { "x-test-user": "b" } });
    expect(foreign.statusCode).toBe(404);
    const own = await app.inject({ method: "GET", url: "/api/bots/bot/approval-rules", headers: { "x-test-user": "a" } });
    expect(own.statusCode).toBe(200);
    expect(own.json().rules).toHaveLength(1);
  });

  it("lets the master switch skip install and prompt edits, but not rule proposals or takeover", async () => {
    const { db } = fixture();
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify({ approveNone: true }));
    const gate = createApprovalGate({ db, waitMs: 5000 });
    const hook = gate.bind("task").beforeToolCall!;
    expect(await hook(context("install_mcp", { reason: "skip" }))).toBeUndefined();
    expect(await hook(context("update_bot_profile", { instructions: "新提示" }))).toBeUndefined();
    expect(db.$client.prepare("select id from approvals").get()).toBeUndefined();
    const notes = db.$client.prepare("select attrs_json as attrs from audit_log where action='approval.skip_all'").all() as Array<{ attrs: string }>;
    expect(notes.some((row) => row.attrs.includes("全部免审批"))).toBe(true);
    const proposed = hook(context("propose_approval_rule", { category: "shell", match: { prefix: "echo ok" } }));
    expect(db.$client.prepare("select tool from approvals where state='pending'").get()).toEqual({ tool: "propose_approval_rule" });
    gate.decide("a", pending(db).id, "deny");
    expect((await proposed)?.block).toBe(true);
    expect((await hook(context("update_bot_profile", { approveNone: false, name: "不能关" })))?.block).toBe(true);
    const stored = db.$client.prepare("select settings_json as settingsJson from bots where id='bot'").get() as { settingsJson: string };
    expect(JSON.parse(stored.settingsJson).approveNone).toBe(true);
    db.$client.prepare("insert into takeover_leases(id,bot_id,user_id,state,created_at,updated_at) values ('lease2','bot','a','active','now','now')").run();
    expect((await hook(context("shell_exec", { cmd: "echo ok" })))?.reason).toBe("用户正在接管，已拒绝执行");
  });

  it("applies a proposed rule only after approval and refuses a changed payload", async () => {
    const { db } = fixture();
    const gate = createApprovalGate({
      db,
      waitMs: 5000,
      summarize: (_taskId, tool, args) => (tool === "propose_approval_rule" ? proposalSummary(args) : tool),
    });
    const hook = gate.bind("task").beforeToolCall!;
    const denied = hook(context("propose_approval_rule", { category: "shell", match: { prefix: "echo no" } }));
    gate.decide("a", pending(db).id, "deny");
    expect((await denied)?.block).toBe(true);
    expect(db.$client.prepare("select id from approval_rules").get()).toBeUndefined();
    const args = { category: "shell", match: { prefix: "echo ok" } };
    const waiting = hook(context("propose_approval_rule", args));
    const id = pending(db).id;
    expect((db.$client.prepare("select summary from approvals where id=?").get(id) as { summary: string }).summary).toContain("echo ok");
    args.match.prefix = "echo changed";
    gate.decide("a", id, "allow");
    expect((await waiting)?.block).toBe(true);
    expect(db.$client.prepare("select consumed_at from approvals where id=?").get(id)).toEqual({ consumed_at: null });
    expect(db.$client.prepare("select id from approval_rules").get()).toBeUndefined();
    const other = hook(context("propose_approval_rule", { category: "shell", match: { prefix: "echo other" } }));
    const otherId = pending(db).id;
    expect(otherId).not.toBe(id);
    gate.decide("a", otherId, "deny");
    expect((await other)?.block).toBe(true);
    expect(db.$client.prepare("select id from approval_rules").get()).toBeUndefined();
    db.$client.prepare("insert into tasks(id,bot_id,state,trigger) values ('task2','bot','running','user')").run();
    const fresh = gate.bind("task2").beforeToolCall!;
    const again = { category: "shell", match: { prefix: "echo ok" } };
    const approved = fresh(context("propose_approval_rule", again));
    gate.decide("a", pending(db).id, "allow");
    expect(await approved).toBeUndefined();
    expect(applyProposedRule({ db, userId: "a", botId: "bot" }, again)).toBeTruthy();
    expect(await fresh(context("shell_exec", { cmd: "echo ok" }))).toBeUndefined();
    expect(db.$client.prepare("select expires_at as expiresAt from approval_rules").get()).toEqual({ expiresAt: null });
  });
});
