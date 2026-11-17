/**
 * 机器侧 MCP。stdio 与远程连接都从本机发起，控制面只走 JSON-RPC。
 * 命令是单个可执行令牌，不经过 shell。url 和 headers 不做占位符展开，也不跟随跳转。
 * WebSocket 升级不走 Fastify 的 onRequest，因此这里复用同一把 Bearer。
 * browser-route 会拆掉非 /browser/cdp 的升级；挂到同一个 server 之前要先放过 /mcp/。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join, posix, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { McpRemoteStartRequest, McpStartResponse, McpStdioStartRequest } from "@viate-bot/protocol";
import { WebSocketServer, type RawData } from "ws";
import { killProcessGroup } from "./process-group.js";

const MAX_MESSAGE = 1024 * 1024;
const MAX_SESSIONS = 16;

export class McpError extends Error {
  readonly statusCode: number;
  /** 对端返回了完整的 JSON-RPC error。这是业务失败，不是传输未知。 */
  readonly rpc: boolean;
  constructor(message: string, statusCode = 400, rpc = false) {
    super(message);
    this.name = "McpError";
    this.statusCode = statusCode;
    this.rpc = rpc;
  }
}

export interface StdioLaunch extends McpStdioStartRequest {
  pluginRoot?: string;
  pluginData?: string;
}

export interface RemoteLaunch extends McpRemoteStartRequest {
  transport?: "streamable-http" | "sse";
  /** 配置注入的头。跨源跳转时连同 Authorization 一起丢掉。 */
  injectedHeaders?: readonly string[];
}

export interface McpHost {
  startStdio(server: string, request: StdioLaunch): Promise<McpStartResponse>;
  startRemote(server: string, request: RemoteLaunch): Promise<McpStartResponse>;
  call(server: string, method: string, params?: unknown): Promise<unknown>;
  status(server: string): { queued: number; active: number | null; unconfirmed: number[] } | undefined;
  stop(server: string): Promise<void>;
  close(): Promise<void>;
}

