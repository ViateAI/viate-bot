import type { FastifyInstance } from "fastify";
import type { ChatService } from "../agent/service.js";
import { ChatError } from "../agent/service.js";
import { messageView, stepView, taskView } from "../agent/view.js";
import { authenticated } from "../auth.js";
import { BotRejected, createBot, deleteBot } from "../bot-service.js";
import type { ControlConfig } from "../config.js";
import { botRepository } from "../db/bots.js";
import { chatRepository } from "../db/chat.js";
import type { AppDatabase } from "../db/index.js";
import { quotaRepository } from "../db/quotas.js";
import type { CredentialProvider } from "../providers.js";
import { userScope } from "../scope.js";

export interface ChatRouteDeps {
  db: AppDatabase;
  config: ControlConfig;
  key: Buffer;
  chat: ChatService;
  credentials: CredentialProvider;
  providerId: string;
  ensureMachine: (userId: string) => Promise<void>;
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  const bots = botRepository(deps.db);
  const chat = chatRepository(deps.db);

  app.get("/api/bots", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    return { bots: bots.list(scope).map(botView) };
  });

  app.post("/api/bots", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const body = record(request.body);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
    if (!name || !model) return reply.code(400).send({ error: "需要名字和模型" });
    try {
      const created = await createBot(
        {
          db: deps.db,
          key: deps.key,
          credentials: deps.credentials,
          providerId: deps.providerId,
          allowModel: (candidate) => deps.config.models.length === 0 || deps.config.models.includes(candidate),
          maxBots: (current) => quotaRepository(deps.db).find(current)?.maxBots ?? deps.config.defaultMaxBots,
          ensureMachine: deps.ensureMachine,
        },
        scope,
        { name, model, ...(instructions !== undefined ? { instructions } : {}) },
      );
      return reply.code(201).send({ bot: botView(created) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const bot = bots.findById(scope, request.params.id);
    if (!bot) return reply.code(404).send({ error: "找不到 bot" });
    return { bot: botView(bot) };
  });

  app.delete<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    try {
      await deps.chat.cancelBot(scope, request.params.id);
      const ok = await deleteBot(
        { db: deps.db, key: deps.key, credentials: deps.credentials, providerId: deps.providerId },
        scope,
        request.params.id,
      );
      if (!ok) return reply.code(404).send({ error: "找不到 bot" });
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id/conversations", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const rows = chat.listConversations(scope, request.params.id);
    if (!rows) return reply.code(404).send({ error: "找不到 bot" });
    return { conversations: rows };
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const row = chat.findConversation(scope, request.params.id);
    if (!row) return reply.code(404).send({ error: "找不到对话" });
    return { conversation: row };
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const rows = chat.listMessages(scope, request.params.id);
    if (!rows) return reply.code(404).send({ error: "找不到对话" });
    return { messages: rows.map(messageView) };
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/tasks", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const rows = chat.listTasks(scope, request.params.id);
    if (!rows) return reply.code(404).send({ error: "找不到对话" });
    return { tasks: rows.map(taskView) };
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const row = chat.findMessage(scope, request.params.id);
    if (!row) return reply.code(404).send({ error: "找不到消息" });
    return { message: messageView(row) };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const row = chat.findTask(scope, request.params.id);
    if (!row) return reply.code(404).send({ error: "找不到任务" });
    return { task: taskView(row) };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/steps", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const rows = chat.listSteps(scope, request.params.id);
    if (!rows) return reply.code(404).send({ error: "找不到任务" });
    return { steps: rows.map(stepView) };
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/messages", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const body = record(request.body);
    const text = typeof body.text === "string" ? body.text : "";
    const mode = body.mode === undefined ? "queue" : body.mode;
    if (mode !== "queue" && mode !== "steer") return reply.code(400).send({ error: "mode 只能是 queue 或 steer" });
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : undefined;
    try {
      const result = await deps.chat.send({
        userId: scope.userId,
        botId: request.params.id,
        text,
        mode,
        ...(conversationId !== undefined ? { conversationId } : {}),
      });
      return reply.code(202).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/stop", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const ok = deps.chat.stop(scope, request.params.id);
    if (!ok) return reply.code(404).send({ error: "找不到任务" });
    return { ok: true };
  });

  app.get("/api/models", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    return { models: deps.config.models, unrestricted: deps.config.models.length === 0 };
  });
}

function scopeOf(request: { id?: string }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  const resolved = authenticated.get(request as never);
  if (!resolved) {
    reply.code(401).send({ error: "未登录" });
    return undefined;
  }
  return userScope(resolved.user.id);
}

function botView(bot: { id: string; name: string; model: string; instructions: string }) {
  return { id: bot.id, name: bot.name, model: bot.model, instructions: bot.instructions };
}

function record(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function sendError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof ChatError || error instanceof BotRejected) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  console.error("对话请求失败", error instanceof Error ? error.message : "unknown");
  return reply.code(500).send({ error: "请求失败" });
}
