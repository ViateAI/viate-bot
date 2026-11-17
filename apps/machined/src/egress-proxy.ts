/**
 * 机器内的 HTTP 代理。只听 127.0.0.1，只放行 80 和 443。
 * direct 由这里解析并拨号；user_network 把主机名原样交给已经接上的出口流，由客户端解析。
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
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

/** 上游是 chunked 时先拆开再交给 Node。否则去掉 transfer-encoding 头之后，浏览器会把分块边界当成正文。 */
function chunkedBody(write: (chunk: Buffer) => boolean): (chunk: Buffer) => boolean {
  let pending = Buffer.alloc(0);
  let size: number | null = null;
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      if (size === null) {
        const line = pending.indexOf("\r\n");
        if (line < 0) return true;
        const text = pending.subarray(0, line).toString("latin1").split(";")[0] ?? "";
        const next = Number.parseInt(text, 16);
        if (!Number.isFinite(next) || next < 0) return true;
        pending = Buffer.from(pending.subarray(line + 2));
        if (next === 0) return true;
        size = next;
      }
      if (pending.length < size + 2) return true;
      const body = Buffer.from(pending.subarray(0, size));
      pending = Buffer.from(pending.subarray(size + 2));
      size = null;
      if (!write(body)) return false;
    }
  };
}

export function proxyEnvironment(port: number, base: NodeJS.ProcessEnv, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const value = `http://${EGRESS_PROXY_HOST}:${port}`;
  return {
    ...base,
    ...extra,
    HTTP_PROXY: value,
    HTTPS_PROXY: value,
    http_proxy: value,
    https_proxy: value,
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
    HOME: "/home/bot",
    USER: "bot",
    LOGNAME: "bot",
  };
}

