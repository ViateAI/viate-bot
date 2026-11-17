import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { encodeEgressFrame, FRAME_OPEN } from "@viate-bot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { buildApp, type ControlContext } from "../app.js";
import { recoverInterruptedTasks } from "../agent/service.js";
import { loadConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { ensureDevUser, userRepository } from "../db/users.js";
import { RELAY_BUFFER_CAP, attachRelay, type RelaySocket } from "./relay.js";
import { createSession } from "../session.js";
import { callbackPort } from "./routes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-egress-"));
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "secret",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
  });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const ctx: ControlContext = { db, driver: { inspect: async () => null } as unknown as ControlContext["driver"], config, key: loadOrCreateKey(config.secretKeyPath) };
  ensureDevUser(db, "user-a");
  ensureDevUser(db, "user-b");
  const now = new Date().toISOString();
  db.$client
    .prepare(
      `insert into machines (id, user_id, state, spec_json, image_version, volume_name, machined_token_enc, created_at, updated_at)
       values (?, ?, 'stopped', '{"cpu":1,"memMb":512,"diskGb":1}', 'dev', ?, 'enc', ?, ?)`,
    )
    .run("machine-a", "user-a", "vb-home-user-a", now, now);
  db.$client
    .prepare(
      `insert into machines (id, user_id, state, spec_json, image_version, volume_name, machined_token_enc, created_at, updated_at)
       values (?, ?, 'stopped', '{"cpu":1,"memMb":512,"diskGb":1}', 'dev', ?, 'enc', ?, ?)`,
    )
    .run("machine-b", "user-b", "vb-home-user-b", now, now);
  const app = buildApp(ctx, { ensureMachine: async () => {}, prepareEndpoint: async () => ({ host: "127.0.0.1", port: 9, token: "t" }) });
  const alice = createSession(db, ctx.key, "user-a", "refresh-a", new Date());
  const bob = createSession(db, ctx.key, "user-b", "refresh-b", new Date());
  cleanups.push(async () => {
    const { egressHub } = await import("../app.js");
    egressHub(app).close();
    app.server.closeAllConnections?.();
    const { promise: giveUp, resolve: stopWaiting } = Promise.withResolvers<void>();
    setTimeout(stopWaiting, 500);
    await Promise.race([app.close(), giveUp]);
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, db, alice, bob };
}

function cookie(token: string): string {
  return `vb_session=${encodeURIComponent(token)}`;
}

async function issue(app: ReturnType<typeof boot>["app"], session: { token: string; csrf: string }, name: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const linked = await app.inject({
    method: "POST",
    url: "/api/client/link",
    headers: { cookie: cookie(session.token), "x-vb-csrf": session.csrf, "content-type": "application/json" },
    payload: { redirectPort: 4400, deviceName: name, codeChallenge: challenge, state },
  });
  expect(linked.statusCode).toBe(200);
  const location = new URL(linked.json().location as string);
  expect(location.origin).toBe("http://127.0.0.1:4400");
  expect(location.pathname).toBe("/callback");
  const exchanged = await app.inject({
    method: "POST",
    url: "/client/token",
    headers: { "content-type": "application/json" },
    payload: { code: location.searchParams.get("code"), code_verifier: verifier, state },
  });
  expect(exchanged.statusCode).toBe(200);
  return exchanged.json() as { token: string; deviceId: string };
}

