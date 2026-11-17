/** HTTP framing belongs to Node's parser; both routes supply a checked byte stream. */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { Duplex, pipeline } from "node:stream";
import {
  EGRESS_OPEN_TIMEOUT_MS,
  EGRESS_PROXY_HOST,
  EGRESS_PROXY_PORT,
  EgressOpenError,
  checkEgressTarget,
  defaultResolve,
  portAllowed,
  type MachinePeer,
  type Tunnel,
} from "@viate-bot/protocol";

export interface EgressConfig {
  mode: "direct" | "user_network";
  offlinePolicy: "fallback_direct" | "pause";
  deviceOnline: boolean;
}

export interface EgressProxy {
  readonly port: number;
  readonly ready: Promise<void>;
  setConfig(config: EgressConfig): void;
  setPeer(peer: MachinePeer | null): void;
  close(): Promise<void>;
}

const OFFLINE_BODY = "用户网络离线，请打开 viate-bot 桌面客户端";
const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><title>用户网络离线</title><p>${OFFLINE_BODY}</p>`;
const HOP: Record<string, true> = {
  connection: true,
  "proxy-connection": true,
  "keep-alive": true,
  "transfer-encoding": true,
  te: true,
  trailer: true,
  upgrade: true,
  "proxy-authorization": true,
  "proxy-authenticate": true,
};

export function proxyEnvironment(port: number, base: NodeJS.ProcessEnv, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const value = `http://${EGRESS_PROXY_HOST}:${port}`;
  return {
    ...base, ...extra,
    HTTP_PROXY: value, HTTPS_PROXY: value, http_proxy: value, https_proxy: value,
    NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
    HOME: "/home/bot", USER: "bot", LOGNAME: "bot",
  };
}

export function startEgressProxy(options: {
  port?: number;
  resolve?: (host: string) => Promise<string[]>;
  dial?: (address: string, port: number) => net.Socket;
} = {}): EgressProxy {
  const resolve = options.resolve ?? defaultResolve;
  const dial = options.dial ?? ((address: string, port: number) => net.connect({ host: address, port, family: net.isIP(address) === 6 ? 6 : 4, allowHalfOpen: true }));
  let config: EgressConfig = { mode: "direct", offlinePolicy: "pause", deviceOnline: false };
  let peer: MachinePeer | null = null;
  let stopped = false;
  const sockets = new Set<Duplex>();
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (stopped) socket.destroy();
    return socket;
  };
  const server = http.createServer((req, res) => {
    void handleHttp(req, res).catch((error: unknown) => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof ProxyError ? error.status : 502;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end(error instanceof Error ? error.message : "连接失败");
    });
  });
  server.on("connection", (socket) => track(socket));
  server.on("connect", (req, socket, head) => {
    void handleConnect(req, socket, head).catch((error: unknown) => writeRaw(socket, error));
  });
  server.on("upgrade", (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch((error: unknown) => writeRaw(socket, error));
  });
  const { promise: ready, resolve: markReady, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(options.port ?? EGRESS_PROXY_PORT, EGRESS_PROXY_HOST, () => {
    server.off("error", reject);
    markReady();
  });
  return {
    ready,
    get port() {
      const address = server.address();
      return address && typeof address === "object" ? address.port : (options.port ?? EGRESS_PROXY_PORT);
    },
    setConfig(next) { config = next; },
    setPeer(next) { peer = next; },
    close() {
      stopped = true;
      for (const socket of sockets) socket.destroy();
      const { promise, resolve: closed } = Promise.withResolvers<void>();
      server.close(() => closed());
      return promise;
    },
  };

  function decide(): "direct" | "tunnel" | "pause" {
    if (config.mode !== "user_network") return "direct";
    if (config.deviceOnline && peer) return "tunnel";
    return config.offlinePolicy === "fallback_direct" ? "direct" : "pause";
  }

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    req.pause();
    const target = parseAbsolute(req.url ?? "");
    if (!target) throw new ProxyError(400, "需要绝对 URL");
    if (!portAllowed(target.port)) throw new ProxyError(403, "端口不允许");
    if (decide() === "pause") {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(OFFLINE_HTML), connection: "close" });
      res.end(OFFLINE_HTML);
      return;
    }
    const socket = await open(target.host, target.port);
    if (res.destroyed) { socket.destroy(); return; }
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const upstream = http.request({
      method: req.method, path: target.path, host: target.host, port: target.port,
      headers: { ...headersOf(req.headers), host: target.hostHeader, connection: "close" },
      agent,
    });
    upstream.on("response", (response) => {
      res.writeHead(response.statusCode ?? 502, { ...headersOf(response.headers), connection: "close" });
      pipeline(response, res, () => socket.destroy());
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end();
      socket.destroy();
    });
    res.on("close", () => { upstream.destroy(); socket.destroy(); });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  }

  async function handleConnect(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const target = parseAuthority(req.url ?? "");
    if (!target) throw new ProxyError(400, "CONNECT 目标无效");
    if (!portAllowed(target.port)) throw new ProxyError(403, "端口不允许");
    const upstream = await open(target.host, target.port);
    if (socket.destroyed) { upstream.destroy(); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    bridge(socket, upstream, head);
  }

  async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const target = parseAbsolute((req.url ?? "").replace(/^ws:\/\//, "http://"));
    if (!target) throw new ProxyError(400, "需要绝对 URL");
    if (!portAllowed(target.port)) throw new ProxyError(403, "端口不允许");
    const upstream = await open(target.host, target.port);
    if (socket.destroyed) { upstream.destroy(); return; }
    const headers = { ...headersOf(req.headers), host: target.hostHeader, connection: "Upgrade", upgrade: req.headers.upgrade ?? "websocket" };
    upstream.write(`${req.method ?? "GET"} ${target.path} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`);
    bridge(socket, upstream, head);
  }

  async function open(host: string, port: number): Promise<Duplex> {
    const route = decide();
    if (route === "pause") throw new ProxyError(503, OFFLINE_BODY);
    if (route === "tunnel") {
      if (!peer) throw new ProxyError(503, OFFLINE_BODY);
      const tunnel = peer.open(host, port);
      const timer = setTimeout(() => tunnel.reset(), EGRESS_OPEN_TIMEOUT_MS);
      try { await tunnel.ready; }
      catch (error) {
        throw new ProxyError(error instanceof EgressOpenError && error.code === "blocked" ? 403 : 502, error instanceof Error ? error.message : "连接失败");
      } finally { clearTimeout(timer); }
      return track(tunnelSocket(tunnel));
    }
    const checked = await checkEgressTarget(host, resolve);
    if (!checked.ok) throw new ProxyError(checked.code === "dns" ? 502 : 403, checked.message);
    const socket = track(dial(checked.address, port));
    const { promise, resolve: connected, reject: failed } = Promise.withResolvers<void>();
    const onError = () => failed(new ProxyError(502, "连接失败"));
    socket.once("connect", connected);
    socket.once("error", onError);
    socket.once("close", onError);
    const timer = setTimeout(() => socket.destroy(new Error("连接超时")), 10_000);
    try { await promise; }
    finally {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("error", onError);
      socket.off("close", onError);
    }
    return socket;
  }
}

class ProxyError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ProxyError"; }
}

