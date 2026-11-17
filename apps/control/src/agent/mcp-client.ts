import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { obj, unsafe, type Schema } from "@earendil-works/pi-schema";
import type {
  MachineEndpoint,
  McpRemoteStartRequest,
  McpStartResponse,
  McpStdioStartRequest,
} from "@viate-bot/protocol";
import { SAVE_SKILL_TOOL_NAME, SKILL_READ_TOOL_NAME } from "./skill-tools.js";
import { maskDeep } from "./text.js";

/**
 * 控制面只跟这台 machined 说话，绝不拨远程 MCP 地址。
 * 启动走机器自己的 HTTP：POST /mcp/stdio、POST /mcp/remote，Bearer 是机器令牌。
 * 必须等这次 POST 返回 { server, running: true }，才打开该会话的 websocket。
 * 工具调用走 ws://host:port/mcp/:server，同样带 Bearer。这条 websocket 只转发 tools/list 和 tools/call。
 * 路径里的 server 是机器上的会话名。每一帧是一条 JSON-RPC 2.0，方法原样转给该会话：
 *
 * tools/list params {}，result { tools: [{ name, description?, inputSchema? }] }
 * tools/call params { name, arguments? }，result { content, isError? }
 *
 * 命令不展开。URL 和请求头是字面量，不把 ${config.KEY} 替换成密钥。
 * args、env、cwd 只原样转发 ${PLUGIN_ROOT} 和 ${PLUGIN_DATA}，由机器做唯一一次替换。
 * 敏感值只能出现在 stdio 的 env，或 HTTP 首个源站的请求头里，不进 URL，也不进模型能看到的错误文本。
 * 未知工具用 mcpAgentTools 以原名注册。审批在 beforeToolCall，这里不放行。
 */
export const MACHINED_MCP_PATH = "/mcp";
export const MCP_STDIO_PATH = "/mcp/stdio";
export const MCP_REMOTE_PATH = "/mcp/remote";
export const MCP_LIST_TOOLS = "tools/list";
export const MCP_CALL_TOOL = "tools/call";

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const CWD = new Set(["./", "${PLUGIN_ROOT}", "${PLUGIN_DATA}"]);

/**
 * 只读和控制面名字会跳过审批。skill_read / save_skill 留给技能工具。
 * MCP 工具不能占用这些名字，否则会顶掉原实现或绕过 beforeToolCall。
 */
const APPROVAL_SKIP_NAMES: Record<string, true> = {
  fs_read: true,
  fs_list: true,
  fs_search: true,
  browser_snapshot: true,
  browser_screenshot: true,
  desktop_screenshot: true,
  memory_search: true,
  memory_save: true,
  memory_delete: true,
  propose_routine: true,
  request_secret: true,
  [SKILL_READ_TOOL_NAME]: true,
  [SAVE_SKILL_TOOL_NAME]: true,
  shell_exec: true,
  fs_write: true,
  bulk_delete_action: true,
  request_takeover: true,
  search_apps: true,
  install_mcp: true,
  browser_open: true,
  browser_click: true,
  browser_type: true,
  browser_select: true,
  browser_scroll: true,
  browser_tabs: true,
  browser_wait: true,
  desktop_mouse: true,
  desktop_key: true,
  desktop_type: true,
};

/** 任务步骤只记类别，不记可能夹带命令或密钥的原文。 */
export function mcpFailureCategory(error: unknown): "启动失败" | "超时" | "协议错误" {
  const message = error instanceof Error ? error.message : "";
  if (/timeout|timed out|超时|ETIMEDOUT|abort/i.test(message)) return "超时";
  if (error instanceof McpRpcError || /协议|JSON-RPC|tools\/list|返回无效/i.test(message)) return "协议错误";
  return "启动失败";
}

export class McpRpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "McpRpcError";
    this.code = code;
  }
}