describe("egress control plane", () => {
  it("rejects loopback ports outside 1024-65535", () => {
    expect(callbackPort(80)).toBeNull();
    expect(callbackPort(1023)).toBeNull();
    expect(callbackPort(65536)).toBeNull();
    expect(callbackPort("0127")).toBeNull();
    expect(callbackPort("127.0.0.1")).toBeNull();
    expect(callbackPort("1024 ")).toBeNull();
    expect(callbackPort(4400)).toBe(4400);
  });

  it("keeps a device token off /api and hides another user's device", async () => {
    const { app, db, alice, bob } = boot();
    const issued = await issue(app, alice, "A 的电脑");
    const mine = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${issued.token}`, cookie: cookie(alice.token) },
    });
    expect(mine.statusCode).toBe(401);
    const bare = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${issued.token}` } });
    expect(bare.statusCode).toBe(401);
    const renamed = await app.inject({
      method: "POST",
      url: `/api/client/devices/${issued.deviceId}/rename`,
      headers: { cookie: cookie(bob.token), "x-vb-csrf": bob.csrf, "content-type": "application/json" },
      payload: { name: "偷来的" },
    });
    expect(renamed.statusCode).toBe(404);
    db.$client.prepare("update client_devices set last_ip = ? where id = ?").run("203.0.113.50", issued.deviceId);
    db.$client.prepare("update users set is_admin = 1 where id = 'user-a'").run();
    const admin = await app.inject({ method: "GET", url: "/api/admin/machines", headers: { cookie: cookie(alice.token) } });
    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.body).not.toContain("203.0.113.50");
    expect(JSON.stringify(admin.json())).toContain("egressMode");
    const again = await app.inject({
      method: "POST",
      url: "/client/token",
      headers: { "content-type": "application/json" },
      payload: { code: "already-used-code-value", code_verifier: randomBytes(32).toString("base64url"), state: randomBytes(16).toString("base64url") },
    });
    expect(again.statusCode).toBe(400);
  });

  it("drops a client that sends OPEN, isolates machines, and closes on revoke", async () => {
    const { app, db, alice, bob } = boot();
    const deviceA = await issue(app, alice, "甲");
    const deviceB = await issue(app, bob, "乙");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("没有监听端口");
    const machineA = await fakeMachined();
    const machineB = await fakeMachined();
    const { egressHub } = await import("../app.js");
    const hub = egressHub(app);
    hub.connectEndpoint("user-a", { host: "127.0.0.1", port: machineA.port, token: "a" });
    hub.connectEndpoint("user-b", { host: "127.0.0.1", port: machineB.port, token: "b" });
    const fromA = await withTimeout(machineA.opened, "机器 A 没有连上");
    const fromB = await withTimeout(machineB.opened, "机器 B 没有连上");
    const clientA = new WebSocket(`ws://127.0.0.1:${address.port}/client/egress`, { headers: { authorization: `Bearer ${deviceA.token}` } });
    const clientB = new WebSocket(`ws://127.0.0.1:${address.port}/client/egress`, { headers: { authorization: `Bearer ${deviceB.token}` } });
    cleanups.push(async () => {
      clientA.terminate();
      clientB.terminate();
    });
    await Promise.all([withTimeout(opened(clientA), "客户端 A 没有连上"), withTimeout(opened(clientB), "客户端 B 没有连上")]);
    await waitUntil(() => hub.machineConnected("user-a") && hub.machineConnected("user-b") && hub.deviceOnline("user-a", deviceA.deviceId) && hub.deviceOnline("user-b", deviceB.deviceId));
    const seenB: Buffer[] = [];
    clientB.on("message", (data) => {
      if (Buffer.isBuffer(data)) seenB.push(data);
      else if (Array.isArray(data)) seenB.push(Buffer.concat(data));
      else seenB.push(Buffer.from(data));
    });
    const seenA = withTimeout(waitMessage(clientA), "客户端没有收到转发帧");
    fromA.send(encodeEgressFrame({ type: "OPEN", streamId: 7, host: "1.1.1.1", port: 443 }));
    const frame = await seenA;
    expect(frame[0]).toBe(FRAME_OPEN);
    expect(frame.readUInt32BE(1)).not.toBe(7);
    const { promise: pause, resolve: resume } = Promise.withResolvers<void>();
    setTimeout(resume, 50);
    await pause;
    expect(seenB).toEqual([]);
    const closed = closedSoon(clientA);
    clientA.send(encodeEgressFrame({ type: "OPEN", streamId: 1, host: "1.1.1.1", port: 80 }));
    await closed;
    expect(fromB.bufferedAmount).toBeLessThan(1024);
    const closedB = closedSoon(clientB);
    const revoked = await app.inject({
      method: "POST",
      url: `/api/client/devices/${deviceB.deviceId}/revoke`,
      headers: { cookie: cookie(bob.token), "x-vb-csrf": bob.csrf, "content-type": "application/json" },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    await closedB;
    const clientA2 = new WebSocket(`ws://127.0.0.1:${address.port}/client/egress`, { headers: { authorization: `Bearer ${deviceA.token}` } });
    cleanups.push(async () => clientA2.terminate());
    await withTimeout(opened(clientA2), "停用前的客户端没有连上");
    const closedA2 = closedSoon(clientA2);
    userRepository(db).setStatus("user-a", "disabled");
    await closedA2;
    machineA.close();
    machineB.close();
  });

  it("does not queue frames once the outbound buffer is past the cap", () => {
    const machine = fakeSocket();
    const client = fakeSocket();
    const relay = attachRelay(machine, client, { openTimeoutMs: 50 });
    machine.emit("message", encodeEgressFrame({ type: "OPEN", streamId: 1, host: "1.1.1.1", port: 443 }), true);
    const opened = client.sent[0];
    if (!Buffer.isBuffer(opened)) throw new Error("OPEN 不是二进制帧");
    client.emit("message", encodeEgressFrame({ type: "OPEN_OK", streamId: opened.readUInt32BE(1) }), true);
    client.bufferedAmount = RELAY_BUFFER_CAP;
    const before = client.sent.length;
    machine.emit("message", encodeEgressFrame({ type: "DATA", streamId: 1, payload: Buffer.alloc(64 * 1024, 1) }), true);
    expect(client.sent.length).toBe(before);
    expect(relay.highWater).toBeLessThanOrEqual(RELAY_BUFFER_CAP);
    relay.close();
  });

  it("leaves waiting_egress in place across restart recovery", () => {
    const { db } = boot();
    const now = new Date().toISOString();
    db.$client.prepare("insert into bots (id, user_id, name, model, created_at, updated_at) values ('bot-a','user-a','A','m',?,?)").run(now, now);
    db.$client.prepare("insert into tasks (id, bot_id, state, trigger, started_at) values ('task-a','bot-a','waiting_egress','user',?)").run(now);
    expect(recoverInterruptedTasks(db)).toBe(0);
    const row = db.$client.prepare("select state from tasks where id='task-a'").get();
    if (!row || typeof row !== "object" || !("state" in row)) throw new Error("没有任务");
    expect(row.state).toBe("waiting_egress");
  });
});

