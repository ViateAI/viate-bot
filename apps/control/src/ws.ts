import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";

interface LiveSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (raw: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}
import type { ChatEvent } from "./agent/events.js";
import type { ControlConfig } from "./config.js";
import type { AppDatabase } from "./db/index.js";
import { chatRepository } from "./db/chat.js";
import type { AppRuntime } from "./providers.js";
import { resolveSession } from "./session.js";
import { userScope } from "./scope.js";

interface SocketState {
  userId: string;
  socket: LiveSocket;
  conversations: Set<string>;
}

export interface Hub {
  publish(conversationId: string, event: ChatEvent): void;
  disconnect(userId: string): void;
}

export interface SocketHub extends Hub {
  attach(state: SocketState): () => void;
}

export function createHub(): SocketHub {
  const sockets = new Set<SocketState>();
  return {
    publish(conversationId, event) {
      const payload = JSON.stringify(event);
      for (const state of sockets) {
        if (!state.conversations.has(conversationId)) continue;
        if (state.socket.readyState === state.socket.OPEN) state.socket.send(payload);
      }
    },
    disconnect(userId) {
      for (const state of [...sockets]) {
        if (state.userId !== userId) continue;
        sockets.delete(state);
        state.socket.close();
      }
    },
    attach(state) {
      sockets.add(state);
      return () => sockets.delete(state);
    },
  };
}

export interface WebsocketDeps {
  db: AppDatabase;
  key: Buffer;
  config: ControlConfig;
  runtime: AppRuntime;
  hub: SocketHub;
  now: () => Date;
}

export function registerWebsocket(app: FastifyInstance, deps: WebsocketDeps): void {
  const hub = deps.hub;
  app.register(websocket);
  app.after(() => {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (path !== "/ws") return;
    const origin = header(request.headers.origin);
    if (!sameOrigin(deps.config.publicUrl, origin)) {
      return reply.code(403).send({ error: "Origin 不匹配" });
    }
    const lookup = await resolveSession(
      deps.db,
      deps.key,
      deps.config,
      deps.runtime.identity,
      request.headers.cookie,
      deps.now(),
      deps.runtime.hooks.disconnectUser,
    );
    if (lookup.kind === "unavailable") return reply.code(503).send({ error: "暂时无法确认登录状态" });
    if (lookup.kind !== "ok") return reply.code(401).send({ error: "未登录" });
    admitted.set(request, lookup.resolved.user.id);
  });
  app.get("/ws", { websocket: true }, (socket, request) => {
      const userId = admitted.get(request);
      if (!userId) {
        socket.close();
        return;
      }
      const state: SocketState = { userId, socket: socket as LiveSocket, conversations: new Set() };
      const detach = hub.attach(state);
      socket.on("message", (raw: unknown) => {
        const text = rawText(raw);
        let body: { type?: unknown; conversationId?: unknown };
        try {
          body = JSON.parse(text) as { type?: unknown; conversationId?: unknown };
        } catch {
          socket.send(JSON.stringify({ type: "error", error: "消息不是 JSON" }));
          return;
        }
        if (body.type !== "subscribe" || typeof body.conversationId !== "string") {
          socket.send(JSON.stringify({ type: "error", error: "无法识别的消息" }));
          return;
        }
        const conversation = chatRepository(deps.db).findConversation(userScope(userId), body.conversationId);
        if (!conversation) {
          socket.send(JSON.stringify({ type: "error", error: "找不到对话" }));
          return;
        }
        state.conversations.add(conversation.id);
        socket.send(JSON.stringify({ type: "subscribed", conversationId: conversation.id }));
      });
      socket.on("close", () => detach());
  });
  });
}

const admitted = new WeakMap<FastifyRequest, string>();

function rawText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (Array.isArray(raw) && raw.every((item) => item instanceof Buffer)) return Buffer.concat(raw).toString("utf8");
  return "";
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function sameOrigin(publicUrl: string, origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}