export interface McpHostOptions {
  homeDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface McpRouteOptions {
  token: string;
}

interface Session {
  call(method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
  status(): { queued: number; active: number | null; unconfirmed: number[] };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function assertMcpRemoteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError("远程 MCP 地址无效");
  }
  if (url.username || url.password || url.hash) throw new McpError("远程 MCP 地址无效");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new McpError("远程 MCP 地址无效");
  if (url.protocol === "http:" && !isLoopback(url.hostname)) throw new McpError("远程 MCP 必须使用 HTTPS");
  return url;
}

export function createMcpHost(options: McpHostOptions = {}): McpHost {
  const sessions = new Map<string, Session>();
  const refs = new Map<string, number>();
  const opening = new Map<string, Promise<void>>();
  const finishers = new Map<string, () => void>();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let closed = false;

  async function claim(server: string): Promise<"reuse" | "create"> {
    assertServerName(server);
    if (closed) throw new McpError("MCP 已关闭");
    const pending = opening.get(server);
    if (pending) {
      await pending;
      if (!sessions.has(server)) throw new McpError("MCP 未启动");
      refs.set(server, (refs.get(server) ?? 1) + 1);
      return "reuse";
    }
    if (sessions.has(server)) {
      refs.set(server, (refs.get(server) ?? 1) + 1);
      return "reuse";
    }
    if (sessions.size >= MAX_SESSIONS) throw new McpError("MCP 进程过多");
    const gate = Promise.withResolvers<void>();
    opening.set(server, gate.promise);
    finishers.set(server, gate.resolve);
    refs.set(server, 1);
    return "create";
  }

  function finishClaim(server: string): void {
    finishers.get(server)?.();
    finishers.delete(server);
    opening.delete(server);
  }

  async function startStdio(server: string, request: StdioLaunch): Promise<McpStartResponse> {
    if (await claim(server) === "reuse") return { server, running: true };
    try {
      const cwd = request.cwd ?? request.pluginRoot;
      if (!cwd) throw new McpError("缺少工作目录");
      if (options.homeDir) await assertInside(options.homeDir, cwd);
      if (request.pluginRoot && options.homeDir) await assertInside(options.homeDir, request.pluginRoot);
      if (request.pluginData && options.homeDir) await assertInside(options.homeDir, request.pluginData);
      if (request.pluginData) await mkdir(request.pluginData, { recursive: true });
      const command = await resolveCommand(request.command, cwd, options.homeDir);
      const session = new StdioSession(command, request.args ?? [], cwd, stdioEnv(request, options.homeDir), timeoutMs);
      try {
        await session.start();
      } catch (error) {
        await session.close();
        throw error;
      }
      sessions.set(server, session);
      return { server, running: true };
    } catch (error) {
      refs.delete(server);
      throw error;
    } finally {
      finishClaim(server);
    }
  }

  async function startRemote(server: string, request: RemoteLaunch): Promise<McpStartResponse> {
    if (await claim(server) === "reuse") return { server, running: true };
    try {
      const url = assertMcpRemoteUrl(request.url);
      const headers = checkHeaders(request.headers);
      const injected = request.injectedHeaders ?? [];
      const session = request.transport === "sse"
        ? new SseSession(url, headers, injected, fetchImpl, timeoutMs)
        : new HttpSession(url, headers, injected, fetchImpl, timeoutMs);
      try {
        await session.start();
      } catch (error) {
        await session.close();
        throw error;
      }
      sessions.set(server, session);
      return { server, running: true };
    } catch (error) {
      refs.delete(server);
      throw error;
    } finally {
      finishClaim(server);
    }
  }

  async function call(server: string, method: string, params?: unknown): Promise<unknown> {
    const session = sessions.get(server);
    if (!session) throw new McpError("MCP 未启动");
    if (params === undefined) return session.call(method, {});
    return session.call(method, params);
  }

  async function stop(server: string): Promise<void> {
    const left = (refs.get(server) ?? 0) - 1;
    if (left > 0) {
      refs.set(server, left);
      return;
    }
    refs.delete(server);
    const session = sessions.get(server);
    if (!session) return;
    sessions.delete(server);
    await session.close();
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    refs.clear();
    const running = [...sessions.values()];
    sessions.clear();
    await Promise.all(running.map((session) => session.close()));
  }

  function status(server: string): { queued: number; active: number | null; unconfirmed: number[] } | undefined {
    return sessions.get(server)?.status();
  }

  return { startStdio, startRemote, call, status, stop, close };
}

export function registerMcpRoutes(app: FastifyInstance, host: McpHost, options: McpRouteOptions): void {
  const wss = new WebSocketServer({ noServer: true });
  const upgrading = new Set<Duplex>();
  let closing = false;
  const stopSockets = (): void => {
    closing = true;
    for (const socket of upgrading) socket.destroy();
    for (const client of wss.clients) client.terminate();
  };
  app.addHook("preClose", async () => {
    stopSockets();
  });
  app.addHook("onClose", async () => {
    stopSockets();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await host.close();
  });

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/mcp/")) return;
    void acceptUpgrade(request, socket, head, url).catch(() => {
      if (!socket.destroyed) socket.destroy();
    });
  });

  app.post("/mcp/stdio", async (request) => {
    const body = asObject(request.body);
    const server = requiredString(body.server);
    const command = requiredString(body.command);
    const args = body.args === undefined ? undefined : stringList(body.args);
    const env = body.env === undefined ? undefined : stringRecord(body.env);
    const cwd = body.cwd === undefined ? undefined : requiredString(body.cwd);
    const pluginRoot = body.pluginRoot === undefined ? undefined : requiredString(body.pluginRoot);
    const pluginData = body.pluginData === undefined ? undefined : requiredString(body.pluginData);
    return host.startStdio(server, {
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      ...(pluginRoot ? { pluginRoot } : {}),
      ...(pluginData ? { pluginData } : {}),
    });
  });

  app.post("/mcp/remote", async (request) => {
    const body = asObject(request.body);
    const server = requiredString(body.server);
    const url = requiredString(body.url);
    const headers = body.headers === undefined ? undefined : stringRecord(body.headers);
    const injectedHeaders = body.injectedHeaders === undefined ? undefined : stringList(body.injectedHeaders);
    const transport = body.transport === "sse" ? "sse" : body.transport === "streamable-http" ? "streamable-http" : undefined;
    return host.startRemote(server, {
      url,
      ...(headers ? { headers } : {}),
      ...(injectedHeaders ? { injectedHeaders } : {}),
      ...(transport ? { transport } : {}),
    });
  });

  app.post("/mcp/:server/rpc", async (request) => rpcResponse(host, routeServer(request.params), request.body));

  app.delete("/mcp/:server", async (request) => {
    const server = routeServer(request.params);
    await host.stop(server);
    return { server, running: false };
  });

  async function acceptUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
    if (closing) {
      socket.destroy();
      return;
    }
    upgrading.add(socket);
    socket.once("close", () => upgrading.delete(socket));
    try {
      if (request.headers.authorization !== `Bearer ${options.token}`) {
        rejectUpgrade(socket, 401, "Unauthorized", "未认证");
        return;
      }
      const server = decodeServer(url.pathname.slice("/mcp/".length));
      wss.handleUpgrade(request, socket, head, (client) => {
        if (closing) {
          client.terminate();
          return;
        }
        client.on("message", (data) => {
          void onSocketMessage(client, server, data, host);
        });
      });
    } finally {
      upgrading.delete(socket);
    }
  }
}