export interface McpSocket {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface MachinedMcpClientOptions {
  endpoint: MachineEndpoint;
  /** 缺省连接 ws://host:port/mcp/:server。测试可以换成假套接字，但不能把远程 MCP 地址传进来。 */
  openSocket?: (endpoint: MachineEndpoint, server: string, signal?: AbortSignal) => Promise<McpSocket>;
  /** Requests only the bound machined host, never the remote MCP URL. */
  request?: MachineRequest;
  /** Bound by the integrator to resolveMcpLaunch(deps, userId, appName). */
  resolveLaunch?: (appName: string) => { env: Record<string, string>; headers: Record<string, string> } | Promise<{ env: Record<string, string>; headers: Record<string, string> }>;
  timeoutMs?: number;
  /** 本地等待结束但远端没有确认停止。不得据此把调用标成成功或已停止。 */
  onUnconfirmed?: (server: string) => void;
}

/** POST /mcp/stdio 的请求体。server 是机器上的会话名，不是远程地址。 */
export interface McpStdioStartBody {
  server: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  pluginRoot?: string;
  pluginData?: string;
}

/** 交给 POST /mcp/stdio 的参数。pluginRoot / pluginData 原样转发，控制面不展开。 */
export interface McpStdioLaunch extends McpStdioStartRequest {
  pluginRoot?: string;
  pluginData?: string;
}

/** POST /mcp/remote 的请求体。url 只交给机器，控制面不拨它。 */
export interface McpRemoteStartBody {
  server: string;
  url: string;
  headers?: Record<string, string>;
  /** 配置注入的头名。值在 headers 里；机器跨源跳转时丢掉这些头。 */
  injectedHeaders?: string[];
  transport?: "sse" | "streamable-http";
}

/** 交给 POST /mcp/remote 的参数。url、headers、transport 都是字面量。 */
export interface McpRemoteLaunch extends McpRemoteStartRequest {
  injectedHeaders?: readonly string[];
  transport?: "sse" | "streamable-http";
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolList {
  tools: McpToolDefinition[];
}

export interface McpContentBlock {
  type: string;
  text?: string;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/** websocket 上 tools/call 的 params。会话名在路径 /mcp/:server，不在 params 里。 */
export interface McpCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

interface PendingCall {
  server: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface MachineRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: "manual";
  signal?: AbortSignal;
}

type MachineRequest = (url: string, init: MachineRequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface SocketInit {
  headers?: Record<string, string>;
}

export function assertMachineEndpoint(endpoint: MachineEndpoint): void {
  if (!endpoint || typeof endpoint.host !== "string" || typeof endpoint.token !== "string") {
    throw new Error("机器地址不完整");
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error("机器端口无效");
  }
  if (endpoint.token.length === 0) throw new Error("机器令牌为空");
  if (
    endpoint.host.length === 0 ||
    endpoint.host.includes("://") ||
    endpoint.host.includes("/") ||
    endpoint.host.includes("?") ||
    endpoint.host.includes("#") ||
    endpoint.host.includes("@") ||
    endpoint.host.includes("\\") ||
    endpoint.host.includes(" ") ||
    endpoint.host.includes("\0")
  ) {
    throw new Error("机器地址必须是主机名，不能是远程 URL");
  }
}

export function machinedMcpUrl(endpoint: MachineEndpoint, server: string): string {
  assertMachineEndpoint(endpoint);
  assertServer(server);
  const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[") ? `[${endpoint.host}]` : endpoint.host;
  return `ws://${host}:${endpoint.port}${MACHINED_MCP_PATH}/${encodeURIComponent(server)}`;
}

export function machinedHttpUrl(endpoint: MachineEndpoint, path: typeof MCP_STDIO_PATH | typeof MCP_REMOTE_PATH): string {
  assertMachineEndpoint(endpoint);
  if (path !== MCP_STDIO_PATH && path !== MCP_REMOTE_PATH) throw new Error("机器路径无效");
  const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[") ? `[${endpoint.host}]` : endpoint.host;
  return `http://${host}:${endpoint.port}${path}`;
}

/** 只检查地址形状。不解析 DNS，不发起连接，也不展开占位符。 */
export function assertRemoteMcpUrl(value: string): URL {
  if (value.includes("$")) throw new Error("远程 MCP 地址不能包含占位符");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("远程 MCP 地址无效");
  }
  if (url.username !== "" || url.password !== "") throw new Error("远程 MCP 地址不能带用户信息");
  if (url.hash !== "") throw new Error("远程 MCP 地址不能带片段");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && loopback(url.hostname)) return url;
  throw new Error("远程 MCP 只能由机器内发起，且非回环地址必须是 https");
}

export function openMachinedMcpSocket(endpoint: MachineEndpoint, server: string, signal?: AbortSignal): Promise<McpSocket> {
  assertMachineEndpoint(endpoint);
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const socket = openWebSocket(machinedMcpUrl(endpoint, server), {
    headers: { authorization: `Bearer ${endpoint.token}` },
  });
  const { promise, resolve, reject } = Promise.withResolvers<McpSocket>();
  let settled = false;
  let closed = false;
  const queued: string[] = [];
  let onMessage: ((data: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const stopAbort = () => signal?.removeEventListener("abort", abort);
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    stopAbort();
    socket.close();
    reject(error);
  };
  const abort = () => fail(abortError(signal));
  signal?.addEventListener("abort", abort, { once: true });
  socket.addEventListener("message", (event) => {
    const text = frameText(event.data);
    if (onMessage) onMessage(text);
    else queued.push(text);
  });
  socket.addEventListener("close", () => {
    closed = true;
    if (!settled) fail(new Error("连不上这台机器的 MCP 通道"));
    else onClose?.();
  });
  socket.addEventListener("error", () => {
    if (!settled) fail(new Error("连不上这台机器的 MCP 通道"));
    else onError?.(new Error("MCP 通道出错"));
  });
  socket.addEventListener(
    "open",
    () => {
      if (settled) return;
      settled = true;
      stopAbort();
      resolve({
        send(data) {
          socket.send(data);
        },
        close() {
          socket.close();
        },
        onMessage(listener) {
          onMessage = listener;
          for (const item of queued.splice(0)) listener(item);
        },
        onClose(listener) {
          onClose = listener;
          if (closed) listener();
        },
        onError(listener) {
          onError = listener;
        },
      });
    },
    { once: true },
  );
  return promise;
}

export class MachinedMcpClient {
  private readonly timeoutMs: number;
  private readonly options: MachinedMcpClientOptions;
  private readonly sockets = new Map<string, McpSocket>();
  private readonly opening = new Map<string, Promise<McpSocket>>();
  private readonly launched = new Set<string>();
  private readonly slots = new Map<string, string>();
  private readonly launchSecrets = new Map<string, Array<{ name: string; value: string }>>();
  private readonly launchChains = new Map<string, Promise<unknown>>();
  private generation = 0;
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, PendingCall>();
  private readonly unconfirmedCalls = new Set<number>();

  constructor(options: MachinedMcpClientOptions) {
    assertMachineEndpoint(options.endpoint);
    this.timeoutMs = timeoutOf(options.timeoutMs);
    this.options = options;
  }

  /** Resolve the current user's installed app and launch it on machined before opening its socket. */
  async launchApp(appName: string, server: string, signal?: AbortSignal, owner?: string): Promise<McpStartResponse> {
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(appName) || appName.includes("..") || appName.includes("--")) throw new Error("应用名无效");
    assertServer(server);
    if (!this.options.resolveLaunch) throw new Error("MCP 应用未配置");
    const slot = `${appName}\0${server}`;
    return this.enqueueLaunch(slot, async () => {
      const generation = this.generation;
      if (this.closed) throw new Error("MCP 通道已关闭");
      const previous = this.slots.get(slot);
      if (previous) this.retire(previous);
      let material: { env: Record<string, string>; headers: Record<string, string> };
      try {
        material = await this.options.resolveLaunch!(appName);
      } catch {
        throw new Error("MCP 应用启动失败");
      }
      const path = `/apps/${encodeURIComponent(appName)}/mcp/${encodeURIComponent(server)}`;
      const body: { env: Record<string, string>; headers: Record<string, string>; owner?: string } = { env: material.env, headers: material.headers };
      if (owner && /^[A-Za-z0-9_-]{1,64}$/.test(owner)) body.owner = owner;
      const response = parseStart(await this.postJson(path, body, signal), server);
      this.slots.set(slot, response.server);
      this.publishLaunch(response.server, generation, [...Object.values(material.env), ...Object.values(material.headers)]);
      return response;
    });
  }

  async startStdio(server: string, request: McpStdioLaunch, signal?: AbortSignal): Promise<McpStartResponse> {
    assertServer(server);
    assertStdio(request);
    if (request.pluginRoot !== undefined) assertPluginPath(request.pluginRoot);
    if (request.pluginData !== undefined) assertPluginPath(request.pluginData);
    return this.enqueueLaunch(server, async () => {
      const generation = this.generation;
      if (this.closed) throw new Error("MCP 通道已关闭");
      this.retire(server);
      const body: McpStdioStartBody = { server, command: request.command };
      if (request.args !== undefined) body.args = [...request.args];
      if (request.cwd !== undefined) body.cwd = request.cwd;
      if (request.env !== undefined) body.env = { ...request.env };
      if (request.pluginRoot !== undefined) body.pluginRoot = request.pluginRoot;
      if (request.pluginData !== undefined) body.pluginData = request.pluginData;
      const response = parseStart(await this.postJson(MCP_STDIO_PATH, body, signal), server);
      this.publishLaunch(server, generation, Object.values(request.env ?? {}));
      return response;
    });
  }

  async startRemote(server: string, request: McpRemoteLaunch, signal?: AbortSignal): Promise<McpStartResponse> {
    assertServer(server);
    assertRemoteMcpUrl(request.url);
    assertHeaders(request.headers);
    if (request.injectedHeaders !== undefined) assertInjectedHeaders(request.injectedHeaders);
    if (request.transport !== undefined && request.transport !== "sse" && request.transport !== "streamable-http") {
      throw new Error("远程 MCP 传输无效");
    }
    return this.enqueueLaunch(server, async () => {
      const generation = this.generation;
      if (this.closed) throw new Error("MCP 通道已关闭");
      this.retire(server);
      const body: McpRemoteStartBody = { server, url: request.url };
      if (request.headers !== undefined) body.headers = { ...request.headers };
      if (request.injectedHeaders !== undefined) body.injectedHeaders = [...request.injectedHeaders];
      if (request.transport !== undefined) body.transport = request.transport;
      const response = parseStart(await this.postJson(MCP_REMOTE_PATH, body, signal), server);
      this.publishLaunch(server, generation, Object.values(request.headers ?? {}));
      return response;
    });
  }

  async listTools(server: string, signal?: AbortSignal): Promise<McpToolList> {
    assertServer(server);
    return parseToolList(await this.rpc(server, MCP_LIST_TOOLS, {}, signal));
  }

  async callTool(
    server: string,
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    assertServer(server);
    assertToolName(name);
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) throw new Error("工具参数无效");
    const params: McpCallParams = { name };
    if (args !== undefined) params.arguments = args;
    return parseCall(await this.rpc(server, MCP_CALL_TOOL, params, signal));
  }

  close(): void {
    const servers = [...this.launched];
    this.closed = true;
    this.generation += 1;
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
    this.opening.clear();
    this.launched.clear();
    this.slots.clear();
    this.launchSecrets.clear();
    this.failAll(new Error("MCP 通道已关闭"));
    for (const server of servers) void this.deleteSession(server);
  }

  private async deleteSession(server: string): Promise<void> {
    const endpoint = this.options.endpoint;
    const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[") ? `[${endpoint.host}]` : endpoint.host;
    const request = this.options.request ?? machineRequest();
    try {
      const response = await request(`http://${host}:${endpoint.port}/mcp/${encodeURIComponent(server)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${endpoint.token}` },
      });
      const text = await response.text();
      const body = JSON.parse(text) as { running?: unknown };
      if (response.ok && body.running === false) return;
    } catch {
      // 机器已经没有这个会话时，引用释放仍然算完成。
    }
  }

