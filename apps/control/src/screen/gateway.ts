import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import WebSocket from "ws";
import type { MachineEndpoint } from "@viate-bot/protocol";
import type { ControlConfig } from "../config.js";
import { botRepository } from "../db/bots.js";
import type { AppDatabase } from "../db/index.js";
import type { AppRuntime } from "../providers.js";
import { userScope } from "../scope.js";
import { resolveSession, type ResolvedSession } from "../session.js";
import { sameOrigin } from "../ws.js";
import type { ScreenInputDrain } from "./input-drain.js";
import type { TakeoverLeases } from "./leases.js";
import { RfbClientFilter } from "./rfb.js";

export interface ScreenDeps {
  db: AppDatabase;
  key: Buffer;
  config: ControlConfig;
  runtime: AppRuntime;
  now: () => Date;
  leases: TakeoverLeases;
  inputDrain: ScreenInputDrain;
  wake: (userId: string, reason: "panel") => Promise<void>;
  endpoint: (userId: string, botId: string) => Promise<{ machine: MachineEndpoint; display: number }>;
}

const viewers = new Map<string, { userId: string; botId: string; sessionId: string; client: WebSocket }>();
const admitted = new WeakMap<FastifyRequest, ResolvedSession>();

function isInputFrame(frame: Buffer): boolean {
  return frame[0] === 4 || frame[0] === 5 || frame[0] === 6;
}

export function maySendFilteredFrame(frame: Buffer, ticket: number | undefined, stillAllowed: (ticket: number) => boolean): boolean {
  return !isInputFrame(frame) || (ticket !== undefined && stillAllowed(ticket));
}

export function hasAttachedViewer(userId: string): boolean {
  return [...viewers.values()].some((viewer) => viewer.userId === userId);
}

async function authorize(request: FastifyRequest, deps: ScreenDeps) {
  const origin = request.headers.origin;
  if ((origin || request.headers.upgrade || request.method !== "GET") && !sameOrigin(deps.config.publicUrl, origin)) return { status: 403 as const };
  const lookup = await resolveSession(deps.db, deps.key, deps.config, deps.runtime.identity, request.headers.cookie, deps.now(), deps.runtime.hooks.disconnectUser);
  if (lookup.kind === "unavailable") return { status: 503 as const };
  if (lookup.kind !== "ok") return { status: 401 as const };
  return { session: lookup.resolved };
}

