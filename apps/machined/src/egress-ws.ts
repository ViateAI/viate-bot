/**
 * 控制面连进来的 /egress。配置是文本帧，流数据是二进制帧。
 * 升级请求不经过 Fastify 的 onRequest，所以这里自己核对 Bearer。
 */
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { createMachinePeer, EGRESS_PING_INTERVAL_MS, EGRESS_PONG_TIMEOUT_MS } from "@viate-bot/protocol";
import { WebSocketServer, type RawData } from "ws";
import type { EgressProxy } from "./egress-proxy.js";

export function attachEgress(app: FastifyInstance, proxy: EgressProxy, token: string): void {
  // Never expose the host IP before the control plane supplies the persisted mode.
  proxy.setConfig({ mode: "user_network", offlinePolicy: "pause", deviceOnline: false });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 70 * 1024 });
  let active: { close: () => void } | null = null;

  const stop = () => {
    active?.close();
    active = null;
    proxy.setPeer(null);
    for (const client of wss.clients) client.terminate();
  };
  app.addHook("preClose", async () => stop());
  app.addHook("onClose", async () => {
    stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  app.server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/egress") return;
    if (request.headers.authorization !== `Bearer ${token}`) {
      reject(socket, 401, "Unauthorized", "未认证");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      active?.close();
      const peer = createMachinePeer((frame) => {
        if (ws.readyState === ws.OPEN) ws.send(frame);
      });
      proxy.setPeer(peer);
      let lastPong = Date.now();
      ws.on("pong", () => {
        lastPong = Date.now();
      });
      const timer = setInterval(() => {
        if (Date.now() - lastPong > EGRESS_PONG_TIMEOUT_MS) {
          ws.terminate();
          return;
        }
        ws.ping();
      }, EGRESS_PING_INTERVAL_MS);
      timer.unref();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        peer.failAll("offline", "出口连接已断开");
        if (active?.close === close) {
          active = null;
          proxy.setPeer(null);
        }
        ws.terminate();
      };
      active = { close };
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          applyConfig(proxy, data);
          return;
        }
        try {
          peer.ingest(bytes(data));
        } catch {
          close();
        }
      });
      ws.on("close", () => close());
      ws.on("error", () => close());
    });
  });

  app.get("/egress", async (_request, reply) => reply.code(426).send({ error: "需要 WebSocket 升级" }));
}

function applyConfig(proxy: EgressProxy, data: RawData): void {
  let body: unknown;
  try {
    body = JSON.parse(bytes(data).toString("utf8")) as unknown;
  } catch {
    return;
  }
  if (!body || typeof body !== "object") return;
  const record = body as { type?: unknown; egressMode?: unknown; offlinePolicy?: unknown; deviceOnline?: unknown };
  if (record.type !== "config") return;
  if (record.egressMode !== "direct" && record.egressMode !== "user_network") return;
  if (record.offlinePolicy !== "fallback_direct" && record.offlinePolicy !== "pause") return;
  proxy.setConfig({
    mode: record.egressMode,
    offlinePolicy: record.offlinePolicy,
    deviceOnline: record.deviceOnline === true,
  });
}

function reject(socket: Duplex, status: number, statusText: string, error: string): void {
  const body = JSON.stringify({ error });
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}
function bytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