export function startEgressProxy(options: {
  port?: number;
  resolve?: (host: string) => Promise<string[]>;
  dial?: (address: string, port: number) => net.Socket;
} = {}): EgressProxy {
  const resolve = options.resolve ?? defaultResolve;
  const dial = options.dial ?? ((address: string, port: number) => net.connect({ host: address, port, family: net.isIP(address) === 6 ? 6 : 4 }));
  let config: EgressConfig = { mode: "direct", offlinePolicy: "pause", deviceOnline: false };
  let peer: MachinePeer | null = null;
  const server = http.createServer((req, res) => {
    void handleHttp(req, res).catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) return;
      const status = error instanceof ProxyError ? error.status : 502;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end(error instanceof Error ? error.message : "连接失败");
    });
  });
  server.on("connect", (req, socket, head) => {
    void handleConnect(req, socket, head).catch((error: unknown) => {
      const status = error instanceof ProxyError ? error.status : 502;
      const message = error instanceof Error ? error.message : "连接失败";
      writeRaw(socket, status, message);
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? EGRESS_PROXY_PORT, EGRESS_PROXY_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    ready,
    get port() {
      const address = server.address();
      return address && typeof address === "object" ? address.port : (options.port ?? EGRESS_PROXY_PORT);
    },
    setConfig(next) {
      config = next;
    },
    setPeer(next) {
      peer = next;
    },
    close() {
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };

  function decide(): "direct" | "tunnel" | "pause" {
    if (config.mode !== "user_network") return "direct";
    if (config.deviceOnline && peer) return "tunnel";
    if (config.offlinePolicy === "fallback_direct") return "direct";
    return "pause";
  }

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pending: Buffer[] = [];
    let requestEnded = false;
    let link: Link | null = null;
    const flush = () => {
      if (!link) return;
      while (pending.length > 0) {
        const next = pending[0];
        if (!next) break;
        if (!link.send(next)) {
          req.pause();
          return;
        }
        pending.shift();
      }
      if (requestEnded) link.finish();
    };
    req.on("data", (chunk: Buffer) => {
      pending.push(chunk);
      let queued = 0;
      for (const item of pending) queued += item.length;
      if (!link && queued > 1024 * 1024) {
        req.destroy();
        return;
      }
      flush();
    });
    req.on("end", () => {
      requestEnded = true;
      flush();
    });
    req.on("error", () => link?.destroy());
    const target = parseAbsolute(req.url ?? "");
    if (!target) throw new ProxyError(400, "需要绝对 URL");
    if (!portAllowed(target.port)) throw new ProxyError(403, "端口不允许");
    const route = decide();
    if (route === "pause") {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(OFFLINE_HTML), connection: "close" });
      res.end(OFFLINE_HTML);
      return;
    }
    const opened = await open(route, target.host, target.port);
    link = opened;
    let headersSent = false;
    let buffer = Buffer.alloc(0);
    let decode: ((chunk: Buffer) => boolean) | null = null;
    const writeBody = (chunk: Buffer) => {
      if (chunk.length === 0) return true;
      const ok = res.write(chunk);
      if (!ok) opened.pause();
      return ok;
    };
    opened.onData((chunk) => {
      if (headersSent) return decode ? decode(chunk) : writeBody(chunk);
      buffer = Buffer.concat([buffer, chunk]);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) {
        if (buffer.length > 64 * 1024) opened.destroy();
        return true;
      }
      const raw = buffer.subarray(0, split).toString("latin1");
      const rest = buffer.subarray(split + 4);
      const [statusLine, ...lines] = raw.split("\r\n");
      const status = Number(statusLine?.split(" ")[1] ?? 502);
      const headers: Record<string, string | string[]> = {};
      let chunked = false;
      for (const line of lines) {
        const index = line.indexOf(":");
        if (index <= 0) continue;
        const name = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        if (name.toLowerCase() === "transfer-encoding" && value.toLowerCase().includes("chunked")) chunked = true;
        if (HOP[name.toLowerCase()]) continue;
        const existing = headers[name];
        headers[name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
      }
      headersSent = true;
      if (chunked) decode = chunkedBody(writeBody);
      res.writeHead(Number.isInteger(status) ? status : 502, { ...headers, connection: "close" });
      if (rest.length === 0) return true;
      return decode ? decode(rest) : writeBody(rest);
    });
    res.on("drain", () => opened.resume());
    opened.onEnd(() => {
      if (!res.writableEnded) res.end();
    });
    opened.onError(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    const head = Buffer.from(`${req.method ?? "GET"} ${target.path} HTTP/1.1\r\nHost: ${target.hostHeader}\r\n${headerLines(req)}\r\n`);
    pending.unshift(head);
    opened.onSendDrain(() => {
      req.resume();
      flush();
    });
    res.on("close", () => opened.destroy());
    flush();
  }

  async function handleConnect(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const target = parseAuthority(req.url ?? "");
    if (!target) throw new ProxyError(400, "CONNECT 目标无效");
    if (!portAllowed(target.port)) throw new ProxyError(403, "端口不允许");
    const route = decide();
    if (route === "pause") throw new ProxyError(503, OFFLINE_BODY);
    const link = await open(route, target.host, target.port);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    link.onData((chunk) => {
      const ok = socket.write(chunk);
      if (!ok) link.pause();
      return ok;
    });
    socket.on("drain", () => link.resume());
    if (head.length > 0 && !link.send(head)) socket.pause();
    socket.on("data", (chunk: Buffer) => {
      if (!link.send(chunk)) socket.pause();
    });
    link.onSendDrain(() => socket.resume());
    socket.on("end", () => link.finish());
    socket.on("error", () => link.destroy());
    socket.on("close", () => link.destroy());
    link.onEnd(() => socket.end());
    link.onError(() => socket.destroy());
  }

  async function open(route: "direct" | "tunnel", host: string, port: number): Promise<Link> {
    if (route === "tunnel") return openTunnel(host, port);
    const checked = await checkEgressTarget(host, resolve);
    if (!checked.ok) throw new ProxyError(checked.code === "dns" ? 502 : 403, checked.message);
    const socket = dial(checked.address, port);
    const timer = setTimeout(() => {
      socket.destroy();
    }, 10_000);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", () => reject(new ProxyError(502, "连接失败")));
      });
    } catch {
      throw new ProxyError(502, "连接失败");
    } finally {
      clearTimeout(timer);
    }
    return socketLink(socket);
  }

  async function openTunnel(host: string, port: number): Promise<Link> {
    if (!peer) throw new ProxyError(503, OFFLINE_BODY);
    const tunnel = peer.open(host, port);
    const timer = setTimeout(() => tunnel.reset(), EGRESS_OPEN_TIMEOUT_MS);
    try {
      await tunnel.ready;
    } catch (error) {
      const status = error instanceof EgressOpenError && error.code === "blocked" ? 403 : 502;
      throw new ProxyError(status, error instanceof Error ? error.message : "连接失败");
    } finally {
      clearTimeout(timer);
    }
    return tunnelLink(tunnel);
  }
}

class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

