import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { avatarFile } from "../agent/profile-tool.js";
import type { ChatService } from "../agent/service.js";
import { ChatError } from "../agent/service.js";
import { messageView, stepView, taskView } from "../agent/view.js";
import { taskRateWaiting } from "../model-rate.js";
import { redactMessage, redactMessages, redactStep, userShowsProcess } from "../agent/process-detail.js";
import { reportedElapsedMs } from "../task-limits.js";
import { authenticated } from "../auth.js";
import { BotRejected, createBot, deleteBot } from "../bot-service.js";
import type { ControlConfig } from "../config.js";
import { botRepository } from "../db/bots.js";
import { chatRepository, ConversationBusy } from "../db/chat.js";
import { acceptRemoteRisk } from "../agent/remote-uncertain.js";
import { remoteUncertain } from "../agent/remote-uncertain.js";
import type { AppDatabase } from "../db/index.js";
import { memoryRepository } from "../db/memories.js";
import { quotaRepository } from "../db/quotas.js";
import type { CredentialProvider } from "../providers.js";
import { userScope } from "../scope.js";
import type { UploadStorage } from "../uploads/storage.js";

export interface ChatRouteDeps {
  db: AppDatabase;
  config: ControlConfig;
  key: Buffer;
  chat: ChatService;
  credentials: CredentialProvider;
  providerId: string;
  ensureMachine: (userId: string) => Promise<void>;
  tasks: Map<string, { activeMs: number; segmentStartedAt: number | null }>;
  now: () => Date;
  uploads: UploadStorage;
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  const bots = botRepository(deps.db);
  const chat = chatRepository(deps.db);

