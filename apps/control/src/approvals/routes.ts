import type { FastifyInstance } from "fastify";
import { authenticated } from "../auth.js";
import { approvalRuleRepository, ruleExpiry } from "../db/approval-rules.js";
import type { AppDatabase } from "../db/index.js";
import { readBotSettings } from "../m2/risk.js";
import { userScope } from "../scope.js";
import type { ApprovalGate } from "./gate.js";
import { parseRuleMatch, ruleFromApproval } from "./rules.js";

export function registerApprovalRoutes(app: FastifyInstance, deps: { db: AppDatabase; gate: ApprovalGate }) {
  app.get("/api/approvals", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const rows = deps.db.$client.prepare(`select a.id, a.task_id as taskId, a.tool, a.summary, a.args_json as argsJson
      from approvals a join tasks t on t.id=a.task_id join bots b on b.id=t.bot_id
      where b.user_id=? and a.state='pending'`).all(auth.user.id) as Array<{ id: string; taskId: string; tool: string; summary: string; argsJson: string }>;
    return { approvals: rows.map(({ argsJson, ...row }) => ({ ...row, args: JSON.parse(argsJson) as unknown })) };
  });
  app.post<{ Params: { id: string } }>("/api/approvals/:id/decide", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const decision = (request.body as { decision?: unknown } | null)?.decision;
    if (decision !== "allow" && decision !== "deny") return reply.code(400).send({ error: "无效的决定" });
    const result = deps.gate.decide(auth.user.id, request.params.id, decision);
    if (result === "not_found") return reply.code(404).send({ error: "找不到审批" });
    if (result === "decided") return reply.code(409).send({ error: "审批已结束" });
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>("/api/bots/:id/approval-settings", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const bot = deps.db.$client.prepare("select settings_json from bots where id=? and user_id=? and deleted_at is null")
      .get(request.params.id, auth.user.id) as { settings_json: string } | undefined;
    if (!bot) return reply.code(404).send({ error: "找不到 bot" });
    return readBotSettings(bot.settings_json);
  });
  app.put<{ Params: { id: string } }>("/api/bots/:id/approval-settings", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const bot = deps.db.$client.prepare("select settings_json from bots where id=? and user_id=? and deleted_at is null")
      .get(request.params.id, auth.user.id) as { settings_json: string } | undefined;
    if (!bot) return reply.code(404).send({ error: "找不到 bot" });
    const body = request.body as { alwaysAllow?: unknown; approveNone?: unknown } | null;
    const allowed: Record<string, true> = {
      bulk_delete: true,
      shell: true,
      browser: true,
      desktop: true,
      fs_write: true,
      mcp: true,
      risky_tool: true,
    };
    const allowList = Array.isArray(body?.alwaysAllow) ? body.alwaysAllow : undefined;
    const hasNone = typeof body?.approveNone === "boolean";
    if (!allowList && !hasNone) return reply.code(400).send({ error: "无效的审批设置" });
    if (allowList?.some((item: unknown) => typeof item !== "string" || allowed[item] !== true)) {
      return reply.code(400).send({ error: "无效的审批设置" });
    }
    let settings: Record<string, unknown> = {};
    try { const parsed: unknown = JSON.parse(bot.settings_json); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>; } catch { settings = {}; }
    if (allowList) settings.alwaysAllow = [...new Set(allowList.filter((item): item is string => typeof item === "string"))];
    if (hasNone) settings.approveNone = body?.approveNone === true;
    delete settings.approveShell;
    deps.db.$client.prepare("update bots set settings_json=?, updated_at=? where id=? and user_id=?")
      .run(JSON.stringify(settings), new Date().toISOString(), request.params.id, auth.user.id);
    return readBotSettings(JSON.stringify(settings));
  });
  app.get<{ Params: { id: string } }>("/api/bots/:id/approval-rules", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const rules = approvalRuleRepository(deps.db).list(userScope(auth.user.id), request.params.id);
    if (!rules) return reply.code(404).send({ error: "找不到 bot" });
    return { rules };
  });
  app.post<{ Params: { id: string } }>("/api/bots/:id/approval-rules", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const body = request.body as { category?: unknown; match?: unknown; permanent?: unknown; expiresAt?: unknown } | null;
    try {
      const parsed = parseRuleMatch(typeof body?.category === "string" ? body.category : "", body?.match);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const expiresAt = ruleExpiry(new Date(), typeof body?.expiresAt === "string" ? { expiresAt: body.expiresAt } : {});
      const rule = approvalRuleRepository(deps.db).create(userScope(auth.user.id), request.params.id, parsed.category, parsed.match, expiresAt, new Date());
      if (!rule) return reply.code(404).send({ error: "找不到 bot" });
      return reply.code(201).send({ rule });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "规则无效" });
    }
  });
  app.delete<{ Params: { id: string; ruleId: string } }>("/api/bots/:id/approval-rules/:ruleId", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const removed = approvalRuleRepository(deps.db).remove(userScope(auth.user.id), request.params.id, request.params.ruleId);
    if (!removed) return reply.code(404).send({ error: "找不到规则" });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/approvals/:id/rule", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const row = deps.db.$client.prepare(`select a.tool, a.args_json as argsJson, t.bot_id as botId, b.user_id as userId
      from approvals a join tasks t on t.id=a.task_id join bots b on b.id=t.bot_id
      where a.id=? and a.state='pending'`).get(request.params.id) as { tool: string; argsJson: string; botId: string; userId: string } | undefined;
    if (!row || row.userId !== auth.user.id) return reply.code(404).send({ error: "找不到审批" });
    const body = request.body as { expiresAt?: unknown } | null;
    let args: unknown;
    try { args = JSON.parse(row.argsJson) as unknown; } catch { return reply.code(400).send({ error: "审批参数无效" }); }
    const derived = ruleFromApproval(row.tool, args, undefined);
    if ("error" in derived) return reply.code(400).send({ error: derived.error });
    try {
      const expiresAt = ruleExpiry(new Date(), typeof body?.expiresAt === "string" ? { expiresAt: body.expiresAt } : {});
      const rule = approvalRuleRepository(deps.db).create(userScope(auth.user.id), row.botId, derived.category, derived.match, expiresAt, new Date());
      if (!rule) return reply.code(404).send({ error: "找不到 bot" });
      return reply.code(201).send({ rule });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "规则无效" });
    }
  });
}
