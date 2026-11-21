import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { ToolHooks } from "../agent/hooks.js";
import { auditRepository } from "../db/audit.js";
import { approvalRuleRepository } from "../db/approval-rules.js";
import { emitOps, opsMinutes } from "../ops/rollup.js";
import type { AppDatabase } from "../db/index.js";
import { ulid } from "../id.js";
import { AUDIT_ACTIONS, M2_EVENTS } from "../m2/events.js";
import { argsHash, canonicalJson, classifyTool, READ_ONLY_TOOLS, readBotSettings, skipsApproval } from "../m2/risk.js";
import { adminScope, userScope } from "../scope.js";
import { profileForbidden, profileNeedsApproval } from "../agent/profile-tool.js";
import { proposalError } from "./propose-tool.js";
import { ruleMatches } from "./rules.js";

interface ApprovalRow {
  id: string; task_id: string; tool: string; summary: string; args_json: string; args_hash: string;
  state: string; user_id: string; bot_id: string;
}

export interface ApprovalGateOptions {
  db: AppDatabase;
  waitMs: number;
  riskyToolNames?: ReadonlySet<string> | ((botId: string) => ReadonlySet<string>);
  onRearm?: (taskId: string, approvalId: string) => void;
  onWaiting?: (taskId: string) => void;
  onHold?: (taskId: string) => void;
  onRelease?: (taskId: string) => void;
  /** 审批卡片用。不能改执行参数，也不能写入配置值。 */
  summarize?: (taskId: string, tool: string, args: unknown) => string;
  browserUrl?: (taskId: string, tool: string, args: unknown) => Promise<string | undefined>;
  mcpApp?: (taskId: string, tool: string) => string | undefined;
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
      const bot = db.prepare("select b.id, b.user_id, b.settings_json from tasks t join bots b on b.id=t.bot_id where t.id=? and b.deleted_at is null")
        .get(taskId) as { id: string; user_id: string; settings_json: string } | undefined;
      if (!bot) return { block: true, reason: "找不到任务" };
      const name = context.toolCall.name;
      const settings = readBotSettings(bot.settings_json);
      const risky = typeof options.riskyToolNames === "function" ? options.riskyToolNames(bot.id) : options.riskyToolNames;
      const category = classifyTool(name, context.args, risky);
      if (name === "mcp_call" && (!stringField(context.args, "app") || !stringField(context.args, "tool"))) {
        return { block: true, reason: "mcp_call 需要 app 和 tool" };
      }
      const takeover = db.prepare("select 1 as n from takeover_leases where bot_id=? and state='active'").get(bot.id) as { n: number } | undefined;
      const task = db.prepare("select state from tasks where id=?").get(taskId) as { state: string } | undefined;
      if (!READ_ONLY_TOOLS[name] && (takeover || task?.state === "waiting_takeover")) {
        return { block: true, reason: "用户正在接管，已拒绝执行" };
      }
      if (name === "update_bot_profile") {
        const forbidden = profileForbidden(context.args);
        if (forbidden) return { block: true, reason: forbidden };
      }
      if (name === "propose_approval_rule") {
        const problem = proposalError(context.args);
        if (problem) return { block: true, reason: problem };
      } else if (settings.approveNone && name !== "request_app_publish") {
        const gated = name === "update_bot_profile" ? profileNeedsApproval(context.args) : Boolean(category);
        if (gated) {
          auditRepository(options.db).write(adminScope(bot.user_id), "approval.skip_all", bot.id, { note: "全部免审批", taskId, tool: name });
        }
        return undefined;
      }
      if (name === "update_bot_profile" && !profileNeedsApproval(context.args)) return undefined;
      if (skipsApproval(category, settings)) return undefined;
      if (autoRule(taskId, bot.id, bot.user_id, name, context.args, category)) return undefined;
      if (category === "browser" && name !== "browser_open") {
        const rules = approvalRuleRepository(options.db).active(userScope(bot.user_id), bot.id);
        if (rules.some((rule) => rule.category === "browser")) {
          const page = await options.browserUrl?.(taskId, name, context.args);
          if (hitRule(bot.user_id, taskId, name, context.args, rules, page, undefined)) return undefined;
        }
      }
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
          let summary = name;
          try {
            const described = options.summarize?.(taskId, name, args);
            if (described && described.length > 0) summary = described;
          } catch {
            summary = name;
          }
          db.prepare("insert into approvals (id,task_id,tool,summary,args_json,state,args_hash) values (?,?,?,?,?,'pending',?)")
            .run(id, taskId, name, summary, json, hash);
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
        options.onHold?.(taskId);
        const pending = Promise.withResolvers<string>();
        waiters.set(approvalId, pending.resolve);
        try {
          state = await pending.promise;
        } finally {
          options.onRelease?.(taskId);
        }
      }
      signal?.removeEventListener("abort", abort);
      db.prepare("update tasks set state='running' where id=? and state='waiting_approval'").run(taskId);
      const currentArgs = name === "shell_exec" ? { cmd: input.cmd, cwd: input.cwd, env: input.env } : context.args;
      if (argsHash(name, currentArgs) !== hash) {
        return { block: true, reason: "批准后的参数已改变，不能复用这次审批" };
      }
      if (!READ_ONLY_TOOLS[name] && db.prepare("select 1 from takeover_leases where bot_id=? and state='active'").get(bot.id)) {
        return { block: true, reason: "用户正在接管，已拒绝执行" };
      }
      if (state === "allowed" && !signal?.aborted) {
        if (name === "request_app_publish" && options.summarize) {
          try {
            if (options.summarize(taskId, name, currentArgs) !== row(approvalId)?.summary) {
              return { block: true, reason: "批准后的应用包已改变，请重新申请" };
            }
          } catch {
            return { block: true, reason: "无法校验批准的应用包，请重新申请" };
          }
        }
        const consumed = db.prepare("update approvals set consumed_at=? where id=? and state='allowed' and consumed_at is null and args_hash=?")
          .run(new Date().toISOString(), approvalId, hash).changes;
        if (consumed) return undefined;
      }
      const denied = state === "denied";
      const reason = denied && name === "install_mcp" ? "用户拒绝安装" : denied ? "用户拒绝了审批" : "审批未完成或已失效";
      return { block: true, reason };
    } };
  }
  function autoRule(taskId: string, botId: string, userId: string, tool: string, args: unknown, category: ReturnType<typeof classifyTool>): boolean {
    if (tool === "install_mcp" || tool === "request_app_publish" || tool === "update_bot_profile" || tool === "bulk_delete_action" || tool === "propose_approval_rule" || tool === "mcp_inspect") return false;
    if (category !== "browser" && category !== "shell" && category !== "fs_write" && category !== "mcp") return false;
    if (category === "browser" && tool !== "browser_open") return false;
    const rules = approvalRuleRepository(options.db).active(userScope(userId), botId);
    const browserUrl = tool === "browser_open" && args && typeof args === "object" ? (args as { url?: unknown }).url : undefined;
    const mcpApp = tool === "mcp_call"
      ? stringField(args, "app")
      : category === "mcp" ? options.mcpApp?.(taskId, tool) ?? undefined : undefined;
    return hitRule(userId, taskId, tool, args, rules, typeof browserUrl === "string" ? browserUrl : undefined, mcpApp);
  }
  function hitRule(userId: string, taskId: string, tool: string, args: unknown, rules: ReturnType<ReturnType<typeof approvalRuleRepository>["active"]>, browserUrl: string | undefined, mcpApp: string | undefined): boolean {
    const now = Date.now();
    const scope = userScope(userId);
    for (const rule of rules) {
      if (!ruleMatches(rule, { now, tool, args, browserUrl, mcpApp })) continue;
      approvalRuleRepository(options.db).recordHit(scope, rule.id, new Date(now));
      auditRepository(options.db).write(adminScope(userId), "approval.rule_hit", rule.id, { ruleId: rule.id, taskId, tool });
      return true;
    }
    return false;
  }
  return { bind, arm, decide };
}

function stringField(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
