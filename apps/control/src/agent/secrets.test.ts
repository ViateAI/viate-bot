import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { decrypt, loadOrCreateKey } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { chatRepository } from "../db/chat.js";
import { eventRepository } from "../db/events.js";
import { secretRepository } from "../db/secrets.js";
import { ensureDevUser } from "../db/users.js";
import { createSession } from "../session.js";
import { userScope } from "../scope.js";
import { bindSecrets, substituteArgs } from "./secrets.js";
import { maskDeep, maskSecrets } from "./text.js";

const PASSWORD = 'pw-ZEBRA"m15\\9917';
const PASSWORD_JSON = JSON.stringify(PASSWORD).slice(1, -1);
const OTP = "otp-OTTER-m15-4482";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("secret placeholders", () => {
  it("replaces placeholders only in the allowed fields", async () => {
    const lookup = (name: string) => (name === "site_password" ? PASSWORD : undefined);
    const shell = substituteArgs(
      "shell_exec",
      { cmd: "printf %s \"$TOKEN\" # {{secret:site_password}}", env: { TOKEN: "{{secret:site_password}}" } },
      lookup,
    );
    expect(shell.params).toEqual({
      cmd: "printf %s \"$TOKEN\" # {{secret:site_password}}",
      env: { TOKEN: PASSWORD },
    });
    expect(shell.skipped).toEqual(["cmd"]);
    const file = substituteArgs(
      "fs_write",
      { path: "/tmp/{{secret:site_password}}.txt", content: "secret={{secret:site_password}}" },
      lookup,
    );
    expect(file.params).toEqual({ path: "/tmp/{{secret:site_password}}.txt", content: `secret=${PASSWORD}` });
    expect(file.skipped).toEqual(["path"]);
    const url = substituteArgs("browser_open", { url: "http://x/{{secret:site_password}}" }, lookup);
    expect(url.params).toEqual({ url: "http://x/{{secret:site_password}}" });
    expect(url.skipped).toEqual(["url"]);
    expect(substituteArgs("browser_type", { ref: "e1", text: "{{secret:missing}}" }, lookup).missing).toBe("missing");

    let seen = "";
    const tool = {
      name: "browser_type",
      execute: async (_id: string, params: { text?: string }): Promise<AgentToolResult> => {
        seen = params.text ?? "";
        return { content: [{ type: "text", text: "已输入" }], details: {} };
      },
    } as unknown as AgentTool;
    const [wrapped] = bindSecrets([tool], lookup);
    const missing = await wrapped?.execute("call", { ref: "e1", text: "{{secret:missing}}" });
    expect(seen).toBe("");
    expect(textOf(missing)).toContain("密钥 missing 不存在");
    const typed = await wrapped?.execute("call", { ref: "e1", text: "{{secret:site_password}}" });
    expect(seen).toBe(PASSWORD);
    expect(textOf(typed)).toBe("已输入");
    const shellTool = {
      name: "shell_exec",
      execute: async (): Promise<AgentToolResult> => ({ content: [{ type: "text", text: "ran" }], details: {} }),
    } as unknown as AgentTool;
    const [wrappedShell] = bindSecrets([shellTool], lookup);
    const kept = await wrappedShell?.execute("call", { cmd: "echo {{secret:site_password}}" });
    expect(textOf(kept)).toContain("字段 cmd 不支持密钥占位符，已原样保留");
  });

  it("masks values that JSON would escape and keeps the structure intact for short values", () => {
    const secrets = [
      { name: "site_password", value: PASSWORD },
      { name: "pin", value: "1" },
    ];
    const masked = maskDeep({ out: `got ${PASSWORD}`, nested: [{ code: 1, text: "pin=1" }], ok: true }, secrets);
    const json = JSON.stringify(masked);
    expect(json).not.toContain(PASSWORD_JSON);
    expect(masked).toEqual({
      out: "got {{secret:site_password}}",
      nested: [{ code: 1, text: "pin={{secret:pin}}" }],
      ok: true,
    });
  });

  it("keeps existing and newly generated placeholders intact when other secret values match their names", () => {
    const secrets = [
      { name: "site_password", value: "abc123456" },
      { name: "otp_123456", value: "123456" },
      { name: "site_text", value: "site" },
    ];
    const text = "{{secret:otp_123456}} abc123456 123456 site";
    const expected = "{{secret:otp_123456}} {{secret:site_password}} {{secret:otp_123456}} {{secret:site_text}}";
    expect(maskSecrets(text, secrets)).toBe(expected);
    expect(maskSecrets(expected, secrets)).toBe(expected);
  });
});

