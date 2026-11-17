import type { FastifyInstance } from "fastify";
import { authenticated } from "../auth.js";
import type { AppDatabase } from "../db/index.js";
import { readBotSettings } from "../m2/risk.js";
import type { ApprovalGate } from "./gate.js";

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
    const body = request.body as { alwaysAllow?: unknown } | null;
    const allowed: Record<string, true> = {
      bulk_delete: true,
      shell: true,
      browser: true,
      desktop: true,
      fs_write: true,
      mcp: true,
      risky_tool: true,
    };
    if (!Array.isArray(body?.alwaysAllow) || body.alwaysAllow.some((item: unknown) => typeof item !== "string" || allowed[item] !== true)) {
      return reply.code(400).send({ error: "无效的审批设置" });
    }
    let settings: Record<string, unknown> = {};
    try { const parsed: unknown = JSON.parse(bot.settings_json); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>; } catch { settings = {}; }
    settings.alwaysAllow = [...new Set(body.alwaysAllow)];
    delete settings.approveShell;
    deps.db.$client.prepare("update bots set settings_json=?, updated_at=? where id=? and user_id=?")
      .run(JSON.stringify(settings), new Date().toISOString(), request.params.id, auth.user.id);
    return readBotSettings(JSON.stringify(settings));
  });
}