interface Link {
  send(chunk: Buffer): boolean;
  finish(): void;
  destroy(): void;
  pause(): void;
  resume(): void;
  onData(cb: (chunk: Buffer) => boolean): void;
  onSendDrain(cb: () => void): void;
  onEnd(cb: () => void): void;
  onError(cb: () => void): void;
}

function socketLink(socket: net.Socket): Link {
  let onData: (chunk: Buffer) => boolean = () => true;
  let onSendDrain: () => void = () => undefined;
  let onEnd: () => void = () => undefined;
  let onError: () => void = () => undefined;
  socket.on("data", (chunk: Buffer) => {
    if (!onData(chunk)) socket.pause();
  });
  socket.on("drain", () => onSendDrain());
  socket.on("end", () => onEnd());
  socket.on("error", () => onError());
  return {
    send(chunk) {
      return socket.write(chunk);
    },
    finish() {
      socket.end();
    },
    destroy() {
      socket.destroy();
    },
    pause() {
      socket.pause();
    },
    resume() {
      socket.resume();
    },
    onData(cb) {
      onData = cb;
    },
    onSendDrain(cb) {
      onSendDrain = cb;
    },
    onEnd(cb) {
      onEnd = cb;
    },
    onError(cb) {
      onError = cb;
    },
  };
}

function tunnelLink(tunnel: Tunnel): Link {
  let onData: (chunk: Buffer) => boolean = () => true;
  let onSendDrain: () => void = () => undefined;
  let onEnd: () => void = () => undefined;
  let onError: () => void = () => undefined;
  const pending: Buffer[] = [];
  let ended = false;
  let pumping = false;
  let blocked = false;
  let owed = 0;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    while (pending.length > 0) {
      const next = pending[0];
      if (!next) break;
      const accepted = tunnel.write(next);
      if (accepted <= 0) {
        pumping = false;
        blocked = true;
        tunnel.onDrain(pump);
        return;
      }
      if (accepted < next.length) pending[0] = next.subarray(accepted);
      else pending.shift();
    }
    pumping = false;
    if (blocked) {
      blocked = false;
      onSendDrain();
    }
    if (ended && pending.length === 0) tunnel.end();
  };
  tunnel.onData((chunk) => {
    const ok = onData(chunk);
    if (ok) tunnel.consumed(chunk.length);
    else owed += chunk.length;
  });
  tunnel.onClose((info) => {
    if (info.kind === "end") onEnd();
    else onError();
  });
  return {
    send(chunk) {
      if (chunk.length === 0) return true;
      pending.push(chunk);
      pump();
      return pending.length === 0;
    },
    finish() {
      if (ended) return;
      ended = true;
      pump();
    },
    destroy() {
      tunnel.reset();
    },
    pause() {},
    resume() {
      if (owed > 0) {
        const credit = owed;
        owed = 0;
        tunnel.consumed(credit);
      }
    },
    onData(cb) {
      onData = cb;
    },
    onSendDrain(cb) {
      onSendDrain = cb;
    },
    onEnd(cb) {
      onEnd = cb;
    },
    onError(cb) {
      onError = cb;
    },
  };
}

function parseAbsolute(raw: string): { host: string; port: number; path: string; hostHeader: string } | null {
  if (!raw.startsWith("http://")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port)) return null;
  return { host: url.hostname, port, path: `${url.pathname}${url.search}`, hostHeader: url.host };
}

function parseAuthority(raw: string): { host: string; port: number } | null {
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0 || raw[end + 1] !== ":") return null;
    const port = Number(raw.slice(end + 2));
    if (!Number.isInteger(port)) return null;
    return { host: raw.slice(1, end), port };
  }
  const colon = raw.lastIndexOf(":");
  if (colon <= 0) return null;
  const port = Number(raw.slice(colon + 1));
  if (!Number.isInteger(port)) return null;
  return { host: raw.slice(0, colon), port };
}

function headerLines(req: http.IncomingMessage): string {
  const lines: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (!name || value === undefined) continue;
    if (HOP[name.toLowerCase()] || name.toLowerCase() === "host") continue;
    lines.push(`${name}: ${value}\r\n`);
  }
  return lines.join("");
}

function writeRaw(socket: Duplex, status: number, message: string): void {
  const reason = status === 403 ? "Forbidden" : status === 503 ? "Service Unavailable" : "Bad Gateway";
  const body = Buffer.from(message);
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.toString("utf8")}`,
  );
}

export function proxyAddress(proxy: EgressProxy): AddressInfo {
  return { address: EGRESS_PROXY_HOST, family: "IPv4", port: proxy.port };
}
