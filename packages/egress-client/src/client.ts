/**
 * 纯 Node 出口客户端。重连间隔从 1 秒加倍，上限 60 秒。
 * 本地解析 DNS，拨号只用检查过后的 IP。暂停时断开且不重连，使机器侧看到离线。
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { EGRESS_PING_INTERVAL_MS, EGRESS_PONG_TIMEOUT_MS, createClientPeer, type BytePipe, type EgressFailCode } from "@viate-bot/protocol";
import { WebSocket, type RawData } from "ws";
import { dialTarget, type DialOptions } from "./dial.js";
import { fileTokenStore, type TokenStore } from "./token.js";

export type EgressPhase = "online" | "offline" | "paused";

export type EgressClientEvent =
  | { type: "status"; phase: EgressPhase }
  | { type: "stats"; day: string; bytesToday: number }
  | { type: "dial"; category: EgressFailCode };

export interface EgressClientOptions extends DialOptions {
  url: string;
  token: string;
  statusFile?: string;
  initialStats?: { day: string; bytes: number };
  now?: () => Date;
}

export interface EgressClientHandle {
  close(): Promise<void>;
  pause(): void;
  resume(): void;
  setAllowFakeIp(allow: boolean): void;
  snapshot(): { phase: EgressPhase; day: string; bytesToday: number; allowFakeIp: boolean };
  subscribe(listener: (event: EgressClientEvent) => void): () => void;
}

export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function startEgressClient(options: EgressClientOptions): EgressClientHandle {
  let stopped = false;
  let paused = false;
  let reconnectSoon = false;
  let socket: WebSocket | null = null;
  let wait = 1000;
  let timer: NodeJS.Timeout | undefined;
  let generation = 0;
  let phase: EgressPhase = "offline";
  let allowFakeIp = options.allowFakeIp === true;
  const clock = options.now ?? (() => new Date());
  let day = localDay(clock());
  let bytesToday = initialBytes(options.initialStats, day);
  const listeners = new Set<(event: EgressClientEvent) => void>();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();

  const emit = (event: EgressClientEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 外壳监听器的异常不打断转发。
      }
    }
  };
  const setPhase = (next: EgressPhase) => {
    phase = next;
    emit({ type: "status", phase: next });
  };
  const addBytes = (count: number) => {
    if (!Number.isInteger(count) || count <= 0) return;
    const today = localDay(clock());
    if (today !== day) {
      day = today;
      bytesToday = 0;
    }
    bytesToday += count;
    emit({ type: "stats", day, bytesToday });
  };
  const dialOptions = (): DialOptions => {
    const next: DialOptions = { allowFakeIp };
    if (options.resolve) next.resolve = options.resolve;
    if (options.allowPrivate) next.allowPrivate = options.allowPrivate;
    if (options.connect) next.connect = options.connect;
    return next;
  };

  const connect = () => {
    if (stopped || paused) return;
    const mine = ++generation;
    const ws = new WebSocket(options.url, {
      headers: { authorization: `Bearer ${options.token}`, "x-vb-allow-fake-ip": allowFakeIp ? "true" : "false" },
      maxPayload: 70 * 1024,
    });
    socket = ws;
    let stopThis: () => void = () => undefined;
    const peer = createClientPeer(
      (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(frame);
      },
      async (host, port) => {
        try {
          const result = await dialTarget(host, port, dialOptions());
          if (!result.ok) {
            emit({ type: "dial", category: result.code });
            return result;
          }
          return { ok: true as const, pipe: meteredPipe(result.pipe, addBytes) };
        } catch {
          emit({ type: "dial", category: "connect" });
          return { ok: false as const, code: "connect" as const, message: "连接失败" };
        }
      },
    );
    let lastPong = Date.now();
    ws.on("pong", () => {
      lastPong = Date.now();
    });
    ws.on("open", () => {
      if (stopped || paused || mine !== generation) {
        ws.terminate();
        return;
      }
      wait = 1000;
      writeStatus(options.statusFile, true);
      setPhase("online");
      stopThis = arm(ws, () => {
        if (Date.now() - lastPong > EGRESS_PONG_TIMEOUT_MS) ws.terminate();
      });
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        ws.terminate();
        return;
      }
      try {
        peer.ingest(rawBuffer(data));
      } catch {
        ws.terminate();
      }
    });
    ws.on("close", () => {
      stopThis();
      peer.close();
      if (socket === ws) socket = null;
      if (mine !== generation || stopped) return;
      writeStatus(options.statusFile, false);
      if (paused) {
        setPhase("paused");
        return;
      }
      setPhase("offline");
      const delay = reconnectSoon ? 0 : wait;
      if (!reconnectSoon) wait = Math.min(wait * 2, 60_000);
      reconnectSoon = false;
      timer = setTimeout(connect, delay);
    });
    ws.on("error", () => ws.terminate());
  };
  connect();

  return {
    async close() {
      stopped = true;
      paused = false;
      reconnectSoon = false;
      generation += 1;
      clearTimeout(timer);
      socket?.terminate();
      socket = null;
      writeStatus(options.statusFile, false);
      markClosed();
      await closed;
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      reconnectSoon = false;
      clearTimeout(timer);
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      else {
        writeStatus(options.statusFile, false);
        setPhase("paused");
      }
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      wait = 1000;
      setPhase("offline");
      connect();
    },
    setAllowFakeIp(allow: boolean) {
      if (allowFakeIp === allow) return;
      allowFakeIp = allow;
      if (stopped || paused) return;
      reconnectSoon = true;
      clearTimeout(timer);
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      else connect();
    },
    snapshot() {
      return { phase, day, bytesToday, allowFakeIp };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function initialBytes(stats: { day: string; bytes: number } | undefined, today: string): number {
  if (!stats || stats.day !== today || !Number.isInteger(stats.bytes) || stats.bytes < 0) return 0;
  return stats.bytes;
}

function meteredPipe(pipe: BytePipe, add: (count: number) => void): BytePipe {
  return {
    write(chunk) {
      const ok = pipe.write(chunk);
      add(chunk.length);
      return ok;
    },
    end() {
      pipe.end();
    },
    destroy() {
      pipe.destroy();
    },
    pause() {
      pipe.pause();
    },
    resume() {
      pipe.resume();
    },
    onData(cb) {
      pipe.onData((chunk) => {
        add(chunk.length);
        cb(chunk);
      });
    },
    onEnd(cb) {
      pipe.onEnd(cb);
    },
    onDrain(cb) {
      pipe.onDrain(cb);
    },
    onError(cb) {
      pipe.onError(cb);
    },
  };
}

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(new Uint8Array(data));
}

function arm(ws: WebSocket, onTick: () => void): () => void {
  const timer = setInterval(() => {
    onTick();
    if (ws.readyState === ws.OPEN) ws.ping();
  }, EGRESS_PING_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function writeStatus(path: string | undefined, online: boolean): void {
  if (!path) return;
  const body = JSON.stringify({ online, updatedAt: new Date().toISOString() });
  try {
    writeFileSync(path, body, { mode: 0o600 });
  } catch {
    // 状态文件写失败不影响转发。
  }
}

export async function bindDevice(options: {
  baseUrl: string;
  deviceName: string;
  tokenFile?: string;
  tokenStore?: TokenStore;
  fetchImpl?: typeof fetch;
  onUrl?: (url: string) => void;
}): Promise<{ url: string; deviceId: string }> {
  const store = options.tokenStore ?? (options.tokenFile ? fileTokenStore(options.tokenFile) : undefined);
  if (!store) throw new Error("需要令牌存储");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const server = createServer();
  const { promise: listening, resolve: markListening } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => markListening());
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("回调端口没有监听");
  const url = new URL("/client/link", options.baseUrl);
  url.searchParams.set("redirect_port", String(address.port));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("device_name", options.deviceName);
  const { promise: codePromise, resolve: takeCode, reject: failCode } = Promise.withResolvers<string>();
  const timer = setTimeout(() => failCode(new Error("等待回调超时")), 60_000);
  server.on("request", (request, response) => {
    const target = new URL(request.url ?? "/", "http://127.0.0.1");
    if (target.pathname !== "/callback") {
      response.writeHead(404);
      response.end();
      return;
    }
    clearTimeout(timer);
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("可以关闭这个页面");
    if (target.searchParams.get("state") !== state) {
      failCode(new Error("state 不匹配"));
      return;
    }
    takeCode(target.searchParams.get("code") ?? "");
  });
  try {
    options.onUrl?.(url.toString());
  } catch (error) {
    clearTimeout(timer);
    server.close();
    throw error;
  }
  const code = await codePromise.finally(() => {
    server.close();
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenUrl = new URL("/client/token", options.baseUrl);
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, state }),
  });
  if (!response.ok) throw new Error("换取设备令牌失败");
  const body = (await response.json()) as { token?: string; deviceId?: string };
  if (!body.token || !body.deviceId) throw new Error("换取设备令牌失败");
  await store.write(body.token);
  return { url: url.toString(), deviceId: body.deviceId };
}

export function egressWebSocketUrl(baseUrl: string): string {
  const url = new URL("/client/egress", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