async function onSocketMessage(
  client: { send: (data: string) => void; close: (code?: number, reason?: string) => void },
  server: string,
  data: RawData,
  host: McpHost,
): Promise<void> {
  const text = rawText(data);
  if (text.length > MAX_MESSAGE) {
    client.close(1009, "消息过大");
    return;
  }
  const response = await rpcResponseText(text, async (method, params) => {
    if (params === undefined) return host.call(server, method);
    return host.call(server, method, params);
  });
  if (response) client.send(response);
}

async function rpcResponse(host: McpHost, server: string, body: unknown): Promise<unknown> {
  const message = isObject(body) ? body : undefined;
  if (!message || typeof message.method !== "string") throw new McpError("MCP 请求无效");
  if (message.id === undefined) return { jsonrpc: "2.0" };
  try {
    const result = await host.call(server, message.method, message.params);
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    return { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof McpError ? error.message : "MCP 调用失败" } };
  }
}

async function rpcResponseText(text: string, call: (method: string, params: unknown) => Promise<unknown>): Promise<string | undefined> {
  let message: unknown;
  try {
    message = JSON.parse(text) as unknown;
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "MCP 请求无效" } });
  }
  if (!isObject(message) || typeof message.method !== "string") return undefined;
  if (message.id === undefined) return undefined;
  try {
    const result = await call(message.method, message.params);
    return JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: error instanceof McpError ? error.message : "MCP 调用失败" },
    });
  }
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string, error: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = JSON.stringify({ error });
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
}

class StdioSession implements Session {
  private readonly child: ChildProcess;
  private exited: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private nextId = 1;
  private shutdown = false;
  private dead = false;
  private queued: Array<{ id: number; method: string; params: unknown }> = [];
  private activeId: number | null = null;
  private blocked = false;
  private readonly cancelRequested = new Set<number>();
  private readonly unconfirmed = new Set<number>();