describe("secure form", () => {
  it("stores a password as ciphertext, drops the otp, and never echoes either value", async () => {
    const bodies: string[] = [];
    const frames: string[] = [];
    const machine = await fakeMachine();
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      if (bodies.length === 1) await firstGate;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(loginScript(body));
    });
    const started = await startApp(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` },
      { host: "127.0.0.1", port: machine.port, token: "token-a" },
    );
    const { app, ctx, alice, config } = started;
    const botId = await createBot(app, alice);
    ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["browser", "shell", "fs_write"] }), botId);
    const sent = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: auth(alice),
      payload: { text: "请登录测试站" },
    });
    expect(sent.statusCode).toBe(202);
    const taskId = sent.json().taskId as string;
    const conversationId = sent.json().conversationId as string;
    const socket = await app.injectWS("/ws", { headers: { origin: config.publicUrl, cookie: cookie(alice.token) } });
    socket.on("message", (data) => frames.push(data.toString()));
    socket.send(JSON.stringify({ type: "subscribe", conversationId }));
    releaseFirst();

    const passwordForm = await waitForSecret(app, alice, taskId);
    expect(passwordForm).toEqual({ name: "site_password", kind: "password" });
    expect(chatRepository(ctx.db).hasActiveForUser("user-a")).toBe(true);
    const provided = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/secrets`,
      headers: auth(alice),
      payload: { decision: "provide", name: "site_password", value: PASSWORD, save: true },
    });
    expect(provided.statusCode).toBe(200);
    expect(JSON.stringify(provided.json())).not.toContain(PASSWORD);

    const otpForm = await waitForSecret(app, alice, taskId);
    expect(otpForm).toEqual({ name: "site_otp", kind: "otp" });
    const otp = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/secrets`,
      headers: auth(alice),
      payload: { decision: "provide", name: "site_otp", value: OTP, save: true },
    });
    expect(otp.statusCode).toBe(200);
    await chatService(app).idle();

    const listed = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: auth(alice),
      payload: { text: "列出已保存的密钥名字", conversationId },
    });
    expect(listed.statusCode).toBe(202);
    await chatService(app).idle();

    expect(machine.inserted).toEqual([PASSWORD, OTP]);
    expect(machine.execs).toEqual([{ cmd: "printf %s \"$TOKEN\" # {{secret:site_password}}", token: PASSWORD }]);
    expect(machine.writes).toEqual([{ path: "/tmp/{{secret:site_password}}.txt", content: `secret=${PASSWORD}` }]);

    const rows = secretRepository(ctx.db).list(userScope("user-a"));
    expect(rows.map((row) => row.name)).toEqual(["site_password"]);
    expect(rows[0]?.scope).toBe("browser");
    expect(rows[0]?.valueEnc).not.toContain(PASSWORD);
    expect(decrypt(ctx.key, rows[0]?.valueEnc ?? "")).toBe(PASSWORD);

    const messages = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookie(alice.token) },
    });
    const steps = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/steps`,
      headers: { cookie: cookie(alice.token) },
    });
    const task = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: cookie(alice.token) },
    });
    expect(task.json().task.state).toBe("succeeded");
    const events = eventRepository(ctx.db).listByBot(botId).map((event) => event.attrsJson).join("\n");
    const files = readdirSync(config.dataDir).map((name) => readFileSync(join(config.dataDir, name), "utf8"));
    const corpus = [JSON.stringify(messages.json()), JSON.stringify(steps.json()), JSON.stringify(task.json()), events, frames.join("\n"), bodies.join("\n"), files.join("\n")].join("\n");
    expect(corpus).not.toContain(PASSWORD);
    expect(corpus).not.toContain(PASSWORD_JSON);
    expect(corpus).not.toContain(OTP);
    expect(JSON.stringify(steps.json())).toContain("{{secret:site_password}}");
    expect(JSON.stringify(steps.json())).toContain("{{secret:site_otp}}");
    const followUp = bodies[bodies.length - 1] ?? "";
    expect(followUp).toContain("site_password");
    expect(followUp).toContain("已保存的密钥");
    expect(chatRepository(ctx.db).hasActiveForUser("user-a")).toBe(false);
    socket.close();
  }, 20_000);

  it("rejects a missing csrf token and another user, then continues after a refusal", async () => {
    const machine = await fakeMachine();
    const modelPort = await listen(async (_req, res, body) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body.includes("用户拒绝提供") ? textSse("你拒绝了") : secretCall("call_pw", "site_password", "password"));
    });
    const { app, ctx, alice, bob } = await startApp(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_SECRET_WAIT_MS: "60000" },
      { host: "127.0.0.1", port: machine.port, token: "token-a" },
    );
    const botId = await createBot(app, alice);
    const sent = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: auth(alice),
      payload: { text: "请登录" },
    });
    const taskId = sent.json().taskId as string;
    await waitForSecret(app, alice, taskId);
    const csrf = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/secrets`,
      headers: { cookie: cookie(alice.token), "content-type": "application/json" },
      payload: { decision: "provide", name: "site_password", value: PASSWORD },
    });
    expect(csrf.statusCode).toBe(403);
    const foreign = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/secrets`,
      headers: auth(bob),
      payload: { decision: "provide", name: "site_password", value: PASSWORD },
    });
    expect(foreign.statusCode).toBe(404);
    const still = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: cookie(alice.token) },
    });
    expect(still.json().task.state).toBe("waiting_input");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/secrets`,
      headers: auth(alice),
      payload: { decision: "reject", name: "site_password" },
    });
    expect(rejected.statusCode).toBe(200);
    await chatService(app).idle();
    const done = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: cookie(alice.token) },
    });
    expect(done.json().task.state).toBe("succeeded");
    const messages = await app.inject({
      method: "GET",
      url: `/api/conversations/${sent.json().conversationId}/messages`,
      headers: { cookie: cookie(alice.token) },
    });
    const dumped = JSON.stringify(messages.json());
    expect(dumped).toContain("用户拒绝提供");
    expect(dumped).toContain("你拒绝了");
    expect(dumped).not.toContain(PASSWORD);
    expect(secretRepository(ctx.db).list(userScope("user-a"))).toEqual([]);
  }, 15_000);

  it("fails the task when the user does not answer in time", async () => {
    const machine = await fakeMachine();
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(secretCall("call_pw", "site_password", "password"));
    });
    const { app, ctx, alice } = await startApp(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_SECRET_WAIT_MS: "300" },
      { host: "127.0.0.1", port: machine.port, token: "token-a" },
    );
    const botId = await createBot(app, alice);
    const sent = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: auth(alice),
      payload: { text: "请登录" },
    });
    const taskId = sent.json().taskId as string;
    await waitForSecret(app, alice, taskId);
    expect(chatRepository(ctx.db).hasActiveForUser("user-a")).toBe(true);
    await chatService(app).idle();
    const task = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: cookie(alice.token) },
    });
    expect(task.json().task.state).toBe("failed");
    expect(task.json().task.error).toBe("等待用户输入超时");
    expect(chatRepository(ctx.db).hasActiveForUser("user-a")).toBe(false);
  }, 15_000);

  it("keeps waiting across a restart and continues after the user submits", async () => {
    const bodies: string[] = [];
    const machine = await fakeMachine();
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> };
      const last = parsed.messages[parsed.messages.length - 1];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(last?.role === "tool" ? textSse("接着跑完了") : secretCall("call_secret", "site_password", "password"));
    });
    const env = { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` };
    const endpoint = { host: "127.0.0.1", port: machine.port, token: "token-a" };
    const first = await startApp(env, endpoint);
    const botId = await createBot(first.app, first.alice);
    const sent = await first.app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: auth(first.alice),
      payload: { text: "请登录" },
    });
    const taskId = sent.json().taskId as string;
    const conversationId = sent.json().conversationId as string;
    await waitForSecret(first.app, first.alice, taskId);
    await closeApp(first.app);
    await delay(50);
    const waiting = chatRepository(first.ctx.db).findTask(userScope("user-a"), taskId);
    expect(waiting?.state).toBe("waiting_input");

    const second = await startApp(env, endpoint, first.ctx, first.config);
    const resumed = await second.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/secrets`,
      headers: auth(second.alice),
      payload: { decision: "provide", name: "site_password", value: PASSWORD, save: true },
    });
    expect(resumed.statusCode).toBe(200);
    await chatService(second.app).idle();
    const task = await second.app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: cookie(second.alice.token) },
    });
    const messages = await second.app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: cookie(second.alice.token) },
    });
    const dumped = JSON.stringify({ task: task.json(), messages: messages.json(), bodies });
    expect(task.json().task.state).toBe("succeeded");
    expect(dumped).toContain("接着跑完了");
    expect(dumped).toContain("已提供，用 {{secret:site_password}} 引用");
    expect(dumped).not.toContain("执行被中断");
    expect(dumped).not.toContain(PASSWORD);
  }, 15_000);

  it("cancels a live secret wait when the bot is deleted", async () => {
    const machine = await fakeMachine();
    const modelPort = await listen(async (_req, res, body) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body.includes("用户停止了任务") ? textSse("已停止") : secretCall("call_pw", "site_password", "password"));
    });
    const { app, ctx, alice } = await startApp(
      { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_SECRET_WAIT_MS: "60000" },
      { host: "127.0.0.1", port: machine.port, token: "token-a" },
    );
    const botId = await createBot(app, alice);
    const sent = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: auth(alice),
      payload: { text: "请登录" },
    });
    const taskId = sent.json().taskId as string;
    await waitForSecret(app, alice, taskId);
    const started = Date.now();
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/bots/${botId}`,
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(deleted.statusCode).toBe(200);
    expect(taskState(ctx, taskId)).toBe("cancelled");
    await chatService(app).idle();
  }, 15_000);

  it("cancels a restored secret wait when the bot is deleted", async () => {
    const machine = await fakeMachine();
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(secretCall("call_pw", "site_password", "password"));
    });
    const env = { VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, VB_SECRET_WAIT_MS: "60000" };
    const endpoint = { host: "127.0.0.1", port: machine.port, token: "token-a" };
    const first = await startApp(env, endpoint);
    const botId = await createBot(first.app, first.alice);
    const sent = await first.app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: auth(first.alice),
      payload: { text: "请登录" },
    });
    const taskId = sent.json().taskId as string;
    await waitForSecret(first.app, first.alice, taskId);
    await closeApp(first.app);
    await delay(50);
    expect(taskState(first.ctx, taskId)).toBe("waiting_input");

    const second = await startApp(env, endpoint, first.ctx, first.config);
    const deleted = await second.app.inject({
      method: "DELETE",
      url: `/api/bots/${botId}`,
      headers: { cookie: cookie(second.alice.token), "x-vb-csrf": second.alice.csrf },
    });
    expect(deleted.statusCode).toBe(200);
    expect(taskState(first.ctx, taskId)).toBe("cancelled");
    const messages = first.ctx.db.$client.prepare("select content_json from messages where task_id = ?").all(taskId) as Array<{ content_json: string }>;
    expect(messages.some((row) => row.content_json.includes("用户停止了任务"))).toBe(true);
  }, 15_000);
});