  /** 重新启动会换掉机器上的会话，所以先关掉旧套接字，并在新的 POST 成功前禁止重连。 */
  private retire(server: string): void {
    this.launched.delete(server);
    this.launchSecrets.delete(server);
    const socket = this.sockets.get(server);
    if (!socket) return;
    this.sockets.delete(server);
    socket.close();
    this.failServer(server, new Error("MCP 未启动"));
  }

  /** 同一个 server 的启动排队。并发 POST 时，先发出的那次可能后返回，把后一次的 launchSecrets 盖掉。 */
  private enqueueLaunch<T>(server: string, run: () => Promise<T>): Promise<T> {
    const previous = this.launchChains.get(server) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.launchChains.set(server, next.then(() => undefined, () => undefined));
    return next;
  }

  private publishLaunch(server: string, generation: number, values: string[]): void {
    if (this.closed || this.generation !== generation) throw new Error("MCP 通道已关闭");
    this.launchSecrets.set(server, values.filter((value) => value.length > 0).map((value) => ({ name: "app_secret", value })));
    this.launched.add(server);
  }

  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("MCP 通道已关闭");
    if (signal?.aborted) throw abortError(signal);
    const endpoint = this.options.endpoint;
    const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[") ? `[${endpoint.host}]` : endpoint.host;
    const url = `http://${host}:${endpoint.port}${path}`;
    const request = this.options.request ?? machineRequest();
    let response: { ok: boolean; status: number; text(): Promise<string> };
    try {
      const init: MachineRequestInit = {
        method: "POST",
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "manual",
      };
      if (signal) init.signal = signal;
      response = await request(url, init);
    } catch {
      throw new Error("连不上这台机器");
    }
    if (response.status >= 300 && response.status < 400) throw new Error("MCP 启动失败");
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error("机器返回的 MCP 启动结果无效");
    }
    if (!response.ok) throw new Error("MCP 启动失败");
    return parsed;
  }