  constructor(command: string, args: string[], cwd: string, env: Record<string, string>, private readonly timeoutMs: number) {
    const exited = Promise.withResolvers<void>();
    this.exited = exited.promise;
    this.child = spawn(command, args, {
      cwd, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
      ...(process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : {}),
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.resume();
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.once("error", () => this.fail(new McpError("MCP 进程启动失败", 502)));
    this.child.once("close", () => {
      this.fail(new McpError("MCP 进程已退出", 502));
      exited.resolve();
    });
  }

  async start(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "viate-machined", version: "0.0.0" },
    });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.shutdown || this.dead) return Promise.reject(new McpError("MCP 进程已退出", 502));
    const id = this.nextId;
    this.nextId += 1;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.pending.set(String(id), { resolve, reject, timer: setTimeout(() => undefined, 1) });
    this.queued.push({ id, method, params });
    this.pump();
    return promise;
  }

  status(): { queued: number; active: number | null; unconfirmed: number[] } {
    return { queued: this.queued.length, active: this.activeId, unconfirmed: [...this.unconfirmed] };
  }

  async close(): Promise<void> {
    if (this.shutdown) {
      await this.exited;
      return;
    }
    this.shutdown = true;
    await killProcessGroup(this.child.pid);
    this.child.stdin?.destroy();
    await this.exited;
  }

  private write(message: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private pump(): void {
    if (this.activeId !== null || this.blocked || this.dead || this.shutdown) return;
    const next = this.queued.shift();
    if (!next) return;
    this.activeId = next.id;
    const pending = this.pending.get(String(next.id));
    if (pending) {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.requestCancel(next.id), this.timeoutMs);
    }
    this.write({ jsonrpc: "2.0", id: next.id, method: next.method, params: next.params });
  }

  private requestCancel(id: number): void {
    if (this.activeId !== id || this.dead || this.shutdown) return;
    void this.close().catch(() => this.fail(new McpError("remote_unconfirmed")));
  }

  private markUnconfirmed(id: number): void {
    if (!this.pending.has(String(id)) || this.dead) return;
    this.unconfirmed.add(id);
    this.blocked = true;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_MESSAGE) {
      void this.close().catch(() => this.fail(new McpError("remote_unconfirmed")));
      return;
    }
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      void this.close().catch(() => this.fail(new McpError("remote_unconfirmed")));
      return;
    }
    if (!isObject(message) || (typeof message.id !== "number" && typeof message.id !== "string")) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.id));
    if (message.error !== undefined) pending.reject(new McpError("MCP 调用失败"));
    else if (this.cancelRequested.has(Number(message.id))) pending.reject(new McpError("MCP 调用已取消"));
    else pending.resolve(message.result);
    this.cancelRequested.delete(Number(message.id));
    this.unconfirmed.delete(Number(message.id));
    if (this.activeId === Number(message.id)) this.activeId = null;
    if (this.unconfirmed.size === 0) this.blocked = false;
    this.pump();
  }

  private fail(error: Error): void {
    this.dead = true;
    this.blocked = false;
    this.activeId = null;
    this.queued = [];
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class HttpSession implements Session {
  private sessionId: string | undefined;
  private readonly controller = new AbortController();
  private nextId = 1;
  private readonly unconfirmed = new Set<number>();
  private readonly held = new Map<number, (error: Error) => void>();

  constructor(
    private readonly url: URL,
    private readonly configured: Record<string, string>,
    private readonly injected: readonly string[],
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
  ) {}

  async start(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "viate-machined", version: "0.0.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    try {
      return await this.post({ jsonrpc: "2.0", id, method, params }, id);
    } catch (error) {
      if (this.controller.signal.aborted) throw error;
      // 只有 tools/call 有副作用。请求已经发出、又没有完整 RPC 结果时，不能当成确定失败。
      // 连接被拒绝说明请求没派发出去；initialize 和 tools/list 失败也不把会话留在未确认。
      if (method !== "tools/call" || error instanceof McpError && error.rpc || requestWasNotDispatched(error)) throw error;
      this.unconfirmed.add(id);
      return await new Promise((resolve, reject) => {
        this.held.set(id, reject);
        void resolve;
      });
    }
  }

  status(): { queued: number; active: number | null; unconfirmed: number[] } {
    return { queued: 0, active: null, unconfirmed: [...this.unconfirmed] };
  }

  async close(): Promise<void> {
    this.controller.abort();
    for (const reject of this.held.values()) reject(new McpError("remote_unconfirmed"));
    this.held.clear();
  }

  private async post(message: unknown, id?: number): Promise<unknown> {
    const followed = await fetchFollowing({
      url: this.url,
      method: "POST",
      headers: this.headers({ accept: "application/json, text/event-stream", "content-type": "application/json" }),
      body: JSON.stringify(message),
      injected: this.injected,
      fetchImpl: this.fetchImpl,
      signal: this.controller.signal,
      timeoutMs: this.timeoutMs,
    });
    const response = followed.response;
    const session = response.headers.get("mcp-session-id");
    if (session && !session.includes("\n") && !session.includes("\r")) this.sessionId = session;
    const toolCall = isObject(message) && message.method === "tools/call";
    if (response.status === 202 || response.status === 204) {
      if (toolCall) throw new McpError("MCP 响应不完整");
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpError("远程 MCP 连接失败", 502);
    }
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) return readSseResult(response.body, id);
    const text = await response.text();
    if (text.length > MAX_MESSAGE) throw new McpError("MCP 响应过大");
    if (!text) {
      if (toolCall) throw new McpError("MCP 响应不完整");
      return undefined;
    }
    const payload = JSON.parse(text) as unknown;
    if (!isObject(payload)) throw new McpError("MCP 响应无效");
    const idMatches = id === undefined || (payload.id !== undefined && String(payload.id) === String(id));
    if (payload.error !== undefined) {
      if (!idMatches) throw new McpError("MCP 响应不匹配");
      throw new McpError("MCP 调用失败", 400, true);
    }
    if (!idMatches || (toolCall && !("result" in payload))) throw new McpError("MCP 响应不完整");
    return payload.result;
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    const headers = { ...extra };
    for (const [key, value] of Object.entries(this.configured)) {
      if (reservedHeader(key)) continue;
      headers[key] = value;
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    headers["mcp-protocol-version"] = "2025-06-18";
    return headers;
  }
}