function loginScript(body: string): string {
  const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
  const messages = parsed.messages;
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    if (String(last.content).includes("列出")) return textSse("只有名字");
    return secretCall("call_pw", "site_password", "password");
  }
  const count = toolsSinceUser(messages);
  if (count === 1) return toolSse("call_open", "browser_open", { url: "http://127.0.0.1:8080/login" });
  if (count === 2 || count === 4 || count === 9) return toolSse(`call_snap_${count}`, "browser_snapshot", {});
  if (count === 3) return toolSse("call_type_pw", "browser_type", { ref: textboxRef(messages), text: "{{secret:site_password}}" });
  if (count === 5) {
    return toolSse("call_sh", "shell_exec", {
      cmd: "printf %s \"$TOKEN\" # {{secret:site_password}}",
      env: { TOKEN: "{{secret:site_password}}" },
    });
  }
  if (count === 6) {
    return toolSse("call_fs", "fs_write", {
      path: "/tmp/{{secret:site_password}}.txt",
      content: "secret={{secret:site_password}}",
    });
  }
  if (count === 7) return secretCall("call_otp", "site_otp", "otp");
  if (count === 8) return toolSse("call_type_otp", "browser_type", { ref: textboxRef(messages), text: "{{secret:site_otp}}" });
  return textSse("登录完成");
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