  private async rpc(server: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("MCP 通道已关闭");
    if (signal?.aborted) throw abortError(signal);
    if (method.length === 0 || method.includes("://") || method.startsWith("/")) throw new Error("MCP 方法无效");
    const socket = await this.socketFor(server);
    if (signal?.aborted) throw abortError(signal);
    const id = ++this.nextId;
    const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) body.params = params;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.unconfirmedCalls.add(id);
      this.options.onUnconfirmed?.(server);
      if (signal?.aborted) this.fail(id, new Error("remote_unconfirmed"));
    }, this.timeoutMs);
    timer.unref?.();
    const pending: PendingCall = { server, resolve, reject, timer };
    this.pending.set(id, pending);
    if (signal) {
      const onAbort = () => {
        if (this.unconfirmedCalls.has(id)) this.fail(id, new Error("remote_unconfirmed"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.onAbort = onAbort;
      pending.signal = signal;
    }
    try {
      socket.send(JSON.stringify(body));
    } catch (error) {
      this.fail(id, error instanceof Error ? error : new Error("MCP 发送失败"));
    }
    return promise;
  }

  private socketFor(server: string): Promise<McpSocket> {
    if (this.closed) return Promise.reject(new Error("MCP 通道已关闭"));
    if (!this.launched.has(server)) return Promise.reject(new Error("MCP 未启动"));
    const existing = this.sockets.get(server);
    if (existing) return Promise.resolve(existing);
    const pending = this.opening.get(server);
    if (pending) return pending;
    const generation = this.generation;
    const opening = this.connect(server, generation).finally(() => {
      if (this.opening.get(server) === opening) this.opening.delete(server);
    });
    this.opening.set(server, opening);
    return opening;
  }

  private async connect(server: string, generation: number): Promise<McpSocket> {
    const open = this.options.openSocket ?? openMachinedMcpSocket;
    const socket = await open(this.options.endpoint, server);
    if (this.closed || generation !== this.generation || !this.launched.has(server)) {
      socket.close();
      throw new Error(this.closed || generation !== this.generation ? "MCP 通道已关闭" : "MCP 未启动");
    }
    let active = true;
    const drop = (error: Error) => {
      if (!active || generation !== this.generation) return;
      active = false;
      if (this.sockets.get(server) === socket) this.sockets.delete(server);
      this.failServer(server, error);
    };
    socket.onMessage((frame) => {
      if (active && generation === this.generation) this.onFrame(frame, server);
    });
    socket.onClose(() => drop(new Error("MCP 通道已断开")));
    socket.onError(() => drop(new Error("MCP 通道出错")));
    this.sockets.set(server, socket);
    return socket;
  }

  private onFrame(raw: string, server: string): void {
    let parsed: unknown;
    try {
      parsed = maskDeep(JSON.parse(raw) as unknown, this.launchSecrets.get(server) ?? []);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("id" in parsed)) return;
    const id = rpcId(parsed.id);
    if (id === undefined) return;
    if ("error" in parsed && parsed.error !== undefined) {
      const error = parsed.error;
      const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "MCP 调用失败";
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : -32000;
      this.fail(id, new McpRpcError(message, code));
      return;
    }
    this.succeed(id, "result" in parsed ? parsed.result : undefined);
  }

  private succeed(id: number, value: unknown): void {
    const pending = this.take(id);
    pending?.resolve(value);
  }

  private fail(id: number, error: Error): void {
    const pending = this.take(id);
    pending?.reject(error);
  }

  private failServer(server: string, error: Error): void {
    void error;
    for (const [id, pending] of this.pending) {
      if (pending.server !== server) continue;
      this.unconfirmedCalls.add(id);
      this.options.onUnconfirmed?.(server);
      this.fail(id, new Error("remote_unconfirmed"));
    }
  }

  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.fail(id, error);
  }

  private take(id: number): PendingCall | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    return pending;
  }
}

