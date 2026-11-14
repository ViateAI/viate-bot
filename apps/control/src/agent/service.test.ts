import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { createBot } from "../bot-service.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { chatRepository } from "../db/chat.js";
import { openDatabase } from "../db/index.js";
import { ensureDevUser } from "../db/users.js";
import { createRuntime } from "../compose.js";
import { ulid } from "../id.js";
import { setToolHooks } from "./hooks.js";
import { recoverInterruptedTasks } from "./service.js";
import { storedContent } from "./view.js";
import { userScope } from "../scope.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  setToolHooks({});
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

function textSse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
}

function toolSse(args: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "shell_exec", arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

async function opened(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "vb-task-"));
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "super-secret-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
    ...env,
  });
  const ctx = contextFor(config);
  ensureDevUser(ctx.db, "user-a");
  ensureDevUser(ctx.db, "user-b");
  cleanups.push(async () => {
    ctx.db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { config, ctx };
}

async function appFor(
  ctx: ControlContext,
  config: ControlConfig,
  prepare: { host: string; port: number; token: string },
) {
  const app = buildApp(ctx, {
    retryDelays: [0, 0],
    ensureMachine: async () => {},
    prepareEndpoint: async (_userId, onPhase) => {
      onPhase("ready");
      return prepare;
    },
  });
  cleanups.push(() => app.close());
  await app.ready();
  const runtime = createRuntime(config, ctx.db);
  return { app, service: chatService(app), runtime };
}

describe("task runner", () => {
  it("round-robins users when the global cap is one", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const port = await listen(async (_req, res, body) => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: string | null }> };
      const last = [...parsed.messages].reverse().find((message) => message.role === "user");
      started.push(typeof last?.content === "string" ? last.content : "");
      await new Promise<void>((resolve) => releases.push(resolve));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("好"));
    });
    const { config, ctx } = await opened({
      VB_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
      VB_MAX_RUNNING_TASKS: "1",
      VB_DEFAULT_MAX_CONCURRENT_TASKS: "5",
    });
    const { app, service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "t" });
    const deps = { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id };
    const a1 = await createBot(deps, userScope("user-a"), { name: "A1", model: "gpt-test" });
    const a2 = await createBot(deps, userScope("user-a"), { name: "A2", model: "gpt-test" });
    const b1 = await createBot(deps, userScope("user-b"), { name: "B1", model: "gpt-test" });
    await service.send({ userId: "user-a", botId: a1.id, text: "A1", mode: "queue" });
    await waitFor(() => started.length === 1);
    await service.send({ userId: "user-b", botId: b1.id, text: "B1", mode: "queue" });
    await service.send({ userId: "user-a", botId: a2.id, text: "A2", mode: "queue" });
    await delay(80);
    expect(started).toEqual(["A1"]);
    releases.shift()?.();
    await waitFor(() => started.length === 2);
    expect(started).toEqual(["A1", "B1"]);
    releases.shift()?.();
    await waitFor(() => started.length === 3);
    expect(started).toEqual(["A1", "B1", "A2"]);
    releases.shift()?.();
    await service.idle();
    await app.close();
  });

  it("steers into the next model call and follows up only after the task would stop", async () => {
    const bodies: string[] = [];
    let releaseTool: () => void = () => {};
    const toolHeld = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") {
        await toolHeld;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      const tool = !body.includes("exit=") && !body.includes("改口了") && !body.includes("稍后");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(tool ? toolSse(JSON.stringify({ cmd: "true" })) : textSse(body.includes("稍后") ? "第二段" : "第一段"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      userScope("user-a"),
      { name: "Ada", model: "gpt-test" },
    );
    const first = service.send({ userId: "user-a", botId: bot.id, text: "跑一下", mode: "queue" });
    await waitFor(() => bodies.length === 1);
    await service.send({ userId: "user-a", botId: bot.id, text: "改口了", mode: "steer" });
    releaseTool();
    await first;
    await service.idle();
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies[1]).toContain("改口了");

    const followBodies: string[] = [];
    let releaseFollow: () => void = () => {};
    const followHeld = new Promise<void>((resolve) => {
      releaseFollow = resolve;
    });
    const followMachine = await listen(async (req, res) => {
      if (req.url === "/exec") {
        await followHeld;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ type: "stdout", data: "out\n" })}\n\ndata: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const followModel = await listen(async (_req, res, body) => {
      followBodies.push(body);
      const firstCall = !body.includes("exit=");
      const follow = body.includes("稍后");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(firstCall ? toolSse(JSON.stringify({ cmd: "echo" })) : textSse(follow ? "第二段" : "第一段"));
    });
    const again = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${followModel}/v1` });
    const followApp = await appFor(again.ctx, again.config, { host: "127.0.0.1", port: followMachine, token: "machine" });
    const followBot = await createBot(
      { db: again.ctx.db, key: again.ctx.key, credentials: followApp.runtime.credentials, providerId: followApp.runtime.identity.id },
      userScope("user-a"),
      { name: "Ada", model: "gpt-test" },
    );
    const running = followApp.service.send({ userId: "user-a", botId: followBot.id, text: "跑一下", mode: "queue" });
    await waitFor(() => followBodies.length === 1);
    await followApp.service.send({ userId: "user-a", botId: followBot.id, text: "稍后", mode: "queue" });
    releaseFollow();
    await running;
    await followApp.service.idle();
    expect(followBodies.length).toBe(3);
    expect(followBodies[1]).not.toContain("稍后");
    expect(followBodies[2]).toContain("稍后");
  });

  it("cancels a running task when the user stops it", async () => {
    let modelCalls = 0;
    let sawExec = false;
    const machinePort = await listen(async (req, res) => {
      if (req.url !== "/exec") {
        res.writeHead(404);
        res.end();
        return;
      }
      sawExec = true;
      await new Promise<void>((resolve) => req.socket.on("close", () => resolve()));
      if (!res.headersSent) res.end();
    });
    const modelPort = await listen(async (_req, res) => {
      modelCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(toolSse(JSON.stringify({ cmd: "sleep 30" })));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      userScope("user-a"),
      { name: "Ada", model: "gpt-test" },
    );
    const sent = service.send({ userId: "user-a", botId: bot.id, text: "请停下来", mode: "queue" });
    await waitFor(() => sawExec);
    expect(service.stop(userScope("user-a"), (await sent).taskId)).toBe(true);
    await service.idle();
    const task = chatRepository(ctx.db).findTask(userScope("user-a"), (await sent).taskId);
    expect(task?.state).toBe("cancelled");
    expect(modelCalls).toBe(1);
  });

  it("marks a restarted tool call interrupted and does not run it again", async () => {
    let execs = 0;
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") execs += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
    });
    const modelPort = await listen(async (_req, res, body) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse(body.includes("执行被中断") ? "已从中断处继续，没有重跑命令。" : "不该先说话"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "恢复" });
    if (!conversation) throw new Error("no conversation");
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.updateTask(scope, task.id, { state: "running", startedAt: new Date().toISOString() });
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "shell_exec", arguments: { cmd: "uname -a && id" } }],
      api: "openai-completions",
      provider: "viate-bot",
      model: "gpt-test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
    chat.insertMessage(scope, {
      id: ulid(),
      conversationId: conversation.id,
      role: "assistant",
      contentJson: storedContent(assistant, ""),
      taskId: task.id,
    });
    chat.insertStep(scope, {
      id: ulid(),
      taskId: task.id,
      seq: 1,
      kind: "tool",
      status: "running",
      requestJson: JSON.stringify({ name: "shell_exec", args: { cmd: "uname -a && id" }, toolCallId: "call_1" }),
    });
    expect(recoverInterruptedTasks(ctx.db)).toBe(1);
    expect(chat.findTask(scope, task.id)?.state).toBe("interrupted");
    const messages = chat.listMessages(scope, conversation.id) ?? [];
    expect(messages.filter((message) => message.contentJson.includes("执行被中断，结果未知"))).toHaveLength(1);
    expect(recoverInterruptedTasks(ctx.db)).toBe(0);
    expect(chat.listMessages(scope, conversation.id)?.filter((message) => message.contentJson.includes("执行被中断，结果未知"))).toHaveLength(1);
    const { service } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    await service.send({ userId: "user-a", botId: bot.id, text: "继续", mode: "queue", conversationId: conversation.id });
    await service.idle();
    expect(execs).toBe(0);
    const after = chat.listMessages(scope, conversation.id) ?? [];
    expect(after.some((message) => message.contentJson.includes("已从中断处继续，没有重跑命令。"))).toBe(true);
  });

  it("lets a beforeToolCall hook block execution", async () => {
    let execs = 0;
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") execs += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
    });
    const modelPort = await listen(async (_req, res, body) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body.includes("Tool execution was blocked") || body.includes("不要执行") ? textSse("没跑") : toolSse(JSON.stringify({ cmd: "true" })));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    setToolHooks({
      beforeToolCall: async () => ({ block: true, reason: "不要执行" }),
    });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      userScope("user-a"),
      { name: "Ada", model: "gpt-test" },
    );
    await service.send({ userId: "user-a", botId: bot.id, text: "跑一下", mode: "queue" });
    await service.idle();
    expect(execs).toBe(0);
  });
});

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await delay(20);
  }
}
