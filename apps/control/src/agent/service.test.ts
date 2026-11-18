import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { loadTranscript, storedContent } from "./view.js";
import { argsHash } from "../m2/risk.js";
import { terminalErrorClass } from "../m2/events.js";
import { adminOverview } from "../ops/report.js";
import { userScope } from "../scope.js";
import { SESSION_COOKIE } from "../cookies.js";
import { createSession } from "../session.js";
import { createUserFlights } from "../screen/flight.js";
import { createTakeoverLeases } from "../screen/leases.js";
import { hasAttachedViewer } from "../screen/gateway.js";
import { markRemoteUncertain, remoteUncertain } from "./remote-uncertain.js";
import { showContinueButton } from "../task-limits.js";

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

function namedToolSse(name: string, args: string): string {
  return toolSse(args).replace("shell_exec", name);
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
  now?: () => Date,
) {
  const app = buildApp(ctx, {
    retryDelays: [0, 0],
    ...(now ? { now } : {}),
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

async function idleScreen() {
  const machine = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  const sockets = new WebSocketServer({ server: machine });
  const listening = once(machine, "listening");
  machine.listen(0, "127.0.0.1");
  await listening;
  const port = (machine.address() as AddressInfo).port;
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    const closed = once(machine, "close");
    machine.close();
    await closed;
  });
  const { config, ctx } = await opened({});
  const { app, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port, token: "machine" });
  const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "Screen", model: "gpt-test" });
  const session = createSession(ctx.db, ctx.key, "user-a", "refresh-token", new Date());
  const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, "x-vb-csrf": session.csrf, origin: config.publicUrl };
  const connected = once(sockets, "connection");
  const viewer = await app.injectWS(`/api/bots/${bot.id}/screen/vnc?socket=${ulid()}`, { headers });
  await connected;
  cleanups.push(async () => {
    if (viewer.readyState !== 3) {
      const closed = once(viewer, "close");
      viewer.terminate();
      await closed;
    }
  });
  return { app, ctx, viewer, headers };
}