class SseSession implements Session {
  private endpoint: string | undefined;
  private endpointSeen = false;
  private pendingReady: (() => void) | undefined;
  private markFailed: ((error: Error) => void) | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly unconfirmed = new Set<number>();
  private readonly controller = new AbortController();
  private nextId = 1;
  private shutdown = false;

  constructor(
    private readonly url: URL,
    private readonly configured: Record<string, string>,
    private readonly injected: readonly string[],
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
  ) {}

  private connected: URL | undefined;

  async start(): Promise<void> {
    const followed = await fetchFollowing({
      url: this.url,
      method: "GET",
      headers: this.headers({ accept: "text/event-stream" }),
      injected: this.injected,
      fetchImpl: this.fetchImpl,
      signal: this.controller.signal,
      timeoutMs: this.timeoutMs,
    });
    const response = followed.response;
    this.connected = followed.url;
    if (!response.ok || !response.body) throw new McpError("远程 MCP 连接失败", 502);
    void this.pump(response.body);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new McpError("MCP 调用超时")), this.timeoutMs);
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.pendingReady = finish;
      this.markFailed = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      if (this.endpointSeen) finish();
    });
    await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "viate-machined", version: "0.0.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const waiter = this.expect(id);
    void this.post({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
      const pending = this.pending.get(String(id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(id));
      pending.reject(error instanceof Error ? error : new McpError("MCP 调用失败"));
    });
    return waiter;
  }

  status(): { queued: number; active: number | null; unconfirmed: number[] } {
    return { queued: this.pending.size, active: null, unconfirmed: [...this.unconfirmed] };
  }

  async close(): Promise<void> {
    if (this.shutdown) return;
    this.shutdown = true;
    this.controller.abort();
    this.fail(new McpError("MCP 已关闭"));
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.shutdown) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > MAX_MESSAGE) throw new McpError("MCP 响应过大");
        const events = buffer.split(/\n\n/);
        buffer = events.pop() ?? "";
        for (const event of events) this.onEvent(event);
      }
    } catch (error) {
      if (!this.shutdown) this.fail(error instanceof Error ? error : new McpError("远程 MCP 连接失败", 502));
    }
  }

  private onEvent(event: string): void {
    const name = event.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = sseData(event);
    if (!data) return;
    if (!this.endpointSeen && (name === "endpoint" || data.startsWith("/") || data.startsWith("http"))) {
      let resolved: URL;
      try {
        resolved = new URL(data, this.url);
      } catch {
        this.fail(new McpError("远程 MCP 端点越界"));
        return;
      }
      if (resolved.origin !== (this.connected ?? this.url).origin) {
        this.fail(new McpError("远程 MCP 端点越界"));
        return;
      }
      this.endpoint = resolved.toString();
      this.endpointSeen = true;
      this.pendingReady?.();
      if (name === "endpoint" || !data.startsWith("{")) return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (!isObject(message) || (typeof message.id !== "number" && typeof message.id !== "string")) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.id));
    if (message.error !== undefined) pending.reject(new McpError("MCP 调用失败"));
    else pending.resolve(message.result);
  }

  private async post(message: unknown): Promise<void> {
    if (!this.endpoint) throw new McpError("远程 MCP 连接失败", 502);
    const followed = await fetchFollowing({
      url: new URL(this.endpoint),
      method: "POST",
      headers: this.headers({ accept: "application/json, text/event-stream", "content-type": "application/json" }),
      body: JSON.stringify(message),
      injected: this.injected,
      fetchImpl: this.fetchImpl,
      signal: this.controller.signal,
      timeoutMs: this.timeoutMs,
    });
    const response = followed.response;
    if (response.status !== 202 && response.status !== 204 && !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpError("远程 MCP 连接失败", 502);
    }
    await response.body?.cancel().catch(() => undefined);
  }

  private expect(id: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.unconfirmed.add(id);
      }, this.timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
    });
  }

  private fail(error: Error): void {
    this.markFailed?.(error);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.unconfirmed.has(Number(id)) ? new McpError("remote_unconfirmed") : error);
    }
    this.pending.clear();
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    const headers = { ...extra };
    for (const [key, value] of Object.entries(this.configured)) {
      if (reservedHeader(key)) continue;
      headers[key] = value;
    }
    return headers;
  }
}

