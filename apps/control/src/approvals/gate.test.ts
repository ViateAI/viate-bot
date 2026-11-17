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
    db.$client.prepare("update bots set settings_json=? where id='bot'").run(JSON.stringify({ alwaysAllow: ["payment", "risky_tool"], approveShell: true }));
    expect(await hook(context("payment_action", { amount: 4 }))).toBeUndefined();
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
    for (const name of ["payment_action", "send_action"]) {
      const tool = approvalTools({ delete: async () => { throw new Error("unexpected delete"); } }).find((item) => item.name === name)!;
      expect((await tool.execute("x", { value: "local" }, undefined, undefined)).content).toEqual([{ type: "text", text: '{"value":"local"}' }]);
    }
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
    db.$client.prepare("insert into approvals(id,task_id,tool,summary,args_json,state,args_hash) values ('old','task','send_action','send',?,'pending',?)")
      .run(canonicalJson(args), argsHash("send_action", args));
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
    expect((await hook(context("send_action", { recipient: "different" })))?.block).toBe(true);
    const wait = hook(context("send_action", args));
    const allowed = await app.inject({ method: "POST", url: "/api/approvals/old/decide", headers: { "x-test-user": "a" }, payload: { decision: "allow" } });
    expect(allowed.statusCode).toBe(200); expect(await wait).toBeUndefined();
    expect(db.$client.prepare("select consumed_at from approvals where id='old'").get()).toEqual({ consumed_at: expect.any(String) });
  });
});