export function registerScreenGateway(app: FastifyInstance, deps: ScreenDeps): (userId: string) => void {
  const attached = new Set<WebSocket>();
  app.addHook("preClose", async () => { for (const client of attached) client.terminate(); });
  app.get<{ Params: { id: string }; Querystring: { socket: string } }>("/api/bots/:id/screen/vnc", {
      websocket: true,
      preValidation: async (request, reply) => {
        const auth = await authorize(request, deps);
        if ("status" in auth) return reply.code(auth.status).send({ error: "未认证" });
        if (!botRepository(deps.db).findById(userScope(auth.session.user.id), request.params.id)) return reply.code(404).send({ error: "找不到 bot" });
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(request.query.socket ?? "") || viewers.has(request.query.socket)) return reply.code(400).send({ error: "连接标识无效" });
        admitted.set(request, auth.session);
      },
    }, (client, request) => {
      const session = admitted.get(request);
      if (!session) { client.close(); return; }
      const socketId = request.query.socket;
      if (viewers.has(socketId)) { client.close(); return; }
      const userId = session.user.id;
      const botId = request.params.id;
      viewers.set(socketId, { userId, botId, sessionId: session.session.id, client });
      attached.add(client);
      deps.leases.attach(socketId, botId, session.session.id);
      let upstream: WebSocket | undefined;
      let closed = false;
      // Only handshake bytes may be queued; filtered client frames are never queued.
      const queuedHandshake: Buffer[] = [];
      const filter = new RfbClientFilter();
      let handshake = 0;
      let buffered = Buffer.alloc(0);
      let machine: { host: string; port: number; token: string; display: number } | undefined;
      let machineInput = false;
      const conn = randomBytes(16).toString("hex");
      const sendHandshake = (data: Buffer) => {
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
        else { queuedHandshake.push(data); if (queuedHandshake.reduce((sum, item) => sum + item.length, 0) > 1024 * 1024) client.close(); }
      };
      const sessionLive = async () => {
        const lookup = await resolveSession(deps.db, deps.key, deps.config, deps.runtime.identity, request.headers.cookie, deps.now(), deps.runtime.hooks.disconnectUser);
        return lookup.kind === "ok" && lookup.resolved.session.id === session.session.id && lookup.resolved.user.id === userId;
      };
      const setMachineInput = async (input: boolean) => {
        if (!machine || machineInput === input) return;
        const response = await fetch(`http://${machine.host}:${machine.port}/displays/${machine.display}/vnc-mode`, {
          method: "POST",
          headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json" },
          body: JSON.stringify({ conn, input }),
        });
        if (!response.ok) throw new Error("vnc mode");
        machineInput = input;
      };
      const timer = setInterval(() => {
        if (machineInput && !deps.leases.canControl(socketId)) void setMachineInput(false).catch(() => client.close());
      }, 1000);
      timer.unref();
      let alive = true;
      client.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) { client.terminate(); return; }
        alive = false;
        client.ping();
        void sessionLive().then((live) => { if (!live) client.terminate(); }).catch(() => client.terminate());
      }, 30_000);
      heartbeat.unref();
      const unbindInput = deps.inputDrain.bind(botId, () => setMachineInput(false));
      const stillAllowed = (ticket: number) => deps.inputDrain.epoch(botId) === ticket && deps.leases.canControl(socketId);
      let inbound = Promise.resolve();
      client.on("message", (raw) => {
        inbound = inbound.then(async () => {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
          buffered = Buffer.concat([buffered, chunk]);
          while (handshake < 3) {
            const length = handshake === 0 ? 12 : 1;
            if (buffered.length < length) return;
            const part = buffered.subarray(0, length);
            if ((handshake === 0 && part.toString() !== "RFB 003.008\n") || (handshake === 1 && part[0] !== 1) || (handshake === 2 && part[0] !== 0 && part[0] !== 1)) throw new Error("RFB handshake invalid");
            sendHandshake(part);
            buffered = buffered.subarray(length);
            handshake++;
          }
          if (!deps.leases.canControl(socketId)) await setMachineInput(false);
          const parts = filter.push(buffered, () => deps.leases.canControl(socketId));
          buffered = Buffer.alloc(0);
          const input = parts.some(isInputFrame);
          const ticket = input ? deps.inputDrain.begin(botId) : undefined;
          try {
            if (input) {
              if (ticket === undefined || !(await sessionLive()) || !stillAllowed(ticket)) {
                await setMachineInput(false);
                client.close();
                return;
              }
              await setMachineInput(true);
              if (!stillAllowed(ticket)) {
                await setMachineInput(false);
                return;
              }
            }
            if (parts.length && upstream?.readyState !== WebSocket.OPEN) throw new Error("RFB upstream not ready");
            for (const part of parts) {
              if (!maySendFilteredFrame(part, ticket, stillAllowed)) {
                await setMachineInput(false);
                return;
              }
              upstream?.send(part);
            }
          } finally {
            if (ticket !== undefined) deps.inputDrain.end(botId);
          }
        }).catch(() => client.close());
      });
      client.on("close", () => {
        closed = true;
        attached.delete(client);
        unbindInput();
        clearInterval(timer);
        clearInterval(heartbeat);
        if (viewers.get(socketId)?.client === client) {
          viewers.delete(socketId);
          deps.leases.detach(socketId);
        }
        upstream?.terminate();
        if (machine && machineInput) {
          machineInput = false;
          void fetch(`http://${machine.host}:${machine.port}/displays/${machine.display}/vnc-mode`, {
            method: "POST",
            headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json" },
            body: JSON.stringify({ conn, input: false }),
          }).catch(() => undefined);
        }
      });
      client.on("error", () => client.terminate());
      void (async () => {
        await deps.wake(userId, "panel");
        const target = await deps.endpoint(userId, botId);
        if (closed) return;
        machine = { host: target.machine.host, port: target.machine.port, token: target.machine.token, display: target.display };
        const opened = await fetch(`http://${machine.host}:${machine.port}/displays/${machine.display}`, {
          method: "POST",
          headers: { authorization: `Bearer ${machine.token}` },
        });
        if (!opened.ok || closed) { client.close(); return; }
        const url = new URL(`ws://${machine.host}:${machine.port}/displays/${machine.display}/vnc`);
        url.searchParams.set("conn", conn);
        upstream = new WebSocket(url, { headers: { authorization: `Bearer ${machine.token}` } });
        upstream.on("open", () => {
          for (const data of queuedHandshake.splice(0)) upstream?.send(data);
        });
        upstream.on("message", (data) => { if (client.readyState === client.OPEN) client.send(data); });
        upstream.on("close", () => client.close());
        upstream.on("error", () => client.close());
      })().catch(() => client.close());
    });
  return (userId) => {
    for (const viewer of viewers.values()) {
      if (viewer.userId === userId && attached.has(viewer.client)) viewer.client.terminate();
    }
  };
}

export function registerScreenRoutes(app: FastifyInstance, deps: ScreenDeps): void {
  app.route<{ Params: { id: string; action: string }; Body: { leaseId?: string; socketId?: string } }>({
    method: ["GET", "POST"], url: "/api/bots/:id/screen/:action",
    handler: async (request, reply) => {
      const auth = await authorize(request, deps);
      if ("status" in auth) return reply.code(auth.status).send({ error: "未认证" });
      const { user, session } = auth.session;
      if (!botRepository(deps.db).findById(userScope(user.id), request.params.id)) return reply.code(404).send({ error: "找不到 bot" });
      if (request.method === "GET" && request.params.action === "leases") {
        const query = request.query as { socket?: string };
        const viewer = query.socket ? viewers.get(query.socket) : undefined;
        const controlledHere = !!query.socket && viewer?.userId === user.id && viewer.botId === request.params.id && viewer.sessionId === session.id && deps.leases.canControl(query.socket);
        return { leases: deps.leases.pending(request.params.id).map(({ id, state }) => ({ id, state, controlledHere })) };
      }
      if (request.method !== "POST" || !request.body?.leaseId) return reply.code(404).send({ error: "找不到" });
      const lease = deps.leases.pending(request.params.id).find((item) => item.id === request.body.leaseId);
      if (!lease) return reply.code(404).send({ error: "找不到接管请求" });
      let ok = false;
      if (request.params.action === "grant" && request.body.socketId) {
        const viewer = viewers.get(request.body.socketId);
        if (viewer?.userId === user.id && viewer.botId === request.params.id && viewer.sessionId === session.id) ok = deps.leases.grant(lease.id, request.body.socketId, user.id, session.id);
      } else if (request.params.action === "release") ok = deps.leases.release(lease.id, user.id, session.id);
      else if (request.params.action === "revoke") ok = deps.leases.revoke(lease.id, user.id);
      if (!ok) return reply.code(409).send({ error: "接管状态已改变" });
      return { ok: true };
    },
  });
}