/**
 * 把 tools/list 的结果变成 agent 工具。名字和参数保持原样，执行只转发到这台机器。
 * 未知名字属于 mcp 类，要在 beforeToolCall 里按名字加规范参数审批。
 * 不读取技能的 allowed-tools，也不接受一张预先放行的名单。
 */
export function mcpAgentTools(
  client: Pick<MachinedMcpClient, "callTool">,
  server: string,
  tools: readonly McpToolDefinition[],
): AgentTool[] {
  assertServer(server);
  const seen = new Set<string>();
  return tools.map((tool) => {
    const name = tool.name;
    if (!AGENT_TOOL_NAME.test(name) || name in APPROVAL_SKIP_NAMES || seen.has(name)) throw new Error("工具名无效");
    seen.add(name);
    const parameters = tool.inputSchema?.type === "object"
      ? unsafe<Record<string, unknown>>(tool.inputSchema as Schema)
      : obj({}, { open: true });
    const description = tool.description && tool.description.length > 0 ? tool.description : name;
    const agentTool: AgentTool = {
      name,
      label: name,
      description,
      parameters,
      execute: async (_toolCallId, params, signal) => {
        if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("工具参数无效");
        const args = { ...(params as Record<string, unknown>) };
        const result = await client.callTool(server, name, args, signal);
        const text = result.content.map((block) => block.text ?? "").filter((line) => line.length > 0).join("\n");
        const payload: AgentToolResult = {
          content: [{ type: "text", text: text.length > 0 ? text : "（无文本）" }],
          details: { server, name, isError: result.isError === true },
        };
        if (result.isError === true) payload.isError = true;
        return payload;
      },
    };
    return agentTool;
  });
}