function fakeSocket(): RelaySocket & { sent: Array<Buffer | string>; bufferedAmount: number; emit: (event: "message" | "close", data?: Buffer, isBinary?: boolean) => void } {
  const listeners = new Map<string, Array<(data?: Buffer, isBinary?: boolean) => void>>();
  const socket = {
    bufferedAmount: 0,
    readyState: 1,
    sent: [] as Array<Buffer | string>,
    send(data: Buffer | string) {
      this.sent.push(data);
    },
    terminate() {
      this.readyState = 3;
      this.emit("close");
    },
    on(event: "message" | "close", listener: (data?: Buffer, isBinary?: boolean) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    off(event: "message" | "close", listener: (data?: Buffer, isBinary?: boolean) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener));
    },
    emit(event: "message" | "close", data?: Buffer, isBinary?: boolean) {
      for (const listener of listeners.get(event) ?? []) listener(data, isBinary);
    },
  };
  return socket as RelaySocket & typeof socket;
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  const { promise: done, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(message)), 2000);
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return done;
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 2000) throw new Error("出口连接没有就绪");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

async function fakeMachined(): Promise<{ port: number; opened: Promise<WebSocket>; close: () => void }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  if (!wss.address()) {
    const { promise, resolve } = Promise.withResolvers<void>();
    wss.once("listening", () => resolve());
    await promise;
  }
  const bound = wss.address();
  if (!bound || typeof bound === "string") throw new Error("没有监听端口");
  const port = bound.port;
  const { promise: opened, resolve: onConnection } = Promise.withResolvers<WebSocket>();
  wss.once("connection", (socket) => onConnection(socket));
  cleanups.push(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    for (const client of wss.clients) client.terminate();
    wss.close(() => resolve());
    return promise;
  });
  return { port, opened, close: () => wss.close() };
}

function opened(socket: WebSocket): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.once("open", () => resolve());
  socket.once("error", reject);
  return promise;
}

function waitMessage(socket: WebSocket): Promise<Buffer> {
  const { promise, resolve } = Promise.withResolvers<Buffer>();
  socket.once("message", (data) => {
    if (Buffer.isBuffer(data)) resolve(data);
    else if (Array.isArray(data)) resolve(Buffer.concat(data));
    else resolve(Buffer.from(data));
  });
  return promise;
}

function closedSoon(socket: WebSocket): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => reject(new Error("连接没有断开")), 2000);
  socket.once("close", () => {
    clearTimeout(timer);
    resolve();
  });
  return promise;
}
