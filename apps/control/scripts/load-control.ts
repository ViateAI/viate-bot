/**
 * 控制面压测。不进 vitest。
 * 假模型 4421、假 machined 4422、控制面 4418，只绑 127.0.0.1。
 *
 * pnpm --filter @viate-bot/control exec tsx scripts/load-control.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const MODEL_PORT = 4421;
const MACHINE_PORT = 4422;
const CONTROL_PORT = 4418;
const TOKEN = "load-token";
const LEVELS = [10, 30, 60];
const SPECTATORS = 8;
const CHUNK_MS = 30;
const EXEC_MS = 80;
const FS_MS = 40;
const CDP_MS = 25;

const role = process.argv[2];
if (role === "model") {
  await serveModel();
} else if (role === "machine") {
  await serveMachine();
} else {
  await orchestrate();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 4_000_000) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveModel(): Promise<void> {
  let completions = 0;
  const server = createServer((req, res) => {
    void handleModel(req, res).catch((error: unknown) => fail(res, error));
  });
  await listen(server, MODEL_PORT);

  async function handleModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, completions }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ completions }));
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    completions += 1;
    const body = await readBody(req);
    const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
    const tools = (parsed.messages ?? []).filter((message) => message.role === "tool").length;
    const events = tools === 0
      ? toolEvents("call_shell", "shell_exec", JSON.stringify({ cmd: "echo load" }))
      : tools === 1
        ? toolEvents("call_fs", "fs_read", JSON.stringify({ path: "/tmp/load.txt" }))
        : tools === 2
          ? toolEvents("call_browser", "browser_open", JSON.stringify({ url: "https://example.com/" }))
          : textEvents();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const event of events) {
      await delay(CHUNK_MS);
      res.write(event);
    }
    res.end();
  }
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolEvents(id: string, name: string, args: string): string[] {
  return [
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: "" } }] }, finish_reason: null }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] }),
    sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, completion_tokens: 4 } }),
    "data: [DONE]\n\n",
  ];
}

function textEvents(): string[] {
  return [
    sse({ choices: [{ delta: { content: "完成" }, finish_reason: null }] }),
    sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2 } }),
    "data: [DONE]\n\n",
  ];
}

async function serveMachine(): Promise<void> {
  const stats = { exec: 0, fs: 0, skills: 0, cdp: 0, vnc: 0, display: 0 };
  const server = createServer((req, res) => {
    void handleMachine(req, res).catch((error: unknown) => fail(res, error));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!authorized(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/browser/cdp" && !url.pathname.endsWith("/vnc")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname.endsWith("/vnc")) {
        stats.vnc += 1;
        ws.on("error", () => undefined);
        return;
      }
      stats.cdp += 1;
      let seq = 0;
      ws.on("message", (data) => {
        void answerCdp(ws, data.toString(), () => {
          seq += 1;
          return seq;
        }).catch(() => ws.close());
      });
    });
  });
  await listen(server, MACHINE_PORT);

  async function handleMachine(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/stats")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...stats }));
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/skills") {
      stats.skills += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ skills: [] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/exec") {
      stats.exec += 1;
      await readBody(req);
      await delay(EXEC_MS);
      res.writeHead(200, { "content-type": "text/event-stream", "x-exec-id": "load-exec" });
      res.end(`data: ${JSON.stringify({ type: "stdout", data: "load\n" })}

data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}

`);
      return;
    }
    if (req.method === "POST" && url.pathname === "/exec/cancel") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stopped: true }));
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/fs/")) {
      stats.fs += 1;
      await readBody(req);
      await delay(FS_MS);
      const path = url.pathname === "/fs/read" ? "/tmp/load.txt" : "/tmp";
      res.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === "/fs/read") res.end(JSON.stringify({ path, content: "ok", truncated: false }));
      else if (url.pathname === "/fs/list") res.end(JSON.stringify({ path, entries: [] }));
      else if (url.pathname === "/fs/write") res.end(JSON.stringify({ path, bytes: 2 }));
      else if (url.pathname === "/fs/search") res.end(JSON.stringify({ path, matches: [] }));
      else res.end(JSON.stringify({ path }));
      return;
    }
    if (req.method === "POST" && /^\/displays\/\d+$/.test(url.pathname)) {
      stats.display += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ display: 1, mode: "shared", clip: { x: 0, y: 0, width: 1280, height: 720 } }));
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/vnc-mode")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404).end();
  }
}

async function answerCdp(ws: WebSocket, raw: string, nextId: () => number): Promise<void> {
  await delay(CDP_MS);
  const message = JSON.parse(raw) as { id?: number; method?: string; params?: Record<string, unknown> };
  if (typeof message.id !== "number") return;
  const method = message.method ?? "";
  const params = message.params ?? {};
  let result: unknown = {};
  if (method === "Target.createTarget") result = { targetId: `t${nextId()}` };
  else if (method === "Target.attachToTarget") result = { sessionId: `s-${String(params.targetId ?? "1")}` };
  else if (method === "Browser.getWindowForTarget") result = { windowId: 1 };
  else if (method === "Runtime.evaluate") {
    const expression = String(params.expression ?? "");
    let value: unknown = "ok";
    if (expression.includes("document.readyState")) value = "complete";
    else if (expression.includes("location.href") && expression.length < 40) value = "https://example.com/";
    else if (expression.includes("iframeUrls")) value = { url: "https://example.com/", iframeUrls: [], scriptUrls: [], markers: [] };
    else if (expression.includes("hasFocus")) value = true;
    result = { result: { type: value !== null && typeof value === "object" ? "object" : typeof value, value } };
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, result }));
}

function authorized(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(500, { "content-type": "text/plain" });
  res.end(error instanceof Error ? error.message : "error");
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function orchestrate(): Promise<void> {
  const script = fileURLToPath(import.meta.url);
  const children: ChildProcess[] = [];
  const dir = mkdtempSync(join(tmpdir(), "vb-m2f-load-"));
  let failed = false;
  const results: unknown[] = [];
  try {
    children.push(spawnChild(script, "model"), spawnChild(script, "machine"));
    await waitOk(`http://127.0.0.1:${MODEL_PORT}/health`);
    await waitOk(`http://127.0.0.1:${MACHINE_PORT}/health`);
    const started = await startControl(dir);
    try {
      for (const users of LEVELS) {
        const result = await runLevel(started, users);
        results.push(result);
        console.log(JSON.stringify(result));
        if (result.failed > 0) failed = true;
      }
    } catch (error) {
      console.error(error);
      failed = true;
    } finally {
      await started.close();
    }
  } finally {
    for (const child of children) {
      child.kill("SIGTERM");
    }
    await delay(200);
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ levels: results }, null, 2));
  if (failed) process.exitCode = 1;
}

function spawnChild(script: string, name: string): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", script, name], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`${name} exited ${code}: ${stderr}`);
  });
  return child;
}

async function waitOk(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "connect";
    }
    await delay(100);
  }
  throw new Error(`${url} not ready: ${last}`);
}

interface WriteProbe {
  measuring: boolean;
  writes: number[];
}

interface RunningControl {
  base: string;
  db: import("../src/db/index.js").AppDatabase;
  probe: WriteProbe;
  close: () => Promise<void>;
  createUser: (index: number) => Promise<{ userId: string; botId: string; token: string; csrf: string }>;
}

async function startControl(dir: string): Promise<RunningControl> {
  process.env.VB_DEV = "1";
  process.env.VB_DATA_DIR = dir;
  process.env.VB_CONTROL_PORT = String(CONTROL_PORT);
  process.env.VB_PUBLIC_URL = `http://127.0.0.1:${CONTROL_PORT}`;
  process.env.VB_MODEL_BASE_URL = `http://127.0.0.1:${MODEL_PORT}/v1`;
  process.env.VB_MODEL_API_KEY = "load-key";
  process.env.VB_MODEL_API = "openai-completions";
  process.env.VB_MAX_RUNNING_TASKS = "64";
  process.env.VB_MODEL_RATE_USER = "200";
  process.env.VB_MODEL_RATE_BOT = "200";
  process.env.VB_INTEGRATION = "none";
  process.env.VB_ALLOW_SIGNUP = "false";
  process.env.VITEST = "true";
  const { buildApp, openContext } = await import("../src/app.js");
  const { createBot } = await import("../src/bot-service.js");
  const { createRuntime } = await import("../src/compose.js");
  const { loadConfig } = await import("../src/config.js");
  const { ensureDevUser } = await import("../src/db/users.js");
  const { userScope } = await import("../src/scope.js");
  const { createSession } = await import("../src/session.js");
  const config = loadConfig();
  const ctx = openContext(config);
  const runtime = createRuntime(config, ctx.db);
  const probe: WriteProbe = { measuring: false, writes: [] };
  const sqlite = ctx.db.$client;
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    if (!/^\s*(insert|update|delete|replace)/i.test(sql)) return stmt;
    const run = stmt.run.bind(stmt);
    stmt.run = ((...args: unknown[]) => {
      const started = process.hrtime.bigint();
      const result = run(...args);
      if (probe.measuring) probe.writes.push(Number(process.hrtime.bigint() - started) / 1e6);
      return result;
    }) as typeof stmt.run;
    return stmt;
  }) as typeof sqlite.prepare;
  const app = buildApp(ctx, {
    prepareEndpoint: async () => ({ host: "127.0.0.1", port: MACHINE_PORT, token: TOKEN }),
    ensureMachine: async () => {},
  });
  await app.listen({ host: "127.0.0.1", port: CONTROL_PORT });
  let serial = 0;
  return {
    base: `http://127.0.0.1:${CONTROL_PORT}`,
    db: ctx.db,
    probe,
    close: async () => {
      await app.close();
      await delay(100);
      ctx.db.$client.close();
    },
    createUser: async (index) => {
      serial += 1;
      const userId = `load-${index}-${serial}`;
      ensureDevUser(ctx.db, userId, { maxConcurrentTasks: 2 });
      const bot = await createBot(
        { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
        userScope(userId),
        { name: userId, model: "load-model" },
      );
      ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["shell", "browser"] }), bot.id);
      const session = createSession(ctx.db, ctx.key, userId, "load-refresh", new Date());
      return { userId, botId: bot.id, token: session.token, csrf: session.csrf };
    },
  };
}

async function runLevel(control: RunningControl, users: number): Promise<{
  users: number;
  spectators: number;
  succeeded: number;
  failed: number;
  failures: string[];
  spectatorErrors: string[];
  eventLoopMs: { p50: number; p99: number; max: number };
  rssMb: { start: number; max: number; end: number };
  sqliteWriteMs: { n: number; p50: number; p99: number; max: number };
  taskMs: { n: number; p50: number; p99: number; max: number };
  machined: unknown;
  model: unknown;
}> {
  const accounts = [];
  for (let index = 0; index < users; index += 1) accounts.push(await control.createUser(index));
  const beforeModel = await fetch(`http://127.0.0.1:${MODEL_PORT}/stats`).then((response) => response.json() as Promise<{ completions: number }>);
  const beforeMachine = await fetch(`http://127.0.0.1:${MACHINE_PORT}/stats`).then((response) => response.json() as Promise<Record<string, number>>);
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  control.probe.writes.length = 0;
  control.probe.measuring = true;
  const rss: number[] = [process.memoryUsage().rss];
  const rssTimer = setInterval(() => rss.push(process.memoryUsage().rss), 200);
  rssTimer.unref();
  const sockets: WebSocket[] = [];
  const spectatorErrors: string[] = [];
  let startedAt = Date.now();
  try {
    for (const account of accounts.slice(0, SPECTATORS)) {
      const socketId = randomBytes(16).toString("hex");
      const ws = new WebSocket(`${control.base.replace("http", "ws")}/api/bots/${account.botId}/screen/vnc?socket=${socketId}`, {
        headers: { cookie: `vb_session=${account.token}`, origin: control.base },
      });
      sockets.push(ws);
      ws.on("error", (error: Error) => spectatorErrors.push(error.message));
      ws.on("unexpected-response", (_request, response) => {
        spectatorErrors.push(`upgrade ${response.statusCode ?? 0}`);
      });
    }
    await Promise.all(sockets.map((ws) => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      const timer = setTimeout(resolve, 2000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", () => { clearTimeout(timer); resolve(); });
    })));
    startedAt = Date.now();
    const posts = await Promise.all(accounts.map(async (account) => {
      const response = await fetch(`${control.base}/api/bots/${account.botId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `vb_session=${account.token}`,
          "x-vb-csrf": account.csrf,
        },
        body: JSON.stringify({ text: "跑一遍 shell、文件和浏览器", mode: "queue" }),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${body}`);
      return JSON.parse(body) as { taskId: string };
    }));
    const ids = posts.map((post) => post.taskId);
    const deadline = Date.now() + 120_000;
    let rows: Array<{ id: string; state: string; error: string | null; endedAt: string | null }> = [];
    while (Date.now() < deadline) {
      rows = control.db.$client.prepare(
        `select id, state, error, ended_at as endedAt from tasks where id in (${ids.map(() => "?").join(",")})`,
      ).all(...ids) as typeof rows;
      if (rows.length === ids.length && rows.every((row) => row.state === "succeeded" || row.state === "failed" || row.state === "cancelled")) break;
      await delay(200);
    }
    const taskMs = rows
      .filter((row) => row.state === "succeeded" && row.endedAt)
      .map((row) => Date.parse(row.endedAt!) - startedAt);
    const failures = rows.filter((row) => row.state !== "succeeded").slice(0, 5).map((row) => `${row.state}:${row.error ?? ""}`);
    const pending = ids.length - rows.filter((row) => row.state === "succeeded" || row.state === "failed" || row.state === "cancelled").length;
    if (pending > 0) failures.push(`pending:${pending}`);
    histogram.disable();
    const afterModel = await fetch(`http://127.0.0.1:${MODEL_PORT}/stats`).then((response) => response.json() as Promise<{ completions: number }>);
    const afterMachine = await fetch(`http://127.0.0.1:${MACHINE_PORT}/stats`).then((response) => response.json() as Promise<Record<string, number>>);
    const writes = control.probe.writes.slice();
    return {
      users,
      spectators: sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length,
      spectatorErrors: spectatorErrors.slice(0, 3),
      succeeded: rows.filter((row) => row.state === "succeeded").length,
      failed: users - rows.filter((row) => row.state === "succeeded").length,
      failures,
      eventLoopMs: {
        p50: round(histogram.percentile(50) / 1e6),
        p99: round(histogram.percentile(99) / 1e6),
        max: round(histogram.max / 1e6),
      },
      rssMb: {
        start: round(rss[0]! / 1048576),
        max: round(Math.max(...rss) / 1048576),
        end: round(rss[rss.length - 1]! / 1048576),
      },
      sqliteWriteMs: {
        n: writes.length,
        p50: round(percentile(writes, 50)),
        p99: round(percentile(writes, 99)),
        max: round(writes.length === 0 ? 0 : Math.max(...writes)),
      },
      taskMs: {
        n: taskMs.length,
        p50: round(percentile(taskMs, 50)),
        p99: round(percentile(taskMs, 99)),
        max: round(taskMs.length === 0 ? 0 : Math.max(...taskMs)),
      },
      machined: diffCounts(beforeMachine, afterMachine),
      model: { completions: afterModel.completions - beforeModel.completions },
    };
  } finally {
    control.probe.measuring = false;
    clearInterval(rssTimer);
    histogram.disable();
    await Promise.all(sockets.map((ws) => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(resolve, 1000);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close();
    })));
  }
}

function diffCounts(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(after)) {
    if (key === "ok") continue;
    out[key] = after[key]! - (before[key] ?? 0);
  }
  return out;
}
