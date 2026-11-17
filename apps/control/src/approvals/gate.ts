import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { ToolHooks } from "../agent/hooks.js";
import { auditRepository } from "../db/audit.js";
import { emitOps, opsMinutes } from "../ops/rollup.js";
import type { AppDatabase } from "../db/index.js";
import { ulid } from "../id.js";
import { AUDIT_ACTIONS, M2_EVENTS } from "../m2/events.js";
import { approvalClass, argsHash, canonicalJson, READ_ONLY_TOOLS, readBotSettings } from "../m2/risk.js";
import { adminScope } from "../scope.js";

interface ApprovalRow {
  id: string; task_id: string; tool: string; args_json: string; args_hash: string;
  state: string; user_id: string; bot_id: string;
}

export interface ApprovalGateOptions {
  db: AppDatabase;
  waitMs: number;
  riskyToolNames?: ReadonlySet<string> | ((botId: string) => ReadonlySet<string>);
  onRearm?: (taskId: string, approvalId: string) => void;
  onWaiting?: (taskId: string) => void;
}

export interface ApprovalGate {
  bind(taskId: string): ToolHooks;
  arm(): Array<{ id: string; task_id: string }>;
  decide(userId: string, id: string, decision: "allow" | "deny"): "ok" | "not_found" | "decided";
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const db = options.db.$client;
  const waiters = new Map<string, (state: string) => void>();
  const armed = new Map<string, string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const find = db.prepare(`select a.*, b.user_id, b.id as bot_id from approvals a
    join tasks t on t.id=a.task_id join bots b on b.id=t.bot_id where a.id=?`);

  function row(id: string): ApprovalRow | undefined { return find.get(id) as ApprovalRow | undefined; }
  function finish(id: string, state: string) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    waiters.get(id)?.(state);
    waiters.delete(id);
  }
  function expire(id: string, state: string) {
    const changed = db.prepare("update approvals set state=?, decided_at=? where id=? and state='pending'")
      .run(state, new Date().toISOString(), id).changes;
    if (changed) finish(id, state);
  }
  function startTimer(id: string) {
    if (!timers.has(id)) timers.set(id, setTimeout(() => expire(id, "timeout"), options.waitMs));
  }
  function arm() {
    const rows = db.prepare(`select a.id, a.task_id, a.state from approvals a join tasks t on t.id=a.task_id
      where a.consumed_at is null and a.state in ('pending','allowed','denied') and t.state='waiting_approval'`).all() as Array<{ id: string; task_id: string; state: string }>;
    for (const item of rows) {
      if (armed.has(item.task_id)) continue;
      armed.set(item.task_id, item.id);
      if (item.state === "pending") startTimer(item.id);
      options.onRearm?.(item.task_id, item.id);
    }
    return rows;
  }
  function decide(userId: string, id: string, decision: "allow" | "deny"): "ok" | "not_found" | "decided" {
    const item = row(id);
    if (!item || item.user_id !== userId) return "not_found";
    const state = decision === "allow" ? "allowed" : "denied";
    const changed = db.prepare("update approvals set state=?, decided_by=?, decided_at=? where id=? and state='pending'")
      .run(state, userId, new Date().toISOString(), id).changes;
    if (!changed) return "decided";
    const attrs = { approvalId: id, taskId: item.task_id, tool: item.tool, state };
    auditRepository(options.db).write(adminScope(userId), AUDIT_ACTIONS.approvalDecided, id, attrs);
    emitOps(options.db, opsMinutes, { id: ulid(), ts: new Date().toISOString(), userId, botId: item.bot_id, type: M2_EVENTS.approvalDecided, attrs });
    finish(id, state);
    return "ok";
  }
  function bind(taskId: string): ToolHooks {
    return { beforeToolCall: async (context: BeforeToolCallContext, signal?: AbortSignal) => {
      const bot = db.prepare("select b.id, b.settings_json from tasks t join bots b on b.id=t.bot_id where t.id=? and b.deleted_at is null")
        .get(taskId) as { id: string; settings_json: string } | undefined;
      if (!bot) return { block: true, reason: "找不到任务" };
      const name = context.toolCall.name;
      const settings = readBotSettings(bot.settings_json);
      const risky = typeof options.riskyToolNames === "function" ? options.riskyToolNames(bot.id) : options.riskyToolNames;
      const category = approvalClass(name, risky);
      const takeover = db.prepare("select 1 as n from takeover_leases where bot_id=? and state='active'").get(bot.id) as { n: number } | undefined;
      const task = db.prepare("select state from tasks where id=?").get(taskId) as { state: string } | undefined;
      if (!READ_ONLY_TOOLS[name] && (takeover || task?.state === "waiting_takeover")) {
        return { block: true, reason: "用户正在接管，已拒绝执行" };
      }
      if (!category || settings.alwaysAllow.includes(category)) return undefined;
      const input = context.args as Record<string, unknown>;
      const args = name === "shell_exec" ? { cmd: input.cmd, cwd: input.cwd, env: input.env } : context.args;
      const json = canonicalJson(args);
      const hash = argsHash(name, args);
      let id = armed.get(taskId);
      const previous = id ? row(id) : undefined;
      if (previous && (previous.tool !== name || previous.args_hash !== hash)) {
        return { block: true, reason: "待审批的参数与当前调用不一致" };
      }
      if (!previous) {
        const stored = db.prepare(`select id from approvals where task_id=? and consumed_at is null and state in ('pending','allowed','denied') order by rowid desc limit 1`).get(taskId) as { id: string } | undefined;
        const found = stored ? row(stored.id) : undefined;
        if (found && found.tool === name && found.args_hash === hash) {
          id = found.id;
        } else if (found?.state === "pending") {
          return { block: true, reason: "待审批的参数与当前调用不一致" };
        }
      }
      if (!id) {
        id = ulid();
        const created = db.transaction(() => {
          const changed = db.prepare("update tasks set state='waiting_approval' where id=? and state='running'").run(taskId).changes;
          if (!changed) return false;
          db.prepare("insert into approvals (id,task_id,tool,summary,args_json,state,args_hash) values (?,?,?,?,?,'pending',?)")
            .run(id, taskId, name, name, json, hash);
          return true;
        })();
        if (!created) return { block: true, reason: "任务不在运行中" };
        options.onWaiting?.(taskId);
      }
      const approvalId = id!;
      armed.delete(taskId);
      if (row(approvalId)?.state === "pending") startTimer(approvalId);
      const abort = () => expire(approvalId, "stopped");
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      const current = row(approvalId);
      let state = current?.state;
      if (state === "pending") {
        db.prepare("update tasks set state='waiting_approval' where id=? and state='running'").run(taskId);
        const pending = Promise.withResolvers<string>();
        waiters.set(approvalId, pending.resolve);
        state = await pending.promise;
      }
      signal?.removeEventListener("abort", abort);
      db.prepare("update tasks set state='running' where id=? and state='waiting_approval'").run(taskId);
      if (state === "allowed" && !signal?.aborted) {
        const consumed = db.prepare("update approvals set consumed_at=? where id=? and state='allowed' and consumed_at is null and args_hash=?")
          .run(new Date().toISOString(), approvalId, hash).changes;
        if (consumed) return undefined;
      }
      return { block: true, reason: state === "denied" ? "用户拒绝了审批" : "审批未完成或已失效" };
    } };
  }
  return { bind, arm, decide };
}
