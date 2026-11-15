import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { eventRepository } from "../db/events.js";
import { openDatabase } from "../db/index.js";
import { ensureDevUser, userRepository } from "../db/users.js";
import { createSession } from "../session.js";

const SECRET = "super-secret-key";
const cleanups: Array<() => Promise<void>> = [];

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
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

function textSse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`;
}

function toolSse(): string {
  const args = JSON.stringify({ cmd: "uname -a && id" });
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "shell_exec", arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

async function boot(env: Record<string, string>, endpoint: { host: string; port: number; token: string }) {
  const dir = mkdtempSync(join(tmpdir(), "vb-http-"));
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: SECRET,
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
    ...env,
  });
  const ctx = contextFor(config);
  ensureDevUser(ctx.db, "user-a", {
    maxBots: config.defaultMaxBots,
    maxConcurrentTasks: config.defaultMaxConcurrentTasks,
  });
  ensureDevUser(ctx.db, "user-b", {
    maxBots: config.defaultMaxBots,
    maxConcurrentTasks: config.defaultMaxConcurrentTasks,
  });
  const prepared: string[] = [];
  const app = buildApp(ctx, {
    retryDelays: [0, 0],
    ensureMachine: async () => {},
    prepareEndpoint: async (userId, onPhase) => {
      prepared.push(userId);
      onPhase("starting");
      onPhase("ready");
      return endpoint;
    },
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    ctx.db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const now = new Date();
  const alice = createSession(ctx.db, ctx.key, "user-a", "refresh-a", now);
  const bob = createSession(ctx.db, ctx.key, "user-b", "refresh-b", now);
  return { app, ctx, config, prepared, alice, bob };
}

function cookie(token: string): string {
  return `vb_session=${token}`;
}

describe("chat http and websocket", () => {
  it("runs a tool on the owning user's machine and hides the key", async () => {
    const auths: string[] = [];
    const machinePort = await listen(async (req, res) => {
      auths.push(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ type: "stdout", data: "Linux test\nuid=1000(bot)\n" })}\n\ndata: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`,
      );
    });
    const modelAuths: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      modelAuths.push(_req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body.includes("exit=") ? textSse("命令结果已经回来了") : toolSse());
    });
    const { app, ctx, alice, bob, prepared } = await boot(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` },
      { host: "127.0.0.1", port: machinePort, token: "token-a" },
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf, "content-type": "application/json" },
      payload: { name: "Ada", model: "gpt-test", instructions: "说中文" },
    });
    expect(created.statusCode).toBe(201);
    const botId = created.json().bot.id as string;
    const sent = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf, "content-type": "application/json" },
      payload: { text: "请运行 uname -a && id" },
    });
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as { conversationId: string; taskId: string; messageId: string };
    await chatService(app).idle();
    const messages = await app.inject({
      method: "GET",
      url: `/api/conversations/${body.conversationId}/messages`,
      headers: { cookie: cookie(alice.token) },
    });
    const steps = await app.inject({
      method: "GET",
      url: `/api/tasks/${body.taskId}/steps`,
      headers: { cookie: cookie(alice.token) },
    });
    const task = await app.inject({
      method: "GET",
      url: `/api/tasks/${body.taskId}`,
      headers: { cookie: cookie(alice.token) },
    });
    expect(task.json().task.state).toBe("succeeded");
    const dumped = JSON.stringify({ messages: messages.json(), steps: steps.json(), task: task.json() });
    expect(dumped).toContain("命令结果已经回来了");
    expect(dumped).toContain("Linux test");
    expect(dumped).not.toContain(SECRET);
    expect(modelAuths[0]).toBe(`Bearer ${SECRET}`);
    expect(auths).toContain("Bearer token-a");
    expect(prepared).toEqual(["user-a"]);
    const events = eventRepository(ctx.db).listByBot(botId).map((event) => event.attrsJson).join("\n");
    expect(events).not.toContain(SECRET);
    for (const path of [
      `/api/bots/${botId}`,
      `/api/conversations/${body.conversationId}`,
      `/api/tasks/${body.taskId}`,
      `/api/messages/${body.messageId}`,
    ]) {
      const foreign = await app.inject({ method: "GET", url: path, headers: { cookie: cookie(bob.token) } });
      expect(foreign.statusCode, path).toBe(404);
    }
  });

  it("rejects a missing session, a foreign origin, and a foreign subscription", async () => {
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("在"));
    });
    const { app, ctx, config, alice, bob } = await boot(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` },
      { host: "127.0.0.1", port: 9, token: "token-a" },
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf, "content-type": "application/json" },
      payload: { name: "Ada", model: "gpt-test" },
    });
    const botId = created.json().bot.id as string;
    const sent = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf, "content-type": "application/json" },
      payload: { text: "你好" },
    });
    await chatService(app).idle();
    const conversationId = sent.json().conversationId as string;
    await expect(app.injectWS("/ws", { headers: { origin: config.publicUrl } })).rejects.toThrow(/401/);
    await expect(
      app.injectWS("/ws", { headers: { origin: "http://evil.test", cookie: cookie(alice.token) } }),
    ).rejects.toThrow(/403/);
    const outsider = await app.injectWS("/ws", {
      headers: { origin: config.publicUrl, cookie: cookie(bob.token) },
    });
    outsider.send(JSON.stringify({ type: "subscribe", conversationId }));
    const denied = await onceMessage(outsider);
    expect(denied).toContain("找不到对话");
    const owner = await app.injectWS("/ws", {
      headers: { origin: config.publicUrl, cookie: cookie(alice.token) },
    });
    owner.send(JSON.stringify({ type: "subscribe", conversationId }));
    expect(await onceMessage(owner)).toContain("subscribed");
    const again = app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf, "content-type": "application/json" },
      payload: { text: "再来一句", conversationId },
    });
    const pushed = await onceMessage(owner);
    expect(pushed).toContain("再来一句");
    const leaked = await Promise.race([
      onceMessage(outsider).then((text) => text),
      delay(200).then(() => ""),
    ]);
    expect(leaked).toBe("");
    await again;
    await chatService(app).idle();
    userRepository(ctx.db).setStatus("user-a", "disabled");
    const closed = onceClose(owner);
    await app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookie(alice.token) } });
    await closed;
    outsider.close();
  });

  it("enforces the bot quota and the model whitelist", async () => {
    const { app, alice } = await boot({ VB_MODELS: "gpt-test", VB_DEFAULT_MAX_BOTS: "1", VB_MODEL_BASE_URL: "http://127.0.0.1:9/v1" }, {
      host: "127.0.0.1",
      port: 9,
      token: "t",
    });
    const headers = { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf, "content-type": "application/json" };
    const rejected = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name: "Nope", model: "other" },
    });
    expect(rejected.statusCode).toBe(400);
    const first = await app.inject({ method: "POST", url: "/api/bots", headers, payload: { name: "Ada", model: "gpt-test" } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/bots", headers, payload: { name: "Bob", model: "gpt-test" } });
    expect(second.statusCode).toBe(403);
    const models = await app.inject({ method: "GET", url: "/api/models", headers: { cookie: cookie(alice.token) } });
    expect(models.json()).toEqual({ models: ["gpt-test"], unrestricted: false });
  });
});

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

function onceMessage(socket: { once: (event: "message", listener: (data: Buffer) => void) => void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket 没有消息")), 3_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString("utf8"));
    });
  });
}

function onceClose(socket: { once: (event: "close", listener: () => void) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket 没有关闭")), 3_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
