/**
 * 纯 Node 出口客户端。重连间隔从 1 秒加倍，上限 60 秒。
 * 本地解析 DNS，拨号只用检查过后的 IP。
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { EGRESS_PING_INTERVAL_MS, EGRESS_PONG_TIMEOUT_MS, createClientPeer } from "@viate-bot/protocol";
import { WebSocket, type RawData } from "ws";
import { dialTarget, type DialOptions } from "./dial.js";
import { writeTokenFile } from "./token.js";

export interface EgressClientOptions extends DialOptions {
  url: string;
  token: string;
  statusFile?: string;
}

export function startEgressClient(options: EgressClientOptions): { close: () => Promise<void> } {
  let stopped = false;
  let socket: WebSocket | null = null;
  let wait = 1000;
  let timer: NodeJS.Timeout | undefined;
  let stopHeartbeat: () => void = () => undefined;
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(options.url, {
      headers: { authorization: `Bearer ${options.token}` },
      maxPayload: 70 * 1024,
    });
    socket = ws;
    const dialOptions: DialOptions = {};
    if (options.resolve) dialOptions.resolve = options.resolve;
    if (options.allowPrivate) dialOptions.allowPrivate = options.allowPrivate;
    if (options.connect) dialOptions.connect = options.connect;
    const peer = createClientPeer(
      (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(frame);
      },
      (host, port) => dialTarget(host, port, dialOptions),
    );
    let lastPong = Date.now();
    ws.on("pong", () => {
      lastPong = Date.now();
    });
    ws.on("open", () => {
      wait = 1000;
      writeStatus(options.statusFile, true);
      stopHeartbeat = arm(ws, () => {
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
    const failed = () => {
      stopHeartbeat();
      peer.close();
      writeStatus(options.statusFile, false);
      if (socket === ws) socket = null;
      if (stopped) return;
      timer = setTimeout(connect, wait);
      timer.unref?.();
      wait = Math.min(wait * 2, 60_000);
    };
    ws.on("close", failed);
    ws.on("error", () => ws.terminate());
  };
  connect();

  return {
    async close() {
      stopped = true;
      clearTimeout(timer);
      stopHeartbeat();
      socket?.terminate();
      writeStatus(options.statusFile, false);
      markClosed();
      await closed;
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
  tokenFile: string;
  fetchImpl?: typeof fetch;
  onUrl?: (url: string) => void;
}): Promise<{ url: string; deviceId: string }> {
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
  options.onUrl?.(url.toString());
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
  writeTokenFile(options.tokenFile, body.token);
  return { url: url.toString(), deviceId: body.deviceId };
}

export function egressWebSocketUrl(baseUrl: string): string {
  const url = new URL("/client/egress", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
