import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { ensureDevUser } from "../db/users.js";
import { createSession } from "../session.js";

const JPEG = Buffer.from("jpeg-marker-m15").toString("base64");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("browser tools", () => {
  it("serializes one user's bots and lets two users run at the same time", async () => {
    const shared = await fakeCdp();
    const modelPort = await listen(async (_req, res, body) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(openThenSnapshot(body));
    });
    const { app, alice, bob } = await startApp(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_DEFAULT_MAX_CONCURRENT_TASKS: "4" },
      async (userId) => ({ host: "127.0.0.1", port: shared.port, token: `token-${userId}` }),
    );
    const a1 = await createBot(app, alice, "A1");
    const a2 = await createBot(app, alice, "A2");
    await send(app, alice, a1, "打开 A1");
    await send(app, alice, a2, "打开 A2");
    await chatService(app).idle();
    expect(shared.maxTree).toBe(1);
    expect(shared.opened.slice().sort()).toEqual(["http://a1.test", "http://a2.test"]);

    shared.maxTree = 0;
    shared.treeGate = deferred();
    const b1 = await createBot(app, bob, "B1");
    const again = send(app, alice, a1, "再打开 A");
    const other = send(app, bob, b1, "打开 B");
    await Promise.race([
      Promise.all([again, other]).then(async () => chatService(app).idle()),
      delay(3_000).then(() => Promise.reject(new Error("不同用户的浏览器操作互相堵住了"))),
    ]);
    expect(shared.peakTree).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("does not let one user's browser tool reach another user's machine", async () => {
    const aliceMachine = await fakeCdp();
    const bobMachine = await fakeCdp();
    const seen: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(openThenSnapshot(body));
    });
    const { app, alice, bob } = await startApp(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` },
      async (userId) => {
        seen.push(userId);
        return userId === "user-b"
          ? { host: "127.0.0.1", port: bobMachine.port, token: "token-b" }
          : { host: "127.0.0.1", port: aliceMachine.port, token: "token-a" };
      },
    );
    await createBot(app, bob, "Bob");
    const ada = await createBot(app, alice, "Ada");
    await send(app, alice, ada, "打开 A");
    await chatService(app).idle();
    expect(seen).toEqual(["user-a"]);
    expect(aliceMachine.auths).toEqual(["Bearer token-a"]);
    expect(aliceMachine.opened).toEqual(["http://a.test"]);
    expect(bobMachine.auths).toEqual([]);
    expect(bobMachine.opened).toEqual([]);
  });

  it("tells the model to snapshot again when a ref is stale", async () => {
    const machine = await fakeCdp();
    const modelPort = await listen(async (_req, res, body) => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> };
      const count = toolsSinceUser(parsed.messages);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (count === 0) res.end(toolSse("call_open", "browser_open", { url: "http://login.test" }));
      else if (count === 1 || count === 2) res.end(toolSse(`call_snap_${count}`, "browser_snapshot", {}));
      else if (count === 3) res.end(toolSse("call_click", "browser_click", { ref: "e1" }));
      else res.end(textSse("好"));
    });
    const { app, alice } = await startApp(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` },
      async () => ({ host: "127.0.0.1", port: machine.port, token: "token-a" }),
    );
    const botId = await createBot(app, alice, "Ada");
    const sent = await send(app, alice, botId, "点一下");
    await chatService(app).idle();
    const steps = await app.inject({
      method: "GET",
      url: `/api/tasks/${sent.taskId}/steps`,
      headers: { cookie: cookie(alice.token) },
    });
    const dumped = JSON.stringify(steps.json());
    expect(dumped).toContain("ref e1 已过期或未知，请重新调用 browser_snapshot");
    expect(machine.clicks).toEqual([]);
  });

  it("returns a screenshot to a vision model without storing the image", async () => {
    const machine = await fakeCdp();
    const bodies: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      const parsed = JSON.parse(body) as { messages: Array<{ role: string }> };
      const count = toolsSinceUser(parsed.messages);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (count === 0) res.end(toolSse("call_open", "browser_open", { url: "http://login.test" }));
      else if (count === 1) res.end(toolSse("call_shot", "browser_screenshot", {}));
      else res.end(textSse("看到了"));
    });
    const { app, alice } = await startApp(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_VISION_MODELS: "gpt-test" },
      async () => ({ host: "127.0.0.1", port: machine.port, token: "token-a" }),
    );
    const botId = await createBot(app, alice, "Ada");
    const sent = await send(app, alice, botId, "截图");
    await chatService(app).idle();
    const steps = await app.inject({
      method: "GET",
      url: `/api/tasks/${sent.taskId}/steps`,
      headers: { cookie: cookie(alice.token) },
    });
    const messages = await app.inject({
      method: "GET",
      url: `/api/conversations/${sent.conversationId}/messages`,
      headers: { cookie: cookie(alice.token) },
    });
    const stored = JSON.stringify({ steps: steps.json(), messages: messages.json() });
    expect(stored).toContain("截图");
    expect(stored).not.toContain(JPEG);
    expect(bodies[bodies.length - 1]).toContain(JPEG);
  });
});