describe("task runner", () => {
  it("does not execute the tool batch returned by an already exhausted model call", async () => {
    let execs = 0;
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") execs += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
    });
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(toolSse(JSON.stringify({ cmd: "touch /tmp/no-budget" })));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_TASK_TOKEN_BUDGET: "1" });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "Budget tools", model: "gpt-test" });
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ approveNone: true }), bot.id);
    const sent = await service.send({ userId: "user-a", botId: bot.id, text: "run", mode: "queue" });
    await service.idle();
    expect(chatRepository(ctx.db).findTask(userScope("user-a"), sent.taskId)?.state).toBe("failed");
    expect(execs).toBe(0);
  });

  it.each(["text", "tools", "mixed"])("bounds length continuation for %s without executing truncated tools", async (mode) => {
    let calls = 0;
    let execs = 0;
    const bodies: string[] = [];
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") execs += 1;
      res.writeHead(404);
      res.end();
    });
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      calls += 1;
      const tool = mode === "tools" || (mode === "mixed" && calls === 1);
      let response = tool ? toolSse(JSON.stringify({ cmd: "touch /tmp/must-not-run" })) : textSse("part");
      if (mode !== "mixed" || calls < 3) response = response.replace('"finish_reason":"tool_calls"', '"finish_reason":"length"').replace('"finish_reason":"stop"', '"finish_reason":"length"');
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(response);
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "Length", model: "gpt-test" });
    const sent = await service.send({ userId: "user-a", botId: bot.id, text: "finish", mode: "queue" });
    await service.idle();
    const task = chatRepository(ctx.db).findTask(userScope("user-a"), sent.taskId);
    expect(calls).toBe(3);
    expect(execs).toBe(0);
    expect(task?.state).toBe(mode === "mixed" ? "succeeded" : "failed");
    expect(task?.error).toBe(mode === "mixed" ? null : "模型输出达到上限");
    if (mode !== "text") expect(bodies[1]).toContain("上一条输出被截断，工具参数不完整，请缩短后重试");
    if (mode !== "tools") expect(bodies[2]).toContain("继续");
  });

  it.each([0, 2])("settles a normal stop against budget %i and resets budget for a new task", async (budget) => {
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("done"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_TASK_TOKEN_BUDGET: String(budget) });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "machine" });
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "Budget", model: "gpt-test" });
    for (let i = 0; i < 2; i += 1) {
      const sent = await service.send({ userId: "user-a", botId: bot.id, text: "finish", mode: "queue" });
      await service.idle();
      const task = chatRepository(ctx.db).findTask(userScope("user-a"), sent.taskId);
      expect(task?.state).toBe(budget ? "failed" : "succeeded");
      expect(task?.error).toBe(budget ? "已达到单任务 token 预算（已用 2 / 上限 2）" : null);
    }
  });

  it("does not count an approval wait toward the duration cap", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const now = () => new Date(nowMs);
    let calls = 0;
    const machinePort = await listen(async (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(req.url === "/exec" ? `data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n` : "");
    });
    const modelPort = await listen(async (_req, res) => {
      calls += 1;
      if (calls === 1) nowMs += 10_000;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(calls === 1 ? toolSse(JSON.stringify({ cmd: "echo hi" })) : textSse("做完了"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_DURATION_SEC: "30" });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" }, now);
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "Dur", model: "gpt-test" });
    const sent = await service.send({ userId: "user-a", botId: bot.id, text: "跑", mode: "queue" });
    await waitFor(() => !!ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(sent.taskId));
    nowMs += 120_000;
    const approval = ctx.db.$client.prepare("select id from approvals where task_id=?").get(sent.taskId) as { id: string };
    expect(service.approvalGate.decide("user-a", approval.id, "allow")).toBe("ok");
    await service.idle();
    const task = chatRepository(ctx.db).findTask(userScope("user-a"), sent.taskId);
    const usage = JSON.parse(task?.usageJson ?? "{}") as { activeMs?: number };
    expect(task?.state).toBe("succeeded");
    expect(usage.activeMs).toBeGreaterThanOrEqual(10_000);
    expect(usage.activeMs).toBeLessThan(30_000);
  });

  it("does not count a secret wait toward the duration cap", async () => {
    let nowMs = Date.parse("2026-01-03T00:00:00.000Z");
    const now = () => new Date(nowMs);
    let calls = 0;
    const machinePort = await listen(async (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(req.url === "/exec" ? `data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n` : "");
    });
    const modelPort = await listen(async (_req, res) => {
      calls += 1;
      if (calls === 1) nowMs += 10_000;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(calls === 1 ? namedToolSse("request_secret", JSON.stringify({ name: "site_password", label: "密码", kind: "password", reason: "登录" })) : textSse("做完了"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_DURATION_SEC: "30" });
    const { app, service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" }, now);
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "SecretDur", model: "gpt-test" });
    const session = createSession(ctx.db, ctx.key, "user-a", "refresh-secret", now());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, "x-vb-csrf": session.csrf, origin: config.publicUrl, "content-type": "application/json" };
    const sent = await service.send({ userId: "user-a", botId: bot.id, text: "登录", mode: "queue" });
    await waitFor(() => chatRepository(ctx.db).findTask(userScope("user-a"), sent.taskId)?.state === "waiting_input");
    nowMs += 120_000;
    const posted = await app.inject({
      method: "POST",
      url: `/api/tasks/${sent.taskId}/secrets`,
      headers,
      payload: { decision: "provide", name: "site_password", value: "pw", save: false },
    });
    expect(posted.statusCode).toBe(200);
    await service.idle();
    const task = chatRepository(ctx.db).findTask(userScope("user-a"), sent.taskId);
    const usage = JSON.parse(task?.usageJson ?? "{}") as { activeMs?: number };
    expect(task?.state).toBe("succeeded");
    expect(usage.activeMs).toBeGreaterThanOrEqual(10_000);
    expect(usage.activeMs).toBeLessThan(30_000);
  });

  it("does not count a takeover wait toward the duration cap", async () => {
    let nowMs = Date.parse("2026-01-04T00:00:00.000Z");
    const now = () => new Date(nowMs);
    const view: { db?: ControlContext["db"]; conversationId?: string } = {};
    const modelPort = await listen(async (_req, res) => {
      const rows = view.db && view.conversationId
        ? view.db.$client.prepare("select content_json as contentJson from messages where conversation_id=? and role='toolResult'").all(view.conversationId) as Array<{ contentJson: string }>
        : [];
      if (!rows.some((row) => row.contentJson.includes("用户已交还屏幕"))) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("做完了"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_DURATION_SEC: "30" });
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, scope, { name: "TakeDur", model: "gpt-test" });
    const chat = chatRepository(ctx.db);
    view.db = ctx.db;
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "接管时长" });
    if (!conversation) throw new Error("no conversation");
    view.conversationId = conversation.id;
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.insertMessage(scope, {
      id: ulid(),
      conversationId: conversation.id,
      role: "assistant",
      contentJson: storedContent(toolCallMessage("request_takeover", "call_take", {}), ""),
      taskId: task.id,
    });
    ctx.db.$client.prepare("update tasks set state='waiting_takeover', started_at=?, usage_json=? where id=?").run(
      new Date(nowMs).toISOString(),
      JSON.stringify({ activeMs: 10_000, modelCalls: 1, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lengthContinuations: 0 }),
      task.id,
    );
    const session = createSession(ctx.db, ctx.key, "user-a", "refresh-take", now());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, "x-vb-csrf": session.csrf, origin: config.publicUrl, "content-type": "application/json" };
    const { app, service } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "machine" }, now);
    await waitFor(() => chat.findTask(scope, task.id)?.state === "waiting_takeover" && chat.findTask(scope, task.id)?.startedAt != null);
    nowMs += 120_000;
    const socketId = "abcdefghijklmnop";
    const viewer = await app.injectWS(`/api/bots/${bot.id}/screen/vnc?socket=${socketId}`, { headers: { cookie: headers.cookie, origin: config.publicUrl } });
    const lease = ctx.db.$client.prepare("select id from takeover_leases where task_id=? and state='requested'").get(task.id) as { id: string };
    expect((await app.inject({ method: "POST", url: `/api/bots/${bot.id}/screen/grant`, headers, payload: { leaseId: lease.id, socketId } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/bots/${bot.id}/screen/release`, headers, payload: { leaseId: lease.id } })).statusCode).toBe(200);
    await service.idle();
    viewer.close();
    const finished = chat.findTask(scope, task.id);
    const usage = JSON.parse(finished?.usageJson ?? "{}") as { activeMs?: number };
    expect(finished?.state).toBe("succeeded");
    expect(usage.activeMs).toBeGreaterThanOrEqual(10_000);
    expect(usage.activeMs).toBeLessThan(30_000);
  });

  it("keeps persisted running time across a restart and ignores the downtime", async () => {
    let nowMs = Date.parse("2026-01-02T00:00:00.000Z");
    const now = () => new Date(nowMs);
    const machinePort = await listen(async (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(req.url === "/exec" ? `data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n` : "");
    });
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("不该再叫模型"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_DURATION_SEC: "30" });
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, scope, { name: "Resume", model: "gpt-test" });
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "恢复时长" });
    if (!conversation) throw new Error("no conversation");
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.insertMessage(scope, {
      id: ulid(),
      conversationId: conversation.id,
      role: "assistant",
      contentJson: storedContent(toolCallMessage("shell_exec", "call-dur", { cmd: "echo dur" }), ""),
      taskId: task.id,
    });
    ctx.db.$client.prepare(
      "insert into approvals (id,task_id,tool,summary,args_json,state,args_hash) values ('apr-dur',?,'shell_exec','shell_exec',?,'pending',?)",
    ).run(task.id, JSON.stringify({ cmd: "echo dur" }), argsHash("shell_exec", { cmd: "echo dur", cwd: undefined, env: undefined }));
    ctx.db.$client.prepare("update tasks set state='waiting_approval', started_at=?, usage_json=? where id=?").run(
      new Date(nowMs - 3_600_000).toISOString(),
      JSON.stringify({ activeMs: 40_000, modelCalls: 1, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lengthContinuations: 0 }),
      task.id,
    );
    nowMs += 3_600_000;
    const { service } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" }, now);
    await waitFor(() => chat.findTask(scope, task.id)?.state === "waiting_approval" && chat.findTask(scope, task.id)?.startedAt != null);
    expect(service.approvalGate.decide("user-a", "apr-dur", "allow")).toBe("ok");
    await service.idle();
    const finished = chat.findTask(scope, task.id);
    expect(finished?.state).toBe("failed");
    expect(finished?.error).toBe("remote_unconfirmed");
    const messages = chat.listMessages(scope, conversation.id) ?? [];
    expect(messages.some((message) => message.contentJson.includes("已运行 40 秒，达到时长上限"))).toBe(true);
  });

  it("fails a long final reply that crosses the duration cap", async () => {
    let nowMs = Date.parse("2026-01-07T00:00:00.000Z");
    const now = () => new Date(nowMs);
    let calls = 0;
    const modelPort = await listen(async (_req, res) => {
      calls += 1;
      nowMs += 40_000;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("最终回复"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_DURATION_SEC: "30" });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "machine" }, now);
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "LongReply", model: "gpt-test" });
    const sent = await service.send({ userId: "user-a", botId: bot.id, text: "回答", mode: "queue" });
    await service.idle();
    const task = chatRepository(ctx.db).findTask(userScope("user-a"), sent.taskId);
    expect(calls).toBe(1);
    expect(task?.state).toBe("failed");
    expect(task?.error).toContain("达到时长上限");
    expect(task?.error).not.toContain("已停止");
  });

  it("stops a long tool at the duration cap and keeps that time after the live task is gone", async () => {
    let nowMs = Date.parse("2026-01-08T00:00:00.000Z");
    const now = () => new Date(nowMs);
    let calls = 0;
    let released = false;
    const machinePort = await listen(async (req, res) => {
      if (req.url !== "/exec") {
        res.writeHead(404);
        res.end();
        return;
      }
      nowMs += 40_000;
      await new Promise<void>((resolve) => req.on("close", () => resolve()));
      released = true;
      if (!res.headersSent) res.end();
    });
    const modelPort = await listen(async (_req, res) => {
      calls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(calls === 1 ? toolSse(JSON.stringify({ cmd: "sleep 99" })) : textSse("不该成功"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_DURATION_SEC: "30" });
    const { app, service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" }, now);
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "LongTool", model: "gpt-test" });
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
    const session = createSession(ctx.db, ctx.key, "user-a", "refresh-long-tool", now());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, origin: config.publicUrl };
    const sent = await service.send({ userId: "user-a", botId: bot.id, text: "跑很久", mode: "queue" });
    await service.idle();
    const task = chatRepository(ctx.db).findTask(userScope("user-a"), sent.taskId);
    const usage = JSON.parse(task?.usageJson ?? "{}") as { activeMs?: number };
    const listed = await app.inject({ method: "GET", url: `/api/conversations/${sent.conversationId}/tasks`, headers });
    expect(released).toBe(true);
    expect(calls).toBe(1);
    expect(task?.state).toBe("failed");
    expect(task?.error).toBe("remote_unconfirmed");
    const messages = chatRepository(ctx.db).listMessages(userScope("user-a"), sent.conversationId) ?? [];
    expect(messages.some((message) => message.contentJson.includes("达到时长上限"))).toBe(true);
    expect(usage.activeMs).toBeGreaterThanOrEqual(40_000);
    expect(listed.json().tasks[0].elapsedMs).toBe(usage.activeMs);
  });

  it.each(["before-headers", "cancel-failed"] as const)(
    "keeps remote_unconfirmed when the duration cap stops an unconfirmed shell (%s)",
    async (mode) => {
      let nowMs = Date.parse("2026-01-10T00:00:00.000Z");
      const now = () => new Date(nowMs);
      let execs = 0;
      let cancels = 0;
      const machinePort = await listen(async (req, res) => {
        if (req.url === "/exec/cancel") {
          cancels += 1;
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no" }));
          return;
        }
        if (req.url !== "/exec") {
          res.writeHead(404);
          res.end();
          return;
        }
        execs += 1;
        if (mode === "cancel-failed") {
          res.writeHead(200, { "content-type": "text/event-stream", "x-exec-id": "job-1" });
          res.flushHeaders();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        nowMs += 40_000;
        await new Promise<void>((resolve) => req.on("close", () => resolve()));
        if (!res.headersSent) res.end();
      });
      let followTools = 0;
      const modelPort = await listen(async (_req, res, body) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (body.includes("再写一次")) {
          followTools += 1;
          res.end(followTools === 1 ? toolSse(JSON.stringify({ cmd: "touch /tmp/no" })) : textSse("停"));
          return;
        }
        res.end(execs === 0 ? toolSse(JSON.stringify({ cmd: "sleep 99" })) : textSse("不该再叫"));
      });
      const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_DURATION_SEC: "30" });
      const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" }, now);
      const scope = userScope("user-a");
      const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, scope, { name: "Ada", model: "gpt-test" });
      const other = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, scope, { name: "Bea", model: "gpt-test" });
      ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
      ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), other.id);
      const sent = await service.send({ userId: "user-a", botId: bot.id, text: "跑很久", mode: "queue" });
      await service.idle();
      const task = chatRepository(ctx.db).findTask(scope, sent.taskId);
      const durationText = "已运行 40 秒，达到时长上限。回复“继续”可以接着做。";
      const messages = chatRepository(ctx.db).listMessages(scope, sent.conversationId) ?? [];
      const failed = ctx.db.$client.prepare("select attrs_json as attrs from events where type='task.failed'").all() as Array<{ attrs: string }>;
      const mark = ctx.db.$client.prepare("select user_id as userId, attrs_json as attrs from events where type='mcp.remote_unconfirmed'").get() as { userId: string; attrs: string } | undefined;
      expect(execs).toBe(1);
      expect(cancels).toBe(mode === "cancel-failed" ? 1 : 0);
      expect(task?.state).toBe("failed");
      expect(task?.error).toBe("remote_unconfirmed");
      expect(showContinueButton([{ state: task?.state ?? "", error: task?.error ?? null }])).toBe(false);
      expect(messages.some((message) => message.contentJson.includes(durationText))).toBe(true);
      expect(failed.map((row) => JSON.parse(row.attrs).errorClass)).toEqual([terminalErrorClass(durationText)]);
      expect(mark?.userId).toBe("user-a");
      expect(JSON.parse(mark?.attrs ?? "{}").taskId).toBe(sent.taskId);
      expect(remoteUncertain(ctx.db, "user-a")).toBe(true);
      const follow = await service.send({ userId: "user-a", botId: other.id, text: "再写一次", mode: "queue" });
      await service.idle();
      expect(execs).toBe(1);
      const followMessages = chatRepository(ctx.db).listMessages(scope, follow.conversationId) ?? [];
      expect(followMessages.some((message) => message.contentJson.includes("远端可能仍在执行"))).toBe(true);
    },
  );

  it("keeps the duration text and continue affordance when the shell stop is confirmed", async () => {
    let nowMs = Date.parse("2026-01-11T00:00:00.000Z");
    const now = () => new Date(nowMs);
    let cancels = 0;
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec/cancel") {
        cancels += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stopped: true }));
        return;
      }
      if (req.url !== "/exec") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "x-exec-id": "job-1" });
      res.flushHeaders();
      await new Promise((resolve) => setTimeout(resolve, 100));
      nowMs += 40_000;
      await new Promise<void>((resolve) => req.on("close", () => resolve()));
      if (!res.writableEnded) res.end();
    });
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(toolSse(JSON.stringify({ cmd: "sleep 99" })));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_DURATION_SEC: "30" });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" }, now);
    const scope = userScope("user-a");
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, scope, { name: "Ada", model: "gpt-test" });
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
    const sent = await service.send({ userId: "user-a", botId: bot.id, text: "跑很久", mode: "queue" });
    await service.idle();
    const task = chatRepository(ctx.db).findTask(scope, sent.taskId);
    const durationText = "已运行 40 秒，达到时长上限。回复“继续”可以接着做。";
    expect(cancels).toBe(1);
    expect(task?.state).toBe("failed");
    expect(task?.error).toBe(durationText);
    expect(showContinueButton([{ state: task?.state ?? "", error: task?.error ?? null }])).toBe(true);
    expect(remoteUncertain(ctx.db, "user-a")).toBe(false);
  });

  it("persists the open running interval when a stop cancels the task", async () => {
    let nowMs = Date.parse("2026-01-09T00:00:00.000Z");
    const now = () => new Date(nowMs);
    let sawExec = false;
    const machinePort = await listen(async (req, res) => {
      if (req.url !== "/exec") {
        res.writeHead(404);
        res.end();
        return;
      }
      nowMs += 4_000;
      sawExec = true;
      await new Promise<void>((resolve) => req.on("close", () => resolve()));
      if (!res.headersSent) res.end();
    });
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(toolSse(JSON.stringify({ cmd: "sleep 5" })));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_DURATION_SEC: "3600" });
    const { app, service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" }, now);
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "CancelTime", model: "gpt-test" });
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
    const session = createSession(ctx.db, ctx.key, "user-a", "refresh-cancel-time", now());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, origin: config.publicUrl };
    const sent = service.send({ userId: "user-a", botId: bot.id, text: "停", mode: "queue" });
    await waitFor(() => sawExec);
    expect(service.stop(userScope("user-a"), (await sent).taskId)).toBe(true);
    await service.idle();
    const task = chatRepository(ctx.db).findTask(userScope("user-a"), (await sent).taskId);
    const usage = JSON.parse(task?.usageJson ?? "{}") as { activeMs?: number };
    const listed = await app.inject({
      method: "GET",
      url: `/api/conversations/${(await sent).conversationId}/tasks`,
      headers,
    });
    expect(task?.state).toBe("cancelled");
    expect(task?.error ?? "").not.toContain("达到时长上限");
    expect(usage.activeMs).toBeGreaterThanOrEqual(4_000);
    expect(usage.activeMs).toBeLessThan(30_000);
    expect(listed.json().tasks[0].elapsedMs).toBe(usage.activeMs);
  });

  it("fails the task at the step cap and names how many steps were used", async () => {
    let calls = 0;
    const machinePort = await listen(async (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(req.url === "/exec" ? `data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n` : "");
    });
    const modelPort = await listen(async (_req, res) => {
      calls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(calls === 1 ? toolSse(JSON.stringify({ cmd: "echo step" })) : textSse("不该出现"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MAX_TASK_STEPS: "1" });
    const runtime = createRuntime(config, ctx.db);
    const { service } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "Steps", model: "gpt-test" });
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
    const sent = await service.send({ userId: "user-a", botId: bot.id, text: "跑", mode: "queue" });
    await service.idle();
    const task = chatRepository(ctx.db).findTask(userScope("user-a"), sent.taskId);
    expect(calls).toBe(1);
    expect(task?.state).toBe("failed");
    expect(task?.error).toBe("已用 1 步，达到步数上限。回复“继续”可以接着做。");
  });

  it.each(["logout", "disable"])("closes an idle screen viewer after %s", async (mode) => {
    const fixture = await idleScreen();
    if (mode === "logout") {
      const response = await fixture.app.inject({ method: "POST", url: "/auth/logout", headers: fixture.headers });
      expect(response.statusCode).toBe(200);
    } else {
      fixture.ctx.db.$client.prepare("update users set status='disabled' where id='user-a'").run();
      const response = await fixture.app.inject({ method: "GET", url: "/api/me", headers: fixture.headers });
      expect(response.statusCode).toBe(401);
    }
    await expect.poll(() => fixture.viewer.readyState).toBe(3);
    expect(hasAttachedViewer("user-a")).toBe(false);
  });

  it("removes a half-open screen viewer after a missed heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const fixture = await idleScreen();
      fixture.viewer.pong = () => {};
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(fixture.viewer.readyState).toBe(3));
      expect(hasAttachedViewer("user-a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks an approved shell if another task becomes remote_unconfirmed while approval waits", async () => {
    let execs = 0;
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") execs += 1;
      res.writeHead(req.url === "/exec" ? 200 : 404, { "content-type": "text/event-stream" });
      res.end(req.url === "/exec" ? `data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n` : "");
    });
    let calls = 0;
    const modelPort = await listen(async (_req, res) => {
      calls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(calls === 1 ? toolSse(JSON.stringify({ cmd: "touch /tmp/late" })) : textSse("完成"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const bot = await createBot({ db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id }, userScope("user-a"), { name: "Ada", model: "gpt-test" });
    const sent = await service.send({ userId: "user-a", botId: bot.id, text: "写文件", mode: "queue" });
    await waitFor(() => !!ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(sent.taskId));
    markRemoteUncertain(ctx.db, { userId: "user-a", botId: bot.id, taskId: "other-task" });
    const approval = ctx.db.$client.prepare("select id from approvals where task_id=?").get(sent.taskId) as { id: string };
    expect(service.approvalGate.decide("user-a", approval.id, "allow")).toBe("ok");
    await service.idle();
    expect(execs).toBe(0);
    const messages = chatRepository(ctx.db).listMessages(userScope("user-a"), sent.conversationId) ?? [];
    expect(messages.some((message) => message.contentJson.includes("远端可能仍在执行"))).toBe(true);
  });

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
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
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
    again.ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), followBot.id);
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
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
    const sent = service.send({ userId: "user-a", botId: bot.id, text: "请停下来", mode: "queue" });
    await waitFor(() => sawExec);
    expect(service.stop(userScope("user-a"), (await sent).taskId)).toBe(true);
    await service.idle();
    const task = chatRepository(ctx.db).findTask(userScope("user-a"), (await sent).taskId);
    expect(task?.state).toBe("cancelled");
    expect(modelCalls).toBe(1);
  });

  it.each([false, true])("marks a restarted tool call interrupted without rerunning it (queued user: %s)", async (queuedUser) => {
    let execs = 0;
    const modelBodies: string[] = [];
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") execs += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
    });
    const modelPort = await listen(async (_req, res, body) => {
      modelBodies.push(body);
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
      id: ulid(1_700_000_000_000),
      conversationId: conversation.id,
      role: "assistant",
      contentJson: storedContent(assistant, ""),
      taskId: task.id,
    });
    if (queuedUser) {
      const text = "恢复前排队指令：不要删除，改成备份";
      chat.insertMessage(scope, {
        id: ulid(1_700_000_000_001), conversationId: conversation.id, role: "user",
        contentJson: storedContent({ role: "user", content: text, timestamp: Date.now() }, text), taskId: task.id,
      });
    }
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
    if (queuedUser) {
      const request = modelBodies.at(-1) ?? "";
      expect(request).toContain("恢复前排队指令");
      expect(request.indexOf('"role":"tool"')).toBeLessThan(request.indexOf("恢复前排队指令"));
    }
  });

  it("keeps remote_unconfirmed visible after the control process restarts", async () => {
    const { config, ctx } = await opened({});
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "未确认" });
    if (!conversation) throw new Error("no conversation");
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.updateTask(scope, task.id, { state: "running", error: "remote_unconfirmed" });
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_remote", name: "remote_tool", arguments: {} }],
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
    expect(recoverInterruptedTasks(ctx.db)).toBe(1);
    expect(chat.findTask(scope, task.id)).toMatchObject({ state: "interrupted", error: "remote_unconfirmed" });
    const messages = chat.listMessages(scope, conversation.id) ?? [];
    expect(messages.some((message) => message.contentJson.includes("远端是否已停止未确认"))).toBe(true);
    expect(messages.some((message) => message.contentJson.includes("执行被中断，结果未知"))).toBe(false);
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
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
    await service.send({ userId: "user-a", botId: bot.id, text: "跑一下", mode: "queue" });
    await service.idle();
    expect(execs).toBe(0);
  });

  it("continues a conversation stored as a 0.73.1 Pi message", async () => {
    const legacyUser =
      '{"pi":{"role":"user","content":"在机器上跑 uname","timestamp":1700000000000},"text":"在机器上跑 uname"}';
    const legacyAssistant =
      '{"pi":{"role":"assistant","content":[{"type":"toolCall","id":"call_legacy","name":"shell_exec","arguments":{"cmd":"uname -a"}}],"api":"openai-completions","provider":"viate-bot","model":"gpt-test","usage":{"input":3,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":5,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1700000001000},"text":""}';
    const legacyTool =
      '{"pi":{"role":"toolResult","toolCallId":"call_legacy","toolName":"shell_exec","content":[{"type":"text","text":"legacy-ok"}],"isError":false,"timestamp":1700000002000},"text":"legacy-ok"}';
    let sawLegacy = false;
    const modelPort = await listen(async (_req, res, body) => {
      sawLegacy = body.includes("legacy-ok") && body.includes("在机器上跑 uname");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse(sawLegacy ? "从旧记录继续" : "没读到旧记录"));
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
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "旧记录" });
    if (!conversation) throw new Error("no conversation");
    const legacyRows = [
      ["user", legacyUser],
      ["assistant", legacyAssistant],
      ["toolResult", legacyTool],
    ] as const;
    for (const [index, [role, contentJson]] of legacyRows.entries()) {
      chat.insertMessage(scope, {
        id: ulid(1_700_000_000_000 + index),
        conversationId: conversation.id,
        role,
        contentJson,
        taskId: null,
      });
    }
    const restored = loadTranscript(chat.listMessages(scope, conversation.id) ?? []);
    expect(restored.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(restored[2]).toMatchObject({ role: "toolResult", toolName: "shell_exec", isError: false });
    const { service } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "machine" });
    await service.send({ userId: "user-a", botId: bot.id, text: "继续", mode: "queue", conversationId: conversation.id });
    await service.idle();
    expect(sawLegacy).toBe(true);
    const after = chat.listMessages(scope, conversation.id) ?? [];
    expect(after.some((message) => message.contentJson.includes("从旧记录继续"))).toBe(true);
  });

  it("resumes a persisted approval through the gate before continuing", async () => {
    let execs = 0;
    const modelBodies: string[] = [];
    const resumeView: { db?: ControlContext["db"]; conversationId?: string } = {};
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") {
        execs += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const modelPort = await listen(async (_req, res, body) => {
      const rows = resumeView.db && resumeView.conversationId
        ? resumeView.db.$client.prepare("select role from messages where conversation_id=?").all(resumeView.conversationId) as Array<{ role: string }>
        : [];
      if (!rows.some((row) => row.role === "toolResult")) {
        res.writeHead(500);
        res.end();
        return;
      }
      modelBodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("批准后继续"));
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
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "审批恢复" });
    if (!conversation) throw new Error("no conversation");
    resumeView.db = ctx.db;
    resumeView.conversationId = conversation.id;
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.updateTask(scope, task.id, { state: "waiting_approval" });
    const args = { cmd: "echo ok" };
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_wait", name: "shell_exec", arguments: args }],
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
    ctx.db.$client.prepare(
      "insert into approvals (id,task_id,tool,summary,args_json,state,args_hash) values ('apr-1',?,'shell_exec','shell_exec',?,'pending',?)",
    ).run(task.id, JSON.stringify(args), argsHash("shell_exec", { cmd: args.cmd, cwd: undefined, env: undefined }));
    const { service } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    await waitFor(() => {
      const current = chat.findTask(scope, task.id);
      return current?.state === "waiting_approval" && current.startedAt != null;
    });
    await delay(40);
    expect(execs).toBe(0);
    expect(modelBodies).toHaveLength(0);
    expect(service.approvalGate.decide("user-a", "apr-1", "allow")).toBe("ok");
    await service.idle();
    expect(execs).toBe(1);
    expect(modelBodies.some((body) => body.includes("exit="))).toBe(true);
    expect(chat.findTask(scope, task.id)?.state).toBe("succeeded");
    const stored = chat.listMessages(scope, conversation.id) ?? [];
    expect(stored.some((message) => message.contentJson.includes("Cannot continue"))).toBe(false);
    expect(stored.some((message) => message.role === "toolResult")).toBe(true);
  });

  it("resumes a persisted takeover instead of failing the assistant tool call", async () => {
    const modelBodies: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      modelBodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("不该先问模型"));
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
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "接管恢复" });
    if (!conversation) throw new Error("no conversation");
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.updateTask(scope, task.id, { state: "waiting_takeover" });
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_take", name: "request_takeover", arguments: {} }],
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
    const { service } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "machine" });
    await waitFor(() => {
      const current = chat.findTask(scope, task.id);
      return current?.state === "failed" || (current?.state === "waiting_takeover" && current.startedAt != null);
    });
    expect(chat.findTask(scope, task.id)?.state).toBe("waiting_takeover");
    expect(modelBodies).toHaveLength(0);
    expect(ctx.db.$client.prepare("select count(*) as n from takeover_leases where task_id=? and state='requested'").get(task.id)).toEqual({ n: 1 });
    expect(service.stop(scope, task.id)).toBe(true);
    await service.idle();
    expect(chat.findTask(scope, task.id)?.state).toBe("cancelled");
    expect(modelBodies).toHaveLength(0);
    const stored = chat.listMessages(scope, conversation.id) ?? [];
    expect(stored.some((message) => message.contentJson.includes("Cannot continue"))).toBe(false);
    expect(stored.some((message) => message.role === "toolResult")).toBe(true);
  });

  it("emits task and routine failure events that the dashboard reads", async () => {
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rate limit" }));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "machine" });
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      userScope("user-a"),
      { name: "Ada", model: "gpt-test" },
    );
    const routineId = ulid();
    const runId = ulid();
    const created = new Date().toISOString();
    ctx.db.$client.prepare(
      "insert into routines (id,bot_id,cron,timezone,prompt,enabled,state,created_at) values (?,?,?,?,?,1,'active',?)",
    ).run(routineId, bot.id, "0 * * * *", "UTC", "secret-prompt-should-not-leak", created);
    ctx.db.$client.prepare(
      "insert into routine_runs (id,routine_id,scheduled_at,state) values (?,?,?,'claimed')",
    ).run(runId, routineId, created);
    service.enqueueRoutine({ userId: "user-a", botId: bot.id, prompt: "secret-prompt-should-not-leak", routineRunId: runId });
    await service.idle();
    const rows = ctx.db.$client.prepare("select type, attrs_json as attrsJson from events").all() as Array<{ type: string; attrsJson: string }>;
    expect(rows.map((row) => row.type)).toEqual(expect.arrayContaining(["task.failed", "routine.failed"]));
    expect(JSON.stringify(rows)).not.toContain("secret-prompt-should-not-leak");
    expect(rows.find((row) => row.type === "routine.failed")?.attrsJson).toContain(routineId);
    const overview = adminOverview(ctx.db, new Date());
    expect(overview.failureClasses).toContainEqual({ errorClass: "rate_limit", count: 1 });
  });

  it("does not run the shell when a resumed approval is denied", async () => {
    let execs = 0;
    const modelBodies: string[] = [];
    const view: { db?: ControlContext["db"]; conversationId?: string } = {};
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") execs += 1;
      res.writeHead(req.url === "/exec" ? 200 : 404, { "content-type": "text/event-stream" });
      res.end(req.url === "/exec" ? `data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n` : "");
    });
    const modelPort = await listen(async (_req, res) => {
      const rows = view.db && view.conversationId
        ? view.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=?").all(view.conversationId) as Array<{ role: string; contentJson: string }>
        : [];
      if (!rows.some((row) => row.role === "toolResult" && row.contentJson.includes("用户拒绝"))) {
        res.writeHead(500);
        res.end();
        return;
      }
      modelBodies.push("model");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("拒绝后继续"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MODEL_API_KEY: "test-key" });
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "拒绝" });
    if (!conversation) throw new Error("no conversation");
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    const assistant = toolCallMessage("shell_exec", "call_shell", { cmd: "echo no" });
    chat.insertMessage(scope, { id: ulid(), conversationId: conversation.id, role: "assistant", contentJson: storedContent(assistant, ""), taskId: task.id });
    const approvalId = ulid();
    view.db = ctx.db;
    view.conversationId = conversation.id;
    ctx.db.$client.prepare(
      "insert into approvals (id,task_id,tool,summary,args_json,state,args_hash) values (?,?,?,'shell_exec',?,'pending',?)",
    ).run(approvalId, task.id, "shell_exec", JSON.stringify({ cmd: "echo no" }), argsHash("shell_exec", { cmd: "echo no", cwd: undefined, env: undefined }));
    ctx.db.$client.prepare("update tasks set state='waiting_approval' where id=?").run(task.id);
    const { service } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    await waitFor(() => chat.findTask(scope, task.id)?.state === "waiting_approval" && chat.findTask(scope, task.id)?.startedAt != null);
    expect(service.approvalGate.decide("user-a", approvalId, "deny")).toBe("ok");
    await service.idle();
    expect(execs).toBe(0);
    expect(modelBodies).toEqual(["model"]);
    const denied = chat.listMessages(scope, conversation.id) ?? [];
    expect(denied.some((message) => message.contentJson.includes("用户拒绝"))).toBe(true);
  });

  it("does not run the shell when a resumed approval is cancelled", async () => {
    let execs = 0;
    const modelBodies: string[] = [];
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec") execs += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
    });
    const modelPort = await listen(async (_req, res) => {
      modelBodies.push("model");
      res.writeHead(500);
      res.end();
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MODEL_API_KEY: "test-key" });
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "取消" });
    if (!conversation) throw new Error("no conversation");
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.insertMessage(scope, {
      id: ulid(),
      conversationId: conversation.id,
      role: "assistant",
      contentJson: storedContent(toolCallMessage("shell_exec", "call_stop", { cmd: "echo stop" }), ""),
      taskId: task.id,
    });
    ctx.db.$client.prepare(
      "insert into approvals (id,task_id,tool,summary,args_json,state,args_hash) values ('apr-stop',?,'shell_exec','shell_exec',?,'pending',?)",
    ).run(task.id, JSON.stringify({ cmd: "echo stop" }), argsHash("shell_exec", { cmd: "echo stop", cwd: undefined, env: undefined }));
    ctx.db.$client.prepare("update tasks set state='waiting_approval' where id=?").run(task.id);
    const { service } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    await waitFor(() => chat.findTask(scope, task.id)?.state === "waiting_approval" && chat.findTask(scope, task.id)?.startedAt != null);
    expect(service.stop(scope, task.id)).toBe(true);
    await service.idle();
    expect(execs).toBe(0);
    expect(modelBodies).toEqual([]);
    expect(chat.findTask(scope, task.id)?.state).toBe("cancelled");
  });

  it("continues after the user revokes a resumed takeover through the screen route", async () => {
    const view: { db?: ControlContext["db"]; conversationId?: string } = {};
    const modelBodies: string[] = [];
    const modelPort = await listen(async (_req, res) => {
      const rows = view.db && view.conversationId
        ? view.db.$client.prepare("select content_json as contentJson from messages where conversation_id=? and role='toolResult'").all(view.conversationId) as Array<{ contentJson: string }>
        : [];
      if (!rows.some((row) => row.contentJson.includes("接管已取消"))) {
        res.writeHead(500);
        res.end();
        return;
      }
      modelBodies.push("after");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("拒绝接管后继续"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MODEL_API_KEY: "test-key" });
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const chat = chatRepository(ctx.db);
    view.db = ctx.db;
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "拒绝接管" });
    if (!conversation) throw new Error("no conversation");
    view.conversationId = conversation.id;
    const session = createSession(ctx.db, ctx.key, "user-a", "refresh-token", new Date());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, "x-vb-csrf": session.csrf, "content-type": "application/json", origin: config.publicUrl };
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.insertMessage(scope, {
      id: ulid(),
      conversationId: conversation.id,
      role: "assistant",
      contentJson: storedContent(toolCallMessage("request_takeover", "call_revoke", { reason: "不要" }), ""),
      taskId: task.id,
    });
    ctx.db.$client.prepare("update tasks set state='waiting_takeover' where id=?").run(task.id);
    const { app, service } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "machine" });
    await waitFor(() => chat.findTask(scope, task.id)?.state === "waiting_takeover" && chat.findTask(scope, task.id)?.startedAt != null);
    const lease = ctx.db.$client.prepare("select id from takeover_leases where task_id=? and state='requested'").get(task.id) as { id: string };
    const revoked = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/screen/revoke`, headers, payload: { leaseId: lease.id } });
    expect(revoked.statusCode).toBe(200);
    await service.idle();
    expect(modelBodies).toEqual(["after"]);
    expect(chat.findTask(scope, task.id)?.state).toBe("succeeded");
  });

  it("continues a resumed takeover after the user releases through the screen route", async () => {
    const view: { db?: ControlContext["db"]; conversationId?: string } = {};
    const modelBodies: string[] = [];
    const modelPort = await listen(async (_req, res) => {
      const rows = view.db && view.conversationId
        ? view.db.$client.prepare("select content_json as contentJson from messages where conversation_id=? and role='toolResult'").all(view.conversationId) as Array<{ contentJson: string }>
        : [];
      if (!rows.some((row) => row.contentJson.includes("用户已交还屏幕"))) {
        res.writeHead(500);
        res.end();
        return;
      }
      modelBodies.push("after");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("接管后继续"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MODEL_API_KEY: "test-key" });
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const chat = chatRepository(ctx.db);
    view.db = ctx.db;
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "接管" });
    if (!conversation) throw new Error("no conversation");
    view.conversationId = conversation.id;
    const session = createSession(ctx.db, ctx.key, "user-a", "refresh-token", new Date());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, "x-vb-csrf": session.csrf, "content-type": "application/json", origin: config.publicUrl };
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.insertMessage(scope, {
      id: ulid(),
      conversationId: conversation.id,
      role: "assistant",
      contentJson: storedContent(toolCallMessage("request_takeover", "call_take", { reason: "看屏幕" }), ""),
      taskId: task.id,
    });
    ctx.db.$client.prepare("update tasks set state='waiting_takeover' where id=?").run(task.id);
    const { app, service } = await appFor(ctx, config, { host: "127.0.0.1", port: 9, token: "machine" });
    await waitFor(() => chat.findTask(scope, task.id)?.state === "waiting_takeover" && chat.findTask(scope, task.id)?.startedAt != null);
    const socketId = "abcdefghijklmnop";
    const viewer = await app.injectWS(`/api/bots/${bot.id}/screen/vnc?socket=${socketId}`, { headers: { cookie: headers.cookie, origin: config.publicUrl } });
    const lease = ctx.db.$client.prepare("select id from takeover_leases where task_id=? and state='requested'").get(task.id) as { id: string };
    const granted = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/screen/grant`, headers, payload: { leaseId: lease.id, socketId } });
    expect(granted.statusCode).toBe(200);
    const released = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/screen/release`, headers, payload: { leaseId: lease.id } });
    expect(released.statusCode).toBe(200);
    await service.idle();
    expect(modelBodies).toEqual(["after"]);
    viewer.close();
  });

  it("gates an installed namespaced risky tool and does not run it before approval", async () => {
    let execs = 0;
    const sessionId = "a".repeat(32);
    const machine = createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/apps/vendor") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ mcpServers: ["main"] }));
        return;
      }
      if (req.method === "POST" && url === "/apps/vendor/mcp/main") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ server: sessionId, running: true }));
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ server: sessionId, running: false }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const sockets = new WebSocketServer({ server: machine });
    sockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; method?: string };
        if (message.id === undefined) return;
        if (message.method === "tools/call") execs += 1;
        const result = message.method === "tools/list"
          ? { tools: [{ name: "vendor.danger", inputSchema: { type: "object" } }] }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: "ran" }] }
            : {};
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    const machinePort = await new Promise<number>((resolve) => {
      machine.listen(0, "127.0.0.1", () => resolve((machine.address() as AddressInfo).port));
    });
    cleanups.push(async () => {
      sockets.close();
      await new Promise<void>((resolve) => machine.close(() => resolve()));
    });
    let modelCalls = 0;
    const modelPort = await listen(async (_req, res) => {
      modelCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(modelCalls === 1 ? toolSse(JSON.stringify({})).replace("shell_exec", "vendor.danger") : textSse("未执行"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MODEL_API_KEY: "test-key" });
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["mcp"] }), bot.id);
    const now = new Date().toISOString();
    ctx.db.$client.prepare(
      "insert into machines (id,user_id,state,spec_json,image_version,volume_name,machined_token_enc,created_at,updated_at) values ('m','user-a','running','{}','dev','vol','enc',?,?)",
    ).run(now, now);
    ctx.db.$client.prepare("insert into apps (id,name,source,created_at) values ('app','vendor','catalog',?)").run(now);
    ctx.db.$client.prepare(
      "insert into app_versions (id,app_id,version,manifest_json,archive_path,sha256,status,created_at) values ('ver','app','1',?,'apps/vendor.tar','abc','published',?)",
    ).run(JSON.stringify({ extensions: { "ai.viate.bot": { riskyTools: ["vendor.danger"] } } }), now);
    ctx.db.$client.prepare(
      "insert into app_installs (id,machine_id,app_version_id,desired,state,updated_at) values ('ins','m','ver','present','installed',?)",
    ).run(now);
    const { service } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const pending = service.send({ userId: "user-a", botId: bot.id, text: "调用风险工具", mode: "queue" });
    await waitFor(() => {
      const row = ctx.db.$client.prepare("select state from approvals where tool='vendor.danger'").get() as { state: string } | undefined;
      return row?.state === "pending";
    });
    expect(execs).toBe(0);
    const approval = ctx.db.$client.prepare("select id from approvals where tool='vendor.danger' and state='pending'").get() as { id: string };
    expect(service.approvalGate.decide("user-a", approval.id, "deny")).toBe("ok");
    const sent = await pending;
    await service.idle();
    expect(execs).toBe(0);
    const messages = chatRepository(ctx.db).listMessages(scope, sent.conversationId) ?? [];
    expect(messages.some((message) => message.contentJson.includes("用户拒绝"))).toBe(true);
  });

  it("persists an unconfirmed shell and blocks the user's other writes and grants", async () => {
    let execs = 0;
    let followCalls = 0;
    let releaseExec: () => void = () => {};
    const execHeld = new Promise<void>((resolve) => {
      releaseExec = resolve;
    });
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec/cancel") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no" }));
        releaseExec();
        return;
      }
      if (req.url === "/exec") {
        execs += 1;
        res.writeHead(200, { "content-type": "text/event-stream", "x-exec-id": "job-1" });
        res.flushHeaders();
        await execHeld;
        if (!res.writableEnded) res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const modelPort = await listen(async (_req, res, body) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (body.includes("再写一次")) {
        followCalls += 1;
        res.end(followCalls === 1 ? toolSse(JSON.stringify({ cmd: "touch /tmp/no" })) : namedToolSse("request_takeover", "{}"));
        return;
      }
      if (body.includes("请停下来") && execs === 0) {
        res.end(toolSse(JSON.stringify({ cmd: "sleep 30" })));
        return;
      }
      res.end(textSse("停"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { app, service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const other = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Bea", model: "gpt-test" },
    );
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell", "mcp"] }), other.id);
    const sent = service.send({ userId: "user-a", botId: bot.id, text: "请停下来", mode: "queue" });
    await waitFor(() => execs === 1);
    expect(service.stop(scope, (await sent).taskId)).toBe(true);
    await service.idle();
    const task = chatRepository(ctx.db).findTask(scope, (await sent).taskId);
    expect(task?.state).not.toBe("succeeded");
    expect(task?.error).toBe("remote_unconfirmed");
    const mark = ctx.db.$client.prepare("select user_id as userId, attrs_json as attrs from events where type='mcp.remote_unconfirmed'").get() as { userId: string; attrs: string };
    expect(mark.userId).toBe("user-a");
    expect(JSON.parse(mark.attrs).taskId).toBe((await sent).taskId);
    const follow = service.send({ userId: "user-a", botId: other.id, text: "再写一次", mode: "queue" });
    await waitFor(() => followCalls >= 1);
    expect(execs).toBe(1);
    await waitFor(() => ctx.db.$client.prepare("select id from takeover_leases where state='requested'").get() !== undefined).catch((error: Error) => {
      const states = ctx.db.$client.prepare("select state, error from tasks").all();
      throw new Error(`${error.message} calls=${followCalls} execs=${execs} tasks=${JSON.stringify(states)}`);
    });
    const session = createSession(ctx.db, ctx.key, "user-a", "refresh-token", new Date());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, "x-vb-csrf": session.csrf, "content-type": "application/json", origin: config.publicUrl };
    const lease = ctx.db.$client.prepare("select id from takeover_leases where state='requested'").get() as { id: string };
    const socketId = "unconfirmedsock01";
    const viewer = await app.injectWS(`/api/bots/${other.id}/screen/vnc?socket=${socketId}`, { headers: { cookie: headers.cookie, origin: config.publicUrl } });
    const granted = await app.inject({ method: "POST", url: `/api/bots/${other.id}/screen/grant`, headers, payload: { leaseId: lease.id, socketId } });
    expect(granted.statusCode).toBe(409);
    const accepted = await app.inject({ method: "POST", url: `/api/tasks/${(await sent).taskId}/accept-remote-risk`, headers, payload: {} });
    expect(accepted.statusCode).toBe(200);
    const allowed = await app.inject({ method: "POST", url: `/api/bots/${other.id}/screen/grant`, headers, payload: { leaseId: lease.id, socketId } });
    expect(allowed.statusCode).toBe(200);
    expect(service.stop(scope, (await follow).taskId)).toBe(true);
    await service.idle();
    expect(execs).toBe(1);
    viewer.close();
  }, 20000);

  it.each(["disconnect", "missing-id"] as const)("persists an unconfirmed shell when cancel %s", async (mode) => {
    let execs = 0;
    let releaseExec: () => void = () => {};
    const execHeld = new Promise<void>((resolve) => {
      releaseExec = resolve;
    });
    const machinePort = await listen(async (req, res) => {
      if (req.url === "/exec/cancel") {
        if (mode === "disconnect") {
          req.socket.destroy();
          releaseExec();
          return;
        }
        res.writeHead(500);
        res.end();
        releaseExec();
        return;
      }
      if (req.url === "/exec") {
        execs += 1;
        res.writeHead(200, { "content-type": "text/event-stream", ...(mode === "missing-id" ? {} : { "x-exec-id": "job-1" }) });
        res.flushHeaders();
        await execHeld;
        if (!res.writableEnded) res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(execs === 0 ? toolSse(JSON.stringify({ cmd: "sleep 30" })) : textSse("停"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
    const { service, runtime } = await appFor(ctx, config, { host: "127.0.0.1", port: machinePort, token: "machine" });
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const other = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Bea", model: "gpt-test" },
    );
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), bot.id);
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell"] }), other.id);
    const sent = service.send({ userId: "user-a", botId: bot.id, text: "请停下来", mode: "queue" });
    await waitFor(() => execs === 1);
    expect(service.stop(scope, (await sent).taskId)).toBe(true);
    await service.idle();
    expect(chatRepository(ctx.db).findTask(scope, (await sent).taskId)?.error).toBe("remote_unconfirmed");
    const follow = service.send({ userId: "user-a", botId: other.id, text: "再写一次", mode: "queue" });
    await follow;
    await service.idle();
    expect(execs).toBe(1);
  }, 20000);

  it("recovers the same takeover after a second start while the user cap is full", async () => {
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const modelBodies: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      if (body.includes("占住")) {
        await hold;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(textSse("占住结束"));
        return;
      }
      if (!body.includes("接管已取消")) {
        res.writeHead(500);
        res.end();
        return;
      }
      modelBodies.push("after");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("恢复后继续"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MODEL_API_KEY: "test-key", VB_MAX_RUNNING_TASKS: "5" });
    ctx.db.$client.prepare("update quotas set max_concurrent_tasks=0 where user_id='user-a'").run();
    const runtime = createRuntime(config, ctx.db);
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const chat = chatRepository(ctx.db);
    const conversation = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: "二次接管" });
    if (!conversation) throw new Error("no conversation");
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new Error("no task");
    chat.insertMessage(scope, {
      id: ulid(),
      conversationId: conversation.id,
      role: "assistant",
      contentJson: storedContent(toolCallMessage("request_takeover", "call_take", { reason: "看屏幕" }), ""),
      taskId: task.id,
    });
    ctx.db.$client.prepare("update tasks set state='waiting_takeover' where id=?").run(task.id);
    const first = buildApp(ctx, {
      retryDelays: [0, 0],
      ensureMachine: async () => {},
      prepareEndpoint: async (_userId, onPhase) => {
        onPhase("ready");
        return { host: "127.0.0.1", port: 9, token: "machine" };
      },
    });
    await first.ready();
    await delay(50);
    expect(chat.findTask(scope, task.id)?.state).toBe("waiting_takeover");
    await first.close();
    releaseHold();
    ctx.db.$client.prepare("update quotas set max_concurrent_tasks=1 where user_id='user-a'").run();
    const second = buildApp(ctx, {
      retryDelays: [0, 0],
      ensureMachine: async () => {},
      prepareEndpoint: async (_userId, onPhase) => {
        onPhase("ready");
        return { host: "127.0.0.1", port: 9, token: "machine" };
      },
    });
    cleanups.push(() => second.close());
    await second.ready();
    const service = chatService(second);
    await waitFor(() => chat.findTask(scope, task.id)?.state === "waiting_takeover" && chat.findTask(scope, task.id)?.startedAt != null);
    const session = createSession(ctx.db, ctx.key, "user-a", "refresh-token", new Date());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, "x-vb-csrf": session.csrf, "content-type": "application/json", origin: config.publicUrl };
    const lease = ctx.db.$client.prepare("select id from takeover_leases where task_id=? and state='requested'").get(task.id) as { id: string };
    const revoked = await second.inject({ method: "POST", url: `/api/bots/${bot.id}/screen/revoke`, headers, payload: { leaseId: lease.id } });
    expect(revoked.statusCode).toBe(200);
    await service.idle();
    expect(modelBodies).toEqual(["after"]);
    const leases = ctx.db.$client.prepare("select count(*) as n from takeover_leases where task_id=?").get(task.id) as { n: number };
    expect(leases.n).toBe(1);
    const results = chat.listMessages(scope, conversation.id) ?? [];
    const resultAt = results.findIndex((message) => message.role === "toolResult");
    expect(resultAt).toBeGreaterThanOrEqual(0);
    expect(modelBodies).toHaveLength(1);
  }, 20000);

  it("blocks the user's shell, browser, and MCP writes after a failed drain, then allows them", async () => {
    let execs = 0;
    let mcpCalls = 0;
    let fail = true;
    const passed: string[] = [];
    setToolHooks({
      beforeToolCall: async (context) => {
        passed.push(context.toolCall.name);
        return undefined;
      },
    });
    const sessionId = "a".repeat(32);
    const machine = createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/apps/vendor") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ mcpServers: ["main"] }));
        return;
      }
      if (req.method === "POST" && url === "/apps/vendor/mcp/main") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ server: sessionId, running: true }));
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ server: sessionId, running: false }));
        return;
      }
      if (url === "/exec") {
        execs += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const sockets = new WebSocketServer({ server: machine });
    sockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; method?: string };
        if (message.id === undefined) return;
        if (message.method === "tools/call") mcpCalls += 1;
        const result = message.method === "tools/list"
          ? { tools: [{ name: "vendor.danger", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "ran" }] };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    const machinePort = await new Promise<number>((resolve) => {
      machine.listen(0, "127.0.0.1", () => resolve((machine.address() as AddressInfo).port));
    });
    cleanups.push(async () => {
      sockets.close();
      await new Promise<void>((resolve) => machine.close(() => resolve()));
    });
    let writeStep = 0;
    let allowStep = 0;
    const modelPort = await listen(async (_req, res, body) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (body.includes("现在可以")) {
        allowStep += 1;
        res.end(allowStep === 1 ? toolSse(JSON.stringify({ cmd: "true" })) : textSse("可以了"));
        return;
      }
      if (body.includes("写三样")) {
        writeStep += 1;
        if (writeStep === 1) res.end(toolSse(JSON.stringify({ cmd: "true" })));
        else if (writeStep === 2) res.end(namedToolSse("browser_click", JSON.stringify({ ref: "e1" })));
        else if (writeStep === 3) res.end(namedToolSse("vendor.danger", "{}"));
        else res.end(textSse("写完"));
        return;
      }
      if (!body.includes("未能关闭")) {
        res.end(namedToolSse("request_takeover", "{}"));
        return;
      }
      res.end(textSse("接管失败"));
    });
    const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_MODEL_API_KEY: "test-key" });
    const runtime = createRuntime(config, ctx.db);
    const flights = createUserFlights();
    const leases = createTakeoverLeases({
      db: ctx.db,
      secretWaitMs: config.secretWaitMs,
      flights,
      quiesce: async () => {},
      writesBlocked: (userId) => remoteUncertain(ctx.db, userId),
      drainInput: async () => {
        if (fail) throw new Error("vnc input=false failed");
      },
    });
    const app = buildApp(ctx, {
      flights,
      leases,
      retryDelays: [0, 0],
      ensureMachine: async () => {},
      prepareEndpoint: async (_userId, onPhase) => {
        onPhase("ready");
        return { host: "127.0.0.1", port: machinePort, token: "machine" };
      },
    });
    cleanups.push(() => app.close());
    await app.ready();
    const service = chatService(app);
    const scope = userScope("user-a");
    const bot = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Ada", model: "gpt-test" },
    );
    const other = await createBot(
      { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
      scope,
      { name: "Bea", model: "gpt-test" },
    );
    const allow = JSON.stringify({ alwaysAllow: ["shell", "browser", "mcp"] });
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(allow, bot.id);
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(allow, other.id);
    const now = new Date().toISOString();
    ctx.db.$client.prepare(
      "insert into machines (id,user_id,state,spec_json,image_version,volume_name,machined_token_enc,created_at,updated_at) values ('m','user-a','running','{}','dev','vol','enc',?,?)",
    ).run(now, now);
    ctx.db.$client.prepare("insert into apps (id,name,source,created_at) values ('app','vendor','catalog',?)").run(now);
    ctx.db.$client.prepare(
      "insert into app_versions (id,app_id,version,manifest_json,archive_path,sha256,status,created_at) values ('ver','app','1','{}','apps/vendor.tar','abc','published',?)",
    ).run(now);
    ctx.db.$client.prepare(
      "insert into app_installs (id,machine_id,app_version_id,desired,state,updated_at) values ('ins','m','ver','present','installed',?)",
    ).run(now);
    const session = createSession(ctx.db, ctx.key, "user-a", "refresh-token", new Date());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, "x-vb-csrf": session.csrf, "content-type": "application/json", origin: config.publicUrl };
    const takeover = service.send({ userId: "user-a", botId: bot.id, text: "请接管", mode: "queue" });
    await waitFor(() => ctx.db.$client.prepare("select id from takeover_leases where state='requested'").get() !== undefined);
    const socketId = "drainblocksocket1";
    const viewer = await app.injectWS(`/api/bots/${bot.id}/screen/vnc?socket=${socketId}`, { headers: { cookie: headers.cookie, origin: config.publicUrl } });
    const lease = ctx.db.$client.prepare("select id from takeover_leases where state='requested'").get() as { id: string };
    expect((await app.inject({ method: "POST", url: `/api/bots/${bot.id}/screen/grant`, headers, payload: { leaseId: lease.id, socketId } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/bots/${bot.id}/screen/release`, headers, payload: { leaseId: lease.id } })).statusCode).toBe(200);
    await takeover;
    await service.idle();
    expect(flights.paused("user-a")).toBe(true);
    const blocked = service.send({ userId: "user-a", botId: other.id, text: "写三样", mode: "queue" });
    await blocked;
    await service.idle();
    expect(execs).toBe(0);
    expect(mcpCalls).toBe(0);
    expect(passed).toEqual(["request_takeover"]);
    expect(writeStep).toBe(4);
    fail = false;
    expect((await app.inject({ method: "POST", url: `/api/bots/${bot.id}/screen/release`, headers, payload: { leaseId: lease.id } })).statusCode).toBe(200);
    await waitFor(() => !flights.paused("user-a"));
    const again = service.send({ userId: "user-a", botId: other.id, text: "现在可以", mode: "queue" });
    await again;
    await service.idle();
    expect(execs).toBe(1);
    expect(passed).toContain("shell_exec");
    viewer.close();
  }, 20000);
});

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolCallMessage(name: string, id: string, args: { [key: string]: string | number | boolean | null }): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "openai-completions",
    provider: "viate-bot",
    model: "gpt-test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await delay(20);
  }
}
