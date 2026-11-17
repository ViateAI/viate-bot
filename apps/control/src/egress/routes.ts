import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import { authenticated } from "../auth.js";
import type { AppDatabase } from "../db/index.js";
import { egressRepository, pkceChallenge, verifierOk, type EgressSettings } from "../db/egress.js";
import { hashToken } from "../session.js";
import { userScope, type UserScope } from "../scope.js";
import type { EgressGate } from "./gate.js";
import type { EgressHub } from "./hub.js";

export function callbackPort(value: unknown): number | null {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^[0-9]+$/.test(text)) return null;
  const port = Number(text);
  if (port < 1024 || port > 65535) return null;
  return port;
}

export function deviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export function callbackLocation(port: number, code: string, state: string): string {
  const url = new URL(`http://127.0.0.1:${port}/callback`);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url.toString();
}

function challengeOk(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function stateOk(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{8,256}$/.test(value);
}

export function registerEgressRoutes(
  app: FastifyInstance,
  deps: { db: AppDatabase; hub: EgressHub; gate: EgressGate },
): void {
  const repo = egressRepository(deps.db);

  app.get("/api/egress", async (request, reply) => {
    const scope = scopeOf(request);
    if (!scope) return reply.code(401).send({ error: "未登录" });
    repo.assignDefaultDevice(scope);
    const settings = repo.settings(scope);
    if (!settings) return reply.code(404).send({ error: "找不到" });
    return view(repo, scope, settings, deps.hub);
  });

  app.patch("/api/egress", async (request, reply) => {
    const scope = scopeOf(request);
    if (!scope) return reply.code(401).send({ error: "未登录" });
    const body = record(request.body);
    const patch: { mode?: "direct" | "user_network"; offlinePolicy?: "fallback_direct" | "pause"; deviceId?: string | null } = {};
    if (body.mode !== undefined) {
      if (body.mode !== "direct" && body.mode !== "user_network") return reply.code(400).send({ error: "出口方式无效" });
      patch.mode = body.mode;
    }
    if (body.offlinePolicy !== undefined) {
      if (body.offlinePolicy !== "pause" && body.offlinePolicy !== "fallback_direct") return reply.code(400).send({ error: "离线策略无效" });
      patch.offlinePolicy = body.offlinePolicy;
    }
    if (body.deviceId !== undefined) {
      if (body.deviceId !== null && typeof body.deviceId !== "string") return reply.code(400).send({ error: "设备无效" });
      patch.deviceId = body.deviceId;
    }
    if (!repo.updateSettings(scope, patch)) return reply.code(404).send({ error: "找不到" });
    deps.hub.notifySettings(scope.userId);
    deps.gate.release(scope.userId);
    const settings = repo.settings(scope);
    if (!settings) return reply.code(404).send({ error: "找不到" });
    return view(repo, scope, settings, deps.hub);
  });

  app.get("/api/client/devices", async (request, reply) => {
    const scope = scopeOf(request);
    if (!scope) return reply.code(401).send({ error: "未登录" });
    return { devices: listed(repo, scope, deps.hub) };
  });

  app.post<{ Params: { id: string } }>("/api/client/devices/:id/rename", async (request, reply) => {
    const scope = scopeOf(request);
    if (!scope) return reply.code(401).send({ error: "未登录" });
    const name = deviceName(record(request.body).name);
    if (!name) return reply.code(400).send({ error: "设备名无效" });
    if (!repo.renameDevice(scope, request.params.id, name)) return reply.code(404).send({ error: "找不到" });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/client/devices/:id/revoke", async (request, reply) => {
    const scope = scopeOf(request);
    if (!scope) return reply.code(401).send({ error: "未登录" });
    if (!repo.revokeDevice(scope, request.params.id)) return reply.code(404).send({ error: "找不到" });
    deps.hub.disconnectDevice(request.params.id);
    deps.hub.notifySettings(scope.userId);
    return { ok: true };
  });

  app.post("/api/client/link", async (request, reply) => {
    const scope = scopeOf(request);
    if (!scope) return reply.code(401).send({ error: "未登录" });
    const body = record(request.body);
    const port = callbackPort(body.redirectPort ?? body.redirect_port);
    const name = deviceName(body.deviceName ?? body.device_name);
    const challenge = body.codeChallenge ?? body.code_challenge;
    const state = body.state;
    if (port === null || !name || !challengeOk(challenge) || !stateOk(state)) return reply.code(400).send({ error: "绑定参数无效" });
    const { code } = repo.createLink(scope, { deviceName: name, codeChallenge: challenge, state, redirectPort: port });
    return { location: callbackLocation(port, code, state) };
  });

  app.post("/client/token", async (request, reply) => {
    const body = record(request.body);
    const code = typeof body.code === "string" ? body.code : "";
    const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
    const state = typeof body.state === "string" ? body.state : "";
    if (!code || !verifierOk(verifier) || !stateOk(state)) return reply.code(400).send({ error: "授权码无效" });
    const issued = repo.consumeLink({ code, verifier, state, challenge: pkceChallenge(verifier) });
    if (!issued) return reply.code(400).send({ error: "授权码无效" });
    return { token: issued.token, deviceId: issued.deviceId, deviceName: issued.name };
  });
}

export function registerEgressSocket(app: FastifyInstance, deps: { db: AppDatabase; hub: EgressHub }): void {
  const repo = egressRepository(deps.db);
  app.get("/client/egress", { websocket: true }, (socket, request) => {
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const device = token ? repo.findActiveByTokenHash(hashToken(token)) : undefined;
    const ws = socket as unknown as WebSocket;
    if (!device || repo.userStatus(device.userId) === "disabled") {
      ws.close(1008, "未认证");
      return;
    }
    const ip = request.socket.remoteAddress ?? null;
    deps.hub.attachClient(device.id, device.userId, ws, ip);
  });
}

function scopeOf(request: FastifyRequest): UserScope | undefined {
  const userId = authenticated.get(request)?.user.id;
  return userId ? userScope(userId) : undefined;
}

function record(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function listed(repo: ReturnType<typeof egressRepository>, scope: UserScope, hub: EgressHub) {
  const online = new Set(hub.onlineDeviceIds(scope.userId));
  return repo.listDevices(scope).map((device) => ({ ...device, online: online.has(device.id) }));
}

function view(repo: ReturnType<typeof egressRepository>, scope: UserScope, settings: EgressSettings, hub: EgressHub) {
  return {
    mode: settings.mode,
    offlinePolicy: settings.offlinePolicy,
    deviceId: settings.deviceId,
    deviceOnline: hub.deviceOnline(scope.userId, settings.deviceId),
    devices: listed(repo, scope, hub),
  };
}