function textboxRef(messages: Array<{ role: string; content?: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") continue;
    const match = /\[(e\d+)\] textbox/.exec(String(message.content ?? ""));
    if (match?.[1]) return match[1];
  }
  return "e1";
}

function secretCall(id: string, name: string, kind: string): string {
  return toolSse(id, "request_secret", { name, label: kind === "otp" ? "验证码" : "网站密码", kind, reason: "登录需要" });
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

interface Machine {
  port: number;
  inserted: string[];
  execs: Array<{ cmd: string; token: string }>;
  writes: Array<{ path: string; content: string }>;
}

async function fakeMachine(): Promise<Machine> {
  const machine: Machine = { port: 0, inserted: [], execs: [], writes: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { cmd?: string; env?: { TOKEN?: string }; path?: string; content?: string };
      if (req.url === "/exec") {
        machine.execs.push({ cmd: body.cmd ?? "", token: body.env?.TOKEN ?? "" });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ type: "stdout", data: body.env?.TOKEN ?? "" })}\n\ndata: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
        return;
      }
      if (req.url === "/fs/write") {
        machine.writes.push({ path: body.path ?? "", content: body.content ?? "" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: body.path, bytes: Buffer.byteLength(body.content ?? "") }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  const values = new Map<string, string>();
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/browser/cdp")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id: number; method: string; sessionId?: string; params?: Record<string, unknown> };
      const params = message.params ?? {};
      const sessionId = message.sessionId ?? "";
      let result: unknown = {};
      if (message.method === "Target.createTarget") result = { targetId: "t1" };
      else if (message.method === "Target.attachToTarget") result = { sessionId: "s-t1" };
      else if (message.method === "Browser.getWindowForTarget") result = { windowId: 1 };
      else if (message.method === "Runtime.evaluate") {
        const expression = String(params.expression ?? "");
        const value = expression === "document.readyState" ? "complete" : expression === "location.href" ? "http://127.0.0.1:8080/login" : "";
        result = { result: { type: "string", value } };
      } else if (message.method === "Accessibility.getFullAXTree") {
        const typed = values.get(sessionId) ?? "";
        const nodes: Array<Record<string, unknown>> = [{ role: { value: "textbox" }, name: { value: "密码" }, backendDOMNodeId: 7 }];
        if (typed) nodes.push({ role: { value: "statictext" }, name: { value: typed }, backendDOMNodeId: 9 });
        result = { nodes };
      } else if (message.method === "Input.insertText") {
        const text = String(params.text ?? "");
        machine.inserted.push(text);
        values.set(sessionId, text);
      } else if (message.method === "DOM.resolveNode") result = { object: { objectId: sessionId || "obj" } };
      else if (message.method === "Runtime.callFunctionOn") result = { result: { value: values.get(sessionId) ?? "" } };
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  machine.port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return machine;
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

interface Running {
  app: FastifyInstance;
  ctx: ControlContext;
  config: ControlConfig;
  alice: Session;
  bob: Session;
}

const closedApps = new Set<FastifyInstance>();
const contexts = new Set<ControlContext>();

async function startApp(
  env: Record<string, string>,
  endpoint: { host: string; port: number; token: string },
  existing?: ControlContext,
  existingConfig?: ControlConfig,
): Promise<Running> {
  const config = existingConfig ?? loadConfig({
    VB_DATA_DIR: mkdtempSync(join(tmpdir(), "vb-secret-")),
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "super-secret-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
    ...env,
  });
  const ctx = existing ?? contextFor(config);
  if (!existing) {
    ensureDevUser(ctx.db, "user-a");
    ensureDevUser(ctx.db, "user-b");
    contexts.add(ctx);
    cleanups.push(async () => {
      if (!contexts.has(ctx)) return;
      contexts.delete(ctx);
      ctx.db.$client.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    });
  }
  const app = buildApp(ctx, {
    retryDelays: [0, 0],
    ensureMachine: async () => {},
    prepareEndpoint: async (_userId, onPhase) => {
      onPhase("ready");
      return endpoint;
    },
  });
  await app.ready();
  cleanups.push(() => closeApp(app));
  const now = new Date();
  return {
    app,
    ctx,
    config,
    alice: createSession(ctx.db, ctx.key, "user-a", `refresh-a-${now.getTime()}`, now),
    bob: createSession(ctx.db, ctx.key, "user-b", `refresh-b-${now.getTime()}`, now),
  };
}

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

async function closeApp(app: FastifyInstance): Promise<void> {
  if (closedApps.has(app)) return;
  closedApps.add(app);
  await app.close();
}

async function createBot(app: FastifyInstance, session: Session): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/bots",
    headers: auth(session),
    payload: { name: "Ada", model: "gpt-test" },
  });
  expect(created.statusCode).toBe(201);
  return created.json().bot.id as string;
}