function openThenSnapshot(body: string): string {
  const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> };
  const count = toolsSinceUser(parsed.messages);
  const user = [...parsed.messages].reverse().find((message) => message.role === "user");
  const text = String(user?.content ?? "");
  const url = text.includes("A1") ? "http://a1.test" : text.includes("A2") ? "http://a2.test" : text.includes("再打开") ? "http://again.test" : text.includes("B") ? "http://b.test" : "http://a.test";
  if (count === 0) return toolSse("call_open", "browser_open", { url });
  if (count === 1) return toolSse("call_snap", "browser_snapshot", {});
  return textSse("好");
}

function toolsSinceUser(messages: Array<{ role: string }>): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === "user") break;
    if (message.role === "tool") count += 1;
  }
  return count;
}

interface Cdp {
  port: number;
  auths: string[];
  opened: string[];
  clicks: Array<{ x?: number; y?: number }>;
  maxTree: number;
  peakTree: number;
  treeGate?: Deferred;
}

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve, pending: 0 };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  pending: number;
}

async function fakeCdp(): Promise<Cdp> {
  const state: Cdp = { port: 0, auths: [], opened: [], clicks: [], maxTree: 0, peakTree: 0 };
  let inflight = 0;
  let seq = 0;
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    state.auths.push(req.headers.authorization ?? "");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id: number; method: string; params?: Record<string, unknown> };
      void answer(socket, message);
    });
  });

  async function answer(socket: { send: (data: string) => void }, message: { id: number; method: string; params?: Record<string, unknown> }): Promise<void> {
    const params = message.params ?? {};
    let result: unknown = {};
    if (message.method === "Target.createTarget") {
      seq += 1;
      state.opened.push(String(params.url ?? ""));
      result = { targetId: `t${seq}` };
    } else if (message.method === "Target.attachToTarget") result = { sessionId: `s-${String(params.targetId)}` };
    else if (message.method === "Browser.getWindowForTarget") result = { windowId: 1 };
    else if (message.method === "Runtime.evaluate") {
      const expression = String(params.expression ?? "");
      const value = expression === "document.readyState" ? "complete" : "http://login.test";
      result = { result: { type: "string", value } };
    } else if (message.method === "Accessibility.getFullAXTree") {
      inflight += 1;
      state.maxTree = Math.max(state.maxTree, inflight);
      state.peakTree = Math.max(state.peakTree, inflight);
      if (state.treeGate) {
        state.treeGate.pending += 1;
        if (state.treeGate.pending >= 2) state.treeGate.resolve();
        await state.treeGate.promise;
      } else await delay(30);
      inflight -= 1;
      result = { nodes: [{ role: { value: "textbox" }, name: { value: "用户名" }, backendDOMNodeId: 7 }] };
    } else if (message.method === "DOM.getBoxModel") result = { model: { content: [0, 0, 40, 0, 40, 20, 0, 20] } };
    else if (message.method === "Page.getLayoutMetrics") result = { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
    else if (message.method === "Input.dispatchMouseEvent" && params.type === "mousePressed") state.clicks.push({ x: params.x as number, y: params.y as number });
    else if (message.method === "Page.captureScreenshot") result = { data: JPEG };
    socket.send(JSON.stringify({ id: message.id, result }));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  state.port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return state;
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>): Promise<number> {
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

interface Session {
  token: string;
  csrf: string;
}

async function startApp(
  env: Record<string, string>,
  prepare: (userId: string) => Promise<{ host: string; port: number; token: string }>,
) {
  const dir = mkdtempSync(join(tmpdir(), "vb-browser-"));
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
  const app = buildApp(ctx, {
    retryDelays: [0, 0],
    ensureMachine: async () => {},
    prepareEndpoint: async (userId, onPhase) => {
      onPhase("ready");
      return prepare(userId);
    },
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    ctx.db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const now = new Date();
  return {
    app,
    alice: createSession(ctx.db, ctx.key, "user-a", "refresh-a", now),
    bob: createSession(ctx.db, ctx.key, "user-b", "refresh-b", now),
  };
}

async function createBot(app: FastifyInstance, session: Session, name: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/bots",
    headers: auth(session),
    payload: { name, model: "gpt-test" },
  });
  expect(created.statusCode).toBe(201);
  return created.json().bot.id as string;
}

async function send(app: FastifyInstance, session: Session, botId: string, text: string): Promise<{ taskId: string; conversationId: string }> {
  const sent = await app.inject({
    method: "POST",
    url: `/api/bots/${botId}/messages`,
    headers: auth(session),
    payload: { text },
  });
  expect(sent.statusCode).toBe(202);
  return sent.json() as { taskId: string; conversationId: string };
}

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

function auth(session: Session): Record<string, string> {
  return { cookie: cookie(session.token), "x-vb-csrf": session.csrf, "content-type": "application/json" };
}

function cookie(token: string): string {
  return `vb_session=${token}`;
}

function toolSse(id: string, name: string, args: unknown): string {
  const encoded = JSON.stringify(args);
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: encoded } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function textSse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
