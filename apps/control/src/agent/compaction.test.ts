import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { createBot } from "../bot-service.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { encrypt, loadOrCreateKey } from "../crypto.js";
import { chatRepository } from "../db/chat.js";
import { eventRepository } from "../db/events.js";
import { openDatabase } from "../db/index.js";
import { secretRepository } from "../db/secrets.js";
import { ensureDevUser } from "../db/users.js";
import { createRuntime } from "../compose.js";
import { ulid } from "../id.js";
import { userScope } from "../scope.js";
import { estimateTextTokens } from "./compact.js";
import { storedContent } from "./view.js";

const cleanups: Array<() => Promise<void>> = [];
const SECRET = "p@ss-VALUE-99";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      void Promise.resolve(handler(req, res, Buffer.concat(chunks).toString("utf8"))).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return port;
}

function textSse(text: string, prompt = 1, completion = 1): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: prompt, completion_tokens: completion } })}\n\ndata: [DONE]\n\n`;
}

function toolSse(prompt: number, completion: number): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "shell_exec", arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ cmd: "echo kept" }) } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: prompt, completion_tokens: completion } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function execSse(stdout: string): string {
  return `data: ${JSON.stringify({ type: "stdout", data: stdout })}\n\ndata: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`;
}

async function opened(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "vb-compact-"));
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "super-secret-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
    ...env,
  });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const ctx: ControlContext = { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
  ensureDevUser(ctx.db, "user-a");
  cleanups.push(async () => {
    ctx.db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { config, ctx };
}

async function appFor(ctx: ControlContext, config: ControlConfig, prepare: { host: string; port: number; token: string }) {
  const app = buildApp(ctx, {
    retryDelays: [0, 0],
    ensureMachine: async () => {},
    prepareEndpoint: async (_userId, onPhase) => {
      onPhase("ready");
      return prepare;
    },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  cleanups.push(close);
  await app.ready();
  const runtime = createRuntime(config, ctx.db);
  return { app, close, service: chatService(app), runtime };
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

describe("context summary", () => {
  it.each(["steer", "queue"] as const)("does not cover an un-summarized %s instruction with a later persisted tool result", async (mode) => {
    let tick = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => tick++);
    try {
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const { promise: firstRequest, resolve: started } = Promise.withResolvers<void>();
      const bodies: string[] = [];
      const directive = "NEW-DIRECTIVE-do-backup-not-delete";
      let chats = 0;
      const modelPort = await listen(async (_req, res, body) => {
        bodies.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (body.includes("你是对话压缩器")) {
          res.end(textSse(body.includes(directive) ? `旧目标；${directive}` : "旧目标和已完成的工具操作"));
          return;
        }
        chats += 1;
        if (chats === 1) { started(); await gate; }
        res.end(chats <= 2 ? toolSse(6000, 10) : textSse("完成"));
      });
      let tools = 0;
      const machinePort = await listen((req, res) => {
        if (req.url !== "/exec") {
          res.writeHead(404);
          res.end();
          return;
        }
        tools += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(execSse(tools === 1 ? "工具结果".repeat(1750) : "末次结果"));
      });
      const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MODEL_CONTEXT_TOKENS: "8000" });
      const first = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "t" });
      const scope = userScope("user-a");
      const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: first.runtime.credentials, providerId: first.runtime.identity.id }, scope, { name: "Ada", model: "gpt-test" });
      ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
      const sent = await first.service.send({ userId: "user-a", botId: bot.id, text: "旧目标", mode: "queue" });
      await firstRequest;
      try {
        await first.service.send({ userId: "user-a", botId: bot.id, conversationId: sent.conversationId, text: directive, mode });
      } finally {
        release();
      }
      await first.service.idle();
      expect(chatRepository(ctx.db).readSummary(scope, sent.conversationId)).toBeDefined();
      await first.close();
      const restarted = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "t" });
      await restarted.service.send({ userId: "user-a", botId: bot.id, conversationId: sent.conversationId, text: "继续", mode: "queue" });
      await restarted.service.idle();
      expect(bodies.at(-1)).toContain(directive);
    } finally {
      clock.mockRestore();
    }
  });

  it("restores the stored summary and every uncovered message beyond the 500-row UI window", async () => {
    const bodies: string[] = [];
    const modelPort = await listen((_req, res, body) => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("恢复完成"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "t" });
    const scope = userScope("user-a");
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, scope, { name: "Ada", model: "gpt-test" });
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "长历史" });
    if (!conversation) throw new Error("no conversation");
    let anchor = "";
    for (let index = 0; index < 503; index += 1) {
      const text = index === 0 ? "COVERED-RAW" : index === 1 ? "UNCOVERED-FIRST" : `tail-${index}`;
      const id = ulid(1_700_000_000_000 + index);
      if (index === 0) anchor = id;
      chat.insertMessage(scope, { id, conversationId: conversation.id, role: "user", contentJson: storedContent({ role: "user", content: text, timestamp: index }, text), taskId: null });
    }
    chat.saveSummary(scope, conversation.id, "STORED-SUMMARY-CHECKPOINT", anchor);
    await service.send({ userId: "user-a", botId: bot.id, text: "继续", mode: "queue", conversationId: conversation.id });
    await service.idle();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("STORED-SUMMARY-CHECKPOINT");
    expect(bodies[0]).toContain("UNCOVERED-FIRST");
    expect(bodies[0]).toContain("tail-502");
    expect(bodies[0]).not.toContain("COVERED-RAW");
  });

  it("does not summarize a short transcript", async () => {
    const bodies: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("好"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "t" });
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      userScope("user-a"),
      { name: "Ada", model: "gpt-test" },
    );
    await service.send({ userId: "user-a", botId: bot.id, text: "短消息", mode: "queue" });
    await service.idle();
    expect(bodies.some((body) => body.includes("你是对话压缩器"))).toBe(false);
    const conversationId = chatRepository(ctx.db).listConversations(userScope("user-a"), bot.id)?.[0]?.id;
    expect(conversationId).toBeTruthy();
    const task = chatRepository(ctx.db).listTasks(userScope("user-a"), conversationId ?? "")?.[0];
    expect(task?.state).toBe("succeeded");
  });

  it("summarizes when over the threshold, then reuses and extends the stored summary", async () => {
    const bodies: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (body.includes("你是对话压缩器")) {
        res.end(textSse(`摘要甲-固定\n{{secret:site_password}}\n${SECRET}`, 50, 20));
        return;
      }
      if (body.includes("以下是较早对话的摘要") || body.includes("kept-result") || body.includes("MID-ONLY") || body.includes("再补一句")) {
        res.end(textSse(body.includes("MID-ONLY") ? "第二段完成" : body.includes("再补一句") ? "续上了" : "先到这里", 80, 5));
        return;
      }
      res.end(toolSse(4800, 10));
    });
    const machinePort = await listen(async (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(req.url === "/exec" ? execSse("kept-result") : "");
    });
    const { config, ctx } = await opened({
      VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      VB_MODEL_CONTEXT_TOKENS: "8000",
      VB_MAX_TASK_STEPS: "2",
    });
    const scope = userScope("user-a");
    secretRepository(ctx.db).upsert(scope, {
      id: ulid(),
      name: "site_password",
      valueEnc: encrypt(ctx.key, SECRET),
      scope: "browser",
    });
    const first = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: first.runtime.credentials, providerId: first.runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "压缩" });
    if (!conversation) throw new Error("no conversation");
    const oldUser: UserMessage = { role: "user", content: "早期目标 OLD-GOAL", timestamp: 1 };
    const oldAssistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-old", name: "shell_exec", arguments: { cmd: "echo old" } }],
      api: "openai-completions",
      provider: "viate-bot",
      model: "gpt-test",
      usage: zeroUsage(),
      stopReason: "toolUse",
      timestamp: 2,
    };
    const oldTool: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-old",
      toolName: "shell_exec",
      content: [
        { type: "text", text: `OLD-RESULT-UNIQUE {{secret:site_password}} ${SECRET}\n${"甲".repeat(400)}` },
        { type: "image", data: "AAAAIMAGE", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 3,
    };
    const seeded = [
      ["user", oldUser, "早期目标 OLD-GOAL"],
      ["assistant", oldAssistant, ""],
      ["toolResult", oldTool, "OLD-RESULT-UNIQUE"],
    ] as const;
    for (const [index, [role, message, text]] of seeded.entries()) {
      chat.insertMessage(scope, {
        id: ulid(1_700_000_000_000 + index),
        conversationId: conversation.id,
        role,
        contentJson: storedContent(message, text),
        taskId: null,
      });
    }
    const seededTokens = estimateTextTokens([oldUser, oldAssistant, oldTool, { role: "user", content: "现在改成 NEW-GOAL", timestamp: 4 }]);
    expect(seededTokens).toBeLessThan(4800);

    await first.service.send({ userId: "user-a", botId: bot.id, text: "现在改成 NEW-GOAL", mode: "queue", conversationId: conversation.id });
    await first.service.idle();

    const summaries = bodies.filter((body) => body.includes("你是对话压缩器"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("OLD-RESULT-UNIQUE");
    expect(summaries[0]).toContain("id=call-old");
    expect(summaries[0]).toContain("（一张图片，已省略）");
    expect(summaries[0]).toContain("{{secret:site_password}}");
    expect(summaries[0]).not.toContain("AAAAIMAGE");
    expect(summaries[0]).not.toContain(SECRET);
    const summaryRequest: unknown = JSON.parse(summaries[0] ?? "{}");
    if (!summaryRequest || typeof summaryRequest !== "object" || !("max_tokens" in summaryRequest) || typeof summaryRequest.max_tokens !== "number") {
      throw new Error("summary request has no numeric max_tokens");
    }
    const summaryLimit = summaryRequest.max_tokens;
    expect(summaryLimit).toBeGreaterThan(0);
    expect(summaryLimit).toBeLessThanOrEqual(config.summaryMaxTokens);
    expect(summaries[0]).not.toContain("已有摘要：");
    const answered = bodies.filter((body) => body.includes("以下是较早对话的摘要"));
    expect(answered.length).toBeGreaterThan(0);
    const kept = answered[0] ?? "";
    expect(kept).toContain("摘要甲-固定");
    expect(kept).toContain("NEW-GOAL");
    expect(kept).toContain("kept-result");
    expect(kept).toContain("call_1");
    expect(kept).not.toContain("OLD-RESULT-UNIQUE");
    expect(kept).not.toContain(SECRET);
    const stored = chat.readSummary(scope, conversation.id);
    expect(stored?.text).toContain("摘要甲-固定");
    expect(stored?.text).toContain("{{secret:site_password}}");
    expect(stored?.text).not.toContain(SECRET);
    const rows = chat.listMessages(scope, conversation.id) ?? [];
    expect(rows.some((row) => row.contentJson.includes("OLD-RESULT-UNIQUE"))).toBe(true);
    const task = chat.listTasks(scope, conversation.id)?.[0];
    expect(task?.state).toBe("succeeded");
    expect(task?.error).toBeNull();
    expect(task?.usageJson).toContain("4965");
    const steps = chat.listSteps(scope, task?.id ?? "") ?? [];
    expect(steps.some((step) => step.kind === "compact" && step.requestJson.includes("已压缩较早的上下文"))).toBe(true);
    const summaryEvent = eventRepository(ctx.db).listByBot(bot.id).find((event) => event.attrsJson.includes('"inputTokens":50'));
    expect(summaryEvent?.attrsJson).toContain('"outputTokens":20');
    expect(rows.some((row) => row.contentJson.includes("已达到步数上限"))).toBe(false);
    expect(rows.some((row) => row.contentJson.includes("先到这里"))).toBe(true);

    await first.close();
    const summaryCalls = summaries.length;
    const restarted = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    await restarted.service.send({ userId: "user-a", botId: bot.id, text: "再补一句", mode: "queue", conversationId: conversation.id });
    await restarted.service.idle();
    expect(bodies.filter((body) => body.includes("你是对话压缩器"))).toHaveLength(summaryCalls);
    expect(bodies.at(-1)).toContain("摘要甲-固定");
    expect(bodies.at(-1)).toContain("再补一句");

    await restarted.service.send({
      userId: "user-a",
      botId: bot.id,
      text: `MID-ONLY\n${"乙".repeat(21_000)}`,
      mode: "queue",
      conversationId: conversation.id,
    });
    await restarted.service.idle();
    const second = bodies.filter((body) => body.includes("你是对话压缩器")).at(-1) ?? "";
    expect(bodies.filter((body) => body.includes("你是对话压缩器"))).toHaveLength(summaryCalls + 1);
    expect(second).toContain("已有摘要：");
    expect(second).toContain("摘要甲-固定");
    expect(second).toContain("kept-result");
    expect(second).not.toContain("OLD-RESULT-UNIQUE");
  });

  it("drops the oldest messages when the summary call fails", async () => {
    const bodies: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      if (body.includes("你是对话压缩器")) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("upstream down");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("继续完成"));
    });
    const { config, ctx } = await opened({
      VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      VB_MODEL_CONTEXT_TOKENS: "4000",
    });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "t" });
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "失败" });
    if (!conversation) throw new Error("no conversation");
    const bulkyText = `丢掉我\n${"丙".repeat(10_500)}`;
    const bulky: UserMessage = { role: "user", content: bulkyText, timestamp: 1 };
    chat.insertMessage(scope, {
      id: ulid(1_700_000_000_000),
      conversationId: conversation.id,
      role: "user",
      contentJson: storedContent(bulky, bulkyText),
      taskId: null,
    });
    await service.send({ userId: "user-a", botId: bot.id, text: "KEEP-ME", mode: "queue", conversationId: conversation.id });
    await service.idle();
    expect(bodies.some((body) => body.includes("你是对话压缩器"))).toBe(true);
    expect(bodies.some((body) => body.includes("已省略") && body.includes("KEEP-ME"))).toBe(true);
    const task = chat.listTasks(scope, conversation.id)?.[0];
    expect(task?.state).toBe("succeeded");
    expect(chat.listMessages(scope, conversation.id)?.some((row) => row.contentJson.includes("丢掉我"))).toBe(true);
    expect(chat.listMessages(scope, conversation.id)?.some((row) => row.contentJson.includes("继续完成"))).toBe(true);
  });

  it("compacts once and retries when the provider reports context overflow", async () => {
    const bodies: string[] = [];
    let chats = 0;
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      if (body.includes("你是对话压缩器")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(textSse("摘要甲-固定"));
        return;
      }
      chats += 1;
      if (chats === 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Your input exceeds the context window of this model" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("重试成功"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "t" });
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "溢出" });
    if (!conversation) throw new Error("no conversation");
    const earlyText = "EVICT-ME";
    const early: UserMessage = { role: "user", content: earlyText, timestamp: 1 };
    chat.insertMessage(scope, {
      id: ulid(1_700_000_000_000),
      conversationId: conversation.id,
      role: "user",
      contentJson: storedContent(early, earlyText),
      taskId: null,
    });
    await service.send({ userId: "user-a", botId: bot.id, text: "KEEP-OVERFLOW", mode: "queue", conversationId: conversation.id });
    await service.idle();
    expect(chats).toBe(2);
    expect(bodies.filter((body) => body.includes("你是对话压缩器"))).toHaveLength(1);
    expect(bodies.at(-1)).toContain("摘要甲-固定");
    expect(bodies.at(-1)).toContain("KEEP-OVERFLOW");
    const task = chat.listTasks(scope, conversation.id)?.[0];
    expect(task?.state).toBe("succeeded");
    expect(chat.listMessages(scope, conversation.id)?.some((row) => row.contentJson.includes("重试成功"))).toBe(true);
  });
});
