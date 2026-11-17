/**
 * /browser/cdp 在升级之前检查 Chromium。
 * 未就绪时直接回 503 JSON，不完成 WebSocket 握手。
 * 调试地址只允许回环上的调试端口，避免把 CDP 转到别的主机。
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { BROWSER_DEBUG_PORT, type BrowserRestartResponse, type BrowserStatusResponse } from "@viate-bot/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

export interface BrowserRouteOptions {
  token: string;
  browserVersionUrl?: string;
  browserDebugPort?: number;
  restartBrowser?: () => Promise<void>;
}

const execFileAsync = promisify(execFile);

interface ChromiumInfo {
  browser: string;
  debuggerUrl: string | null;
}

export function attachBrowser(app: FastifyInstance, options: BrowserRouteOptions): void {
  const versionUrl = options.browserVersionUrl ?? `http://127.0.0.1:${BROWSER_DEBUG_PORT}/json/version`;
  const debugPort = options.browserDebugPort ?? BROWSER_DEBUG_PORT;
  const restart = options.restartBrowser ?? restartChromium;
  const wss = new WebSocketServer({ noServer: true });
  const upstreams = new Set<WebSocket>();
  const pendingUpgrades = new Set<Duplex>();
  let closing = false;

  const stopSockets = () => {
    closing = true;
    for (const socket of [...pendingUpgrades]) socket.destroy();
    for (const client of [...wss.clients]) client.terminate();
    for (const upstream of [...upstreams]) upstream.terminate();
  };

  // 升级连接会挡住 HTTP server 关闭，而 onClose 要等 server 关掉才运行。
  app.addHook("preClose", async () => {
    stopSockets();
  });

  app.addHook("onClose", async () => {
    stopSockets();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  app.server.on("upgrade", (request, socket, head) => {
    void acceptUpgrade(request, socket, head).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "升级失败";
      rejectUpgrade(socket, 500, "Internal Server Error", message);
    });
  });

  app.get("/browser/status", async (): Promise<BrowserStatusResponse> => {
    const info = await readChromium(versionUrl, debugPort);
    if (!info) return { running: false, version: null };
    return { running: true, version: info.browser };
  });

  app.get("/browser/cdp", async (_request, reply) => {
    const info = await readChromium(versionUrl, debugPort);
    if (!info?.debuggerUrl) {
      const error = info ? "Chromium 调试端点不在本机" : "Chromium 尚未就绪";
      return reply.code(503).send({ error });
    }
    return reply.code(426).send({ error: "需要 WebSocket 升级" });
  });

  app.post("/browser/restart", async (): Promise<BrowserRestartResponse> => {
    try {
      await restart();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`重启 Chromium 失败：${message}`), { statusCode: 500 });
    }
    return { ok: true };
  });

  async function acceptUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/browser/cdp") {
      return;
    }
    if (closing) {
      socket.destroy();
      return;
    }
    pendingUpgrades.add(socket);
    socket.once("close", () => pendingUpgrades.delete(socket));
    try {
      if (request.headers.authorization !== `Bearer ${options.token}`) {
        rejectUpgrade(socket, 401, "Unauthorized", "未认证");
        return;
      }
      const info = await readChromium(versionUrl, debugPort);
      if (closing || socket.destroyed) {
        socket.destroy();
        return;
      }
      if (!info) {
        rejectUpgrade(socket, 503, "Service Unavailable", "Chromium 尚未就绪");
        return;
      }
      if (!info.debuggerUrl) {
        rejectUpgrade(socket, 503, "Service Unavailable", "Chromium 调试端点不在本机");
        return;
      }
      const debuggerUrl = info.debuggerUrl;
      wss.handleUpgrade(request, socket, head, (client) => {
        if (closing) {
          client.terminate();
          return;
        }
        proxyCdp(client, debuggerUrl, upstreams);
      });
    } finally {
      pendingUpgrades.delete(socket);
    }
  }
}

async function readChromium(versionUrl: string, debugPort: number): Promise<ChromiumInfo | null> {
  try {
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(2000), redirect: "error" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return null;
    const browser = "Browser" in body && typeof body.Browser === "string" ? body.Browser : "";
    if (!browser) return null;
    const raw =
      "webSocketDebuggerUrl" in body && typeof body.webSocketDebuggerUrl === "string" ? body.webSocketDebuggerUrl : "";
    return { browser, debuggerUrl: localDebuggerUrl(raw, debugPort) };
  } catch {
    return null;
  }
}

function localDebuggerUrl(raw: string, debugPort: number): string | null {
  try {
    const parsed = new URL(raw);
    const hostOk = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const protocolOk = parsed.protocol === "ws:" || parsed.protocol === "wss:";
    if (!hostOk || !protocolOk || parsed.port !== String(debugPort)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string, error: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = JSON.stringify({ error });
  const payload =
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    "Content-Type: application/json; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n" +
    "\r\n" +
    body;
  socket.end(payload);
}

function proxyCdp(client: WebSocket, debuggerUrl: string, upstreams: Set<WebSocket>): void {
  const upstream = new WebSocket(debuggerUrl);
  upstreams.add(upstream);
  upstream.on("close", () => upstreams.delete(upstream));
  const queue: Array<{ data: RawData; binary: boolean }> = [];
  let open = false;

  const closeClient = (code: number, reason?: string) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const safe = code >= 1000 && code <= 4999 && code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1011;
    const text = reason && Buffer.byteLength(reason) > 120 ? reason.slice(0, 120) : reason;
    if (text) client.close(safe, text);
    else client.close(safe);
  };
  const closeUpstream = () => {
    if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    else if (upstream.readyState === WebSocket.OPEN) upstream.close();
  };

  client.on("message", (data, isBinary) => {
    if (!open || upstream.readyState !== WebSocket.OPEN) {
      queue.push({ data, binary: isBinary });
      return;
    }
    upstream.send(data, { binary: isBinary });
  });
  client.on("close", () => closeUpstream());
  client.on("error", () => closeUpstream());

  upstream.on("open", () => {
    open = true;
    for (const item of queue) {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(item.data, { binary: item.binary });
    }
    queue.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => {
    const text = reason.toString("utf8");
    closeClient(code === 1006 || code === 1005 || code === 1015 ? 1011 : code, text);
  });
  upstream.on("error", () => {
    closeClient(1011, "Chromium 连接失败");
    closeUpstream();
  });
}

async function restartChromium(): Promise<void> {
  const pid = await findBrowserPid();
  if (pid === null) throw new Error("没有正在运行的 Chromium");
  try {
    await execFileAsync("/usr/bin/node", ["/opt/viate/run-as-bot.mjs", "/home/bot", `kill -TERM ${pid}`], {
      timeout: 10_000,
    });
  } catch (error) {
    throw new Error(commandError(error));
  }
  const deadline = Date.now() + 20_000;
  let exited = false;
  while (Date.now() < deadline) {
    if (!exited) exited = !(await pidAlive(pid));
    else if (await debugPortOpen()) return;
    await delay(200);
  }
  throw new Error(exited ? "Chromium 退出后没有重新监听 9222" : "Chromium 没有退出");
}

async function findBrowserPid(): Promise<number | null> {
  const entries = await readdir("/proc").catch(() => [] as string[]);
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let raw: Buffer;
    try {
      raw = await readFile(`/proc/${name}/cmdline`);
    } catch {
      continue;
    }
    const text = raw.toString("utf8");
    if (!text.includes("remote-debugging-port=9222") || text.includes("--type=")) continue;
    return Number(name);
  }
  return null;
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    await readFile(`/proc/${pid}/cmdline`);
    return true;
  } catch {
    return false;
  }
}

async function debugPortOpen(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${BROWSER_DEBUG_PORT}/json/version`, {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  }
}

function commandError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & { stderr?: unknown; stdout?: unknown };
  const stderr = typeof extra.stderr === "string" ? extra.stderr.trim() : "";
  const stdout = typeof extra.stdout === "string" ? extra.stdout.trim() : "";
  return [error.message, stderr, stdout].filter((part) => part.length > 0).join(" ");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