  app.addHook("preHandler", async (request, reply) => {
    const path = request.routeOptions.url ?? "";
    if (path !== "/api/bots" && !path.startsWith("/api/bots/")) return;
    const resolved = authenticated.get(request);
    if (!resolved || quotaRepository(deps.db).find(userScope(resolved.user.id))) return;
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/api/bots") return reply.send({ bots: [] });
      return reply.code(404).send({ error: "找不到 bot" });
    }
    return reply.code(403).send({ error: "尚未开通，请联系管理员" });
  });

  app.get("/api/bots", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const busy = chat.busyBotIds(scope);
    const primaryId = bots.primaryId(scope);
    return { bots: bots.list(scope).map((bot) => ({ ...botView(bot, bot.id === primaryId), busy: busy.has(bot.id) })) };
  });

  app.post("/api/bots", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    if (!deps.config.allowNewBot) return reply.code(403).send({ error: "管理员已关闭自建 bot" });
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
          maxBots: (current) => {
            const quota = quotaRepository(deps.db).find(current);
            if (!quota) throw new BotRejected("尚未开通，请联系管理员", 403);
            return quota.maxBots;
          },
          ensureMachine: deps.ensureMachine,
        },
        scope,
        { name, model, ...(instructions !== undefined ? { instructions } : {}) },
      );
      return reply.code(201).send({ bot: botView(created, bots.primaryId(scope) === created.id) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const bot = bots.findById(scope, request.params.id);
    if (!bot) return reply.code(404).send({ error: "找不到 bot" });
    return { bot: botView(bot, bots.primaryId(scope) === bot.id) };
  });

  app.get<{ Params: { id: string } }>("/api/bots/:id/avatar", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const bot = bots.findById(scope, request.params.id);
    const path = bot?.avatar ? avatarFile(deps.config.dataDir, bot.id) : "";
    if (!bot?.avatar || !path || !existsSync(path)) return reply.code(404).send({ error: "找不到头像" });
    return reply.type(bot.avatar).send(readFileSync(path));
  });

  app.delete<{ Params: { id: string } }>("/api/bots/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    if (bots.primaryId(scope) === request.params.id) {
      return reply.code(409).send({ error: "主 bot 不能删除" });
    }
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

  app.get<{ Params: { id: string } }>("/api/bots/:id/memories", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const rows = memoryRepository(deps.db).list(scope, request.params.id);
    if (!rows) return reply.code(404).send({ error: "找不到 bot" });
    return { memories: rows.map((row) => ({ id: row.id, content: row.content, updatedAt: row.updatedAt })) };
  });

  app.delete<{ Params: { id: string; memoryId: string } }>("/api/bots/:id/memories/:memoryId", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const removed = memoryRepository(deps.db).remove(scope, request.params.id, request.params.memoryId);
    if (removed === undefined || removed === false) return reply.code(404).send({ error: "找不到记忆" });
    return { ok: true };
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

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    try {
      const uploadIds = chat.deleteConversation(scope, request.params.id);
      if (!uploadIds) return reply.code(404).send({ error: "找不到对话" });
      for (const uploadId of uploadIds) {
        await deps.uploads.remove(scope.userId, uploadId);
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof ConversationBusy) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const rows = chat.listMessages(scope, request.params.id);
    if (!rows) return reply.code(404).send({ error: "找不到对话" });
    const detail = userShowsProcess(deps.db, scope);
    const tasks = (chat.listTasks(scope, request.params.id) ?? []).map(taskView);
    return { messages: redactMessages(rows.map(messageView), tasks, detail) };
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/tasks", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const rows = chat.listTasks(scope, request.params.id);
    if (!rows) return reply.code(404).send({ error: "找不到对话" });
    return {
      tasks: rows.map((row) => ({
        ...taskView(row),
        waitingRate: taskRateWaiting(row.id),
        remoteUncertain: row.error === "remote_unconfirmed" && remoteUncertain(deps.db, scope.userId),
        elapsedMs: reportedElapsedMs(row.usageJson, deps.tasks.get(row.id), deps.now().getTime()),
      })),
      showProcess: userShowsProcess(deps.db, scope),
    };
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const row = chat.findMessage(scope, request.params.id);
    if (!row) return reply.code(404).send({ error: "找不到消息" });
    const view = messageView(row);
    if (userShowsProcess(deps.db, scope)) return { message: view };
    const tasks = (chat.listTasks(scope, row.conversationId) ?? []).map(taskView);
    const messages = (chat.listMessages(scope, row.conversationId) ?? []).map(messageView);
    const redacted = redactMessage(view, messages, tasks, false);
    if (!redacted) return reply.code(404).send({ error: "找不到消息" });
    return { message: redacted };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const row = chat.findTask(scope, request.params.id);
    if (!row) return reply.code(404).send({ error: "找不到任务" });
    return {
      task: {
        ...taskView(row),
        waitingRate: taskRateWaiting(row.id),
        remoteUncertain: remoteUncertain(deps.db, scope.userId),
        elapsedMs: reportedElapsedMs(row.usageJson, deps.tasks.get(row.id), deps.now().getTime()),
      },
    };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/steps", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const rows = chat.listSteps(scope, request.params.id);
    if (!rows) return reply.code(404).send({ error: "找不到任务" });
    const detail = userShowsProcess(deps.db, scope);
    return { steps: rows.map((row) => redactStep(stepView(row), detail)) };
  });

  app.post<{ Params: { id: string } }>("/api/bots/:id/messages", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const body = record(request.body);
    const text = typeof body.text === "string" ? body.text : "";
    const mode = body.mode === undefined ? "steer" : body.mode;
    if (mode !== "queue" && mode !== "steer") return reply.code(400).send({ error: "mode 只能是 queue 或 steer" });
    const uploadIds = body.uploadIds;
    if (uploadIds !== undefined && (!Array.isArray(uploadIds) || uploadIds.some((item) => typeof item !== "string"))) {
      return reply.code(400).send({ error: "uploadIds 必须是字符串数组" });
    }
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : undefined;
    try {
      const result = await deps.chat.send({
        userId: scope.userId,
        botId: request.params.id,
        text,
        mode,
        ...(Array.isArray(uploadIds) ? { uploadIds } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
      });
      return reply.code(202).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/secrets", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const body = record(request.body);
    const decision = body.decision === "provide" || body.decision === "reject" ? body.decision : undefined;
    if (!decision) return reply.code(400).send({ error: "decision 只能是 provide 或 reject" });
    const name = typeof body.name === "string" ? body.name : "";
    const value = typeof body.value === "string" ? body.value : undefined;
    const save = typeof body.save === "boolean" ? body.save : undefined;
    try {
      deps.chat.submitSecret(scope, request.params.id, {
        decision,
        name,
        ...(value !== undefined ? { value } : {}),
        ...(save !== undefined ? { save } : {}),
      });
      return { ok: true };
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

  app.post<{ Params: { id: string } }>("/api/tasks/:id/accept-remote-risk", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const task = chat.findTask(scope, request.params.id);
    if (!task || task.error !== "remote_unconfirmed") return reply.code(404).send({ error: "找不到任务" });
    if (!acceptRemoteRisk(deps.db, scope.userId, task.id)) return reply.code(409).send({ error: "没有未确认的远端执行" });
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

function botView(
  bot: { id: string; name: string; bio: string; avatar: string | null; model: string; instructions: string; updatedAt: string },
  primary = false,
) {
  return {
    id: bot.id,
    name: bot.name,
    bio: bot.bio,
    avatar: bot.avatar,
    model: bot.model,
    instructions: bot.instructions,
    updatedAt: bot.updatedAt,
    primary,
  };
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