function stdioEnv(request: StdioLaunch, homeDir: string | undefined): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeDir ?? "/home/bot",
    USER: "bot",
    LOGNAME: "bot",
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!key || key.includes("\0") || value.includes("\0")) throw new McpError("MCP 环境无效");
    if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") continue;
    env[key] = value;
  }
  if (request.pluginRoot) env.PLUGIN_ROOT = request.pluginRoot;
  if (request.pluginData) env.PLUGIN_DATA = request.pluginData;
  return env;
}

async function resolveCommand(command: string, cwd: string, homeDir: string | undefined): Promise<string> {
  if (!command || command.includes("\0") || /\s/.test(command)) throw new McpError("MCP 命令无效");
  if (/^[A-Za-z0-9_+.-]+$/.test(command)) return command;
  let full = command;
  if (command.startsWith("./")) {
    const relative = command.slice(2);
    if (!relative || relative.split("/").includes("..")) throw new McpError("MCP 命令无效");
    full = join(cwd, relative);
  } else if (!command.startsWith("/") || command.split("/").includes("..")) {
    throw new McpError("MCP 命令无效");
  }
  let real: string;
  try {
    real = await realpath(full);
  } catch {
    throw new McpError("MCP 命令不存在");
  }
  const info = await stat(real);
  if (!info.isFile()) throw new McpError("MCP 命令无效");
  if (homeDir) await assertInside(homeDir, real);
  if ((info.mode & 0o111) === 0) await chmod(real, (info.mode & 0o777) | 0o755);
  return real;
}