/** 已占用或内置名字直接丢掉，不另起别名。同一次列出的其它工具仍注册。 */
export function appendMcpTools(
  used: Set<string>,
  client: Pick<MachinedMcpClient, "callTool">,
  server: string,
  listed: readonly McpToolDefinition[],
): AgentTool[] {
  const added: AgentTool[] = [];
  for (const tool of listed) {
    if (used.has(tool.name)) continue;
    let registered: AgentTool[];
    try {
      registered = mcpAgentTools(client, server, [tool]);
    } catch {
      continue;
    }
    const one = registered[0];
    if (!one) continue;
    used.add(one.name);
    added.push(one);
  }
  return added;
}

function timeoutOf(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || value < 1 || value > 600_000) throw new Error("MCP 超时无效");
  return value;
}

function assertServer(server: string): void {
  if (!SERVER_NAME.test(server) || server.includes("..")) throw new Error("MCP 服务名无效");
}

function assertToolName(name: string): void {
  if (name.length === 0 || name.length > 256 || name.includes("\0") || /[\r\n]/.test(name)) throw new Error("工具名无效");
}

function assertPluginPath(value: string): void {
  if (value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("$") || value.includes("://")) {
    throw new Error("MCP 插件目录无效");
  }
}

function assertInjectedHeaders(names: readonly string[]): void {
  if (names.length > 32) throw new Error("远程 MCP 请求头无效");
  for (const name of names) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new Error("远程 MCP 请求头无效");
  }
}