function auth(session: Session): Record<string, string> {
  return { cookie: cookie(session.token), "x-vb-csrf": session.csrf, "content-type": "application/json" };
}

function cookie(token: string): string {
  return `vb_session=${token}`;
}

async function waitForSecret(app: FastifyInstance, session: Session, taskId: string): Promise<{ name: string; kind: string }> {
  let found: { name: string; kind: string } | undefined;
  await waitFor(async () => {
    const task = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: { cookie: cookie(session.token) } });
    if (task.json().task.state !== "waiting_input") return false;
    const steps = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/steps`, headers: { cookie: cookie(session.token) } });
    const step = [...(steps.json().steps as Array<{ kind: string; status: string; request: { args?: { name?: string; kind?: string } } }>)].reverse().find((item) => item.kind === "tool" && item.status === "running");
    if (!step?.request.args?.name || !step.request.args.kind) return false;
    found = { name: step.request.args.name, kind: step.request.args.kind };
    return true;
  });
  if (!found) throw new Error("没有等到安全表单");
  return found;
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  throw new Error("等待超时");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskState(ctx: ControlContext, taskId: string): string | undefined {
  const row = ctx.db.$client.prepare("select state from tasks where id = ?").get(taskId) as { state: string } | undefined;
  return row?.state;
}

function textOf(result: AgentToolResult | undefined): string {
  const block = result?.content[0];
  return block && block.type === "text" ? block.text : "";
}