async function assertInside(homeDir: string, target: string): Promise<void> {
  const home = await realpath(homeDir);
  const real = await realpath(target);
  if (real !== home && !real.startsWith(`${home}${sep}`)) throw new McpError("工作目录越界");
}

function checkHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const seen = new Set<string>();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (seen.has(lower) || !/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(key)) throw new McpError("远程 MCP 头无效");
    if (value.includes("\r") || value.includes("\n") || value.includes("\0")) throw new McpError("远程 MCP 头无效");
    seen.add(lower);
    out[key] = value;
  }
  return out;
}

function reservedHeader(key: string): boolean {
  return ["host", "content-length", "connection", "transfer-encoding", "accept", "content-type"].includes(key.toLowerCase());
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(match?.slice(1).every((part) => Number(part) <= 255));
}

function isRedirect(status: number): boolean {
  return status === 0 || (status >= 300 && status < 400);
}

function sameOrigin(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

/** 连接根本没建立。请求没有派发出去，不能当成远端可能已执行。 */
function requestWasNotDispatched(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && (current.code === "ECONNREFUSED" || current.code === "ENOTFOUND" || current.code === "EAI_AGAIN")) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function stripSensitiveHeaders(headers: Record<string, string>, injected: readonly string[]): Record<string, string> {
  const drop = new Set(["authorization", ...injected.map((name) => name.toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !drop.has(key.toLowerCase())));
}

async function fetchFollowing(input: {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  injected: readonly string[];
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ response: Response; url: URL }> {
  let current = input.url;
  let headers = input.headers;
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await input.fetchImpl(current, {
      method: input.method,
      headers,
      ...(input.method === "POST" && input.body !== undefined ? { body: input.body } : {}),
      redirect: "manual",
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]),
    });
    if (!isRedirect(response.status)) return { response, url: current };
    await response.body?.cancel().catch(() => undefined);
    if (hop === 5) throw new McpError("远程 MCP 拒绝跳转");
    const location = response.headers.get("location");
    if (!location) throw new McpError("远程 MCP 拒绝跳转");
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new McpError("远程 MCP 拒绝跳转");
    }
    if (next.username || next.password || next.hash || (next.protocol !== "http:" && next.protocol !== "https:")) throw new McpError("远程 MCP 地址无效");
    if (next.protocol === "http:" && !isLoopback(next.hostname)) throw new McpError("远程 MCP 必须使用 HTTPS");
    if (!sameOrigin(current, next)) headers = stripSensitiveHeaders(headers, input.injected);
    current = next;
  }
  throw new McpError("远程 MCP 拒绝跳转");
}

async function readSseResult(body: ReadableStream<Uint8Array> | null, id: number | undefined): Promise<unknown> {
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_MESSAGE) throw new McpError("MCP 响应过大");
      const events = buffer.split(/\n\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = sseData(event);
        if (!data) continue;
        const message = JSON.parse(data) as unknown;
        if (!isObject(message)) continue;
        if (id !== undefined && message.id !== undefined && String(message.id) === String(id)) {
          if (message.error !== undefined) throw new McpError("MCP 调用失败");
          return message.result;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (id === undefined) return undefined;
  throw new McpError("远程 MCP 没有返回", 502);
}

function sseData(event: string): string {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function assertServerName(name: string): void {
  if (!name || name.length > 128 || name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") {
    throw new McpError("MCP 名称无效");
  }
}

function decodeServer(value: string): string {
  let server = value;
  try {
    server = decodeURIComponent(value);
  } catch {
    throw new McpError("MCP 名称无效");
  }
  assertServerName(server);
  return server;
}

function routeServer(params: unknown): string {
  if (!isObject(params) || typeof params.server !== "string") throw new McpError("MCP 名称无效");
  assertServerName(params.server);
  return params.server;
}

function rawText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new McpError("请求体必须是对象");
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new McpError("MCP 参数无效");
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new McpError("MCP 参数无效");
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value) || Object.values(value).some((item) => typeof item !== "string")) throw new McpError("MCP 参数无效");
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