function assertStdio(request: McpStdioStartRequest): void {
  if (request.command.includes("$")) throw new Error("MCP 命令不能展开占位符");
  if (!validCommand(request.command)) throw new Error("MCP 命令必须是单个可执行名或 ./ 相对路径");
  if (request.cwd !== undefined && !CWD.has(request.cwd)) throw new Error("MCP 工作目录无效");
  if (request.args !== undefined) {
    for (const arg of request.args) {
      assertSinglePass(arg);
    }
  }
  if (request.env !== undefined) {
    for (const [key, value] of Object.entries(request.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("MCP 环境变量无效");
      assertSinglePass(value);
    }
  }
}

/** 只允许原样保留 ${PLUGIN_ROOT} 和 ${PLUGIN_DATA}。${config.KEY} 和其他 $ 直接拒绝，不做替换。 */
function assertSinglePass(value: string): void {
  if (value.includes("\0")) throw new Error("MCP 参数无效");
  const tokens = value.match(/\$\{[^}]*\}|\$/g);
  if (!tokens) return;
  for (const token of tokens) {
    if (token !== "${PLUGIN_ROOT}" && token !== "${PLUGIN_DATA}") throw new Error("不能展开配置或环境变量");
  }
}

function validCommand(command: string): boolean {
  if (command.length === 0 || command.length > 256 || command.includes("\0") || /\s/.test(command)) return false;
  if (command.includes("://") || command.startsWith("/") || command.includes("..")) return false;
  if (command.startsWith("./")) {
    const parts = command.slice(2).split("/");
    return parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && /^[A-Za-z0-9._+-]+$/.test(part));
  }
  return /^[A-Za-z0-9._+-]+$/.test(command);
}

function assertHeaders(headers: Record<string, string> | undefined): void {
  if (headers === undefined) return;
  for (const [key, value] of Object.entries(headers)) {
    if (key.includes("$") || value.includes("$")) throw new Error("远程 MCP 请求头不能包含占位符");
    if (key.length === 0 || /[\r\n:]/.test(key) || /[\r\n]/.test(value)) throw new Error("远程 MCP 请求头无效");
  }
}

function machineRequest(): MachineRequest {
  const fallback = globalThis.fetch.bind(globalThis);
  return (url, init) => fallback(url, init);
}

function parseStart(value: unknown, server: string): McpStartResponse {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("server" in value) || !("running" in value)) {
    throw new Error("MCP 启动结果无效");
  }
  if (value.running !== true || typeof value.server !== "string") throw new Error("MCP 启动结果无效");
  if (value.server !== server && !/^[a-f0-9]{32}$/.test(value.server)) throw new Error("MCP 启动结果无效");
  return { server: value.server, running: true };
}

function parseToolList(value: unknown): McpToolList {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("tools" in value) || !Array.isArray(value.tools)) {
    throw new Error("tools/list 的返回无效");
  }
  const tools: McpToolDefinition[] = [];
  for (const item of value.tools) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("name" in item) || typeof item.name !== "string" || item.name.length === 0) {
      throw new Error("tools/list 的返回无效");
    }
    const tool: McpToolDefinition = { name: item.name };
    if ("description" in item && typeof item.description === "string") tool.description = item.description;
    if ("inputSchema" in item && item.inputSchema && typeof item.inputSchema === "object" && !Array.isArray(item.inputSchema)) {
      tool.inputSchema = item.inputSchema as Record<string, unknown>;
    }
    tools.push(tool);
  }
  return { tools };
}

function parseCall(value: unknown): McpToolCallResult {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("content" in value) || !Array.isArray(value.content)) {
    throw new Error("tools/call 的返回无效");
  }
  const content: McpContentBlock[] = [];
  for (const item of value.content) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("type" in item) || typeof item.type !== "string") {
      throw new Error("tools/call 的返回无效");
    }
    const block: McpContentBlock = { type: item.type };
    if ("text" in item && typeof item.text === "string") block.text = item.text;
    content.push(block);
  }
  const result: McpToolCallResult = { content };
  if ("isError" in value && typeof value.isError === "boolean") result.isError = value.isError;
  return result;
}

function loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const v4 = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  const parts = v4.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return nums[0] === 127;
}

function rpcId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return undefined;
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("MCP 调用已取消");
}

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return "";
}

function openWebSocket(url: string, init: SocketInit): WebSocket {
  const ctor = WebSocket as unknown as new (target: string, options?: SocketInit) => WebSocket;
  return new ctor(url, init);
}