function tunnelSocket(tunnel: Tunnel): Duplex {
  let owed = 0;
  const socket = new Duplex({
    allowHalfOpen: true,
    read() {
      const credit = owed;
      owed = 0;
      if (credit) tunnel.consumed(credit);
    },
    write(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      const pump = () => {
        while (offset < chunk.length) {
          const accepted = tunnel.write(chunk.subarray(offset));
          if (accepted === 0) { tunnel.onDrain(pump); return; }
          offset += accepted;
        }
        callback();
      };
      pump();
    },
    final(callback) { tunnel.end(); callback(); },
    destroy(error, callback) { tunnel.reset(); callback(error); },
  });
  tunnel.onData((chunk) => {
    if (socket.push(chunk)) tunnel.consumed(chunk.length);
    else owed += chunk.length;
  });
  tunnel.onClose((info) => {
    if (info.kind === "end") socket.push(null);
    else socket.destroy(new Error(info.message ?? "出口连接已断开"));
  });
  return socket;
}

function bridge(socket: Duplex, upstream: Duplex, head: Buffer): void {
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  if (head.length) upstream.write(head);
  socket.pipe(upstream).pipe(socket);
}

function headersOf(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  const nominated = new Set((headers.connection ?? "").toLowerCase().split(",").map((name) => name.trim()));
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP[name] && !nominated.has(name)) out[name] = value;
  }
  return out;
}

function parseAbsolute(raw: string): { host: string; port: number; path: string; hostHeader: string } | null {
  if (!raw.startsWith("http://")) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return { host: url.hostname, port: url.port ? Number(url.port) : 80, path: `${url.pathname}${url.search}`, hostHeader: url.host };
  } catch { return null; }
}

function parseAuthority(raw: string): { host: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:/\s]+):([0-9]+)$/.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  return { host: match[1].replace(/^\[|\]$/g, ""), port: Number(match[2]) };
}

function writeRaw(socket: Duplex, error: unknown): void {
  if (socket.destroyed) return;
  const status = error instanceof ProxyError ? error.status : 502;
  const reason = status === 403 ? "Forbidden" : status === 503 ? "Service Unavailable" : "Bad Gateway";
  const body = error instanceof Error ? error.message : "连接失败";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

export function proxyAddress(proxy: EgressProxy): AddressInfo {
  return { address: EGRESS_PROXY_HOST, family: "IPv4", port: proxy.port };
}
