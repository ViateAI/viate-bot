import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Database } from "better-sqlite3";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { ensureDevUser } from "../db/users.js";
import { createSession } from "../session.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("message attachments", () => {
  it("stores attachment refs on the user message and rejects a second reference", async () => {
    const { app, alice, bob } = await boot();
    const botId = await createBot(app, alice);
    const upload = await uploadFile(app, alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(app, alice, botId, "\u770b\u4e00\u4e0b", [upload.id]);
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as { conversationId: string; messageId: string };
    const listed = await app.inject({
      method: "GET",
      url: `/api/conversations/${body.conversationId}/messages`,
      headers: { cookie: cookie(alice.token) },
    });
    const user = (listed.json().messages as Array<{ id: string; role: string; text: string; attachments?: unknown }>).find(
      (message) => message.id === body.messageId,
    );
    expect(user?.text).toBe("\u770b\u4e00\u4e0b");
    expect(user?.attachments).toEqual([
      { id: upload.id, name: "notes.txt", size: 12, mime: "application/octet-stream", kind: "file" },
    ]);
    expect(JSON.stringify(user)).not.toContain("secret-bytes");
    const again = await send(app, alice, botId, "\u518d\u770b\u4e00\u6b21", [upload.id]);
    expect(again.statusCode).toBe(409);
    const foreign = await send(app, bob, await createBot(app, bob), "\u5077\u7528", [upload.id]);
    expect(foreign.statusCode).toBe(404);
  });

  it("rejects more than 10 attachments or more than 100 MB", async () => {
    const { app, alice, db } = await boot();
    const botId = await createBot(app, alice);
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) ids.push((await uploadFile(app, alice, `f${index}.txt`, Buffer.from("x"))).id);
    const tooMany = await send(app, alice, botId, "\u592a\u591a", ids);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toMatch(/10/);
    const pair = ids.slice(0, 2);
    db.prepare("update uploads set size=? where id=?").run(60 * 1024 * 1024, pair[0]);
    db.prepare("update uploads set size=? where id=?").run(60 * 1024 * 1024, pair[1]);
    const tooBig = await send(app, alice, botId, "\u592a\u5927", pair);
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error).toMatch(/100 MB/);
    const one = await send(app, alice, botId, "\u4e00\u4e2a\u5c31\u591f", [ids[2]!]);
    expect(one.statusCode).toBe(202);
  });

  it("deletes the upload copy when the conversation is deleted", async () => {
    const { app, alice, bob, db, dir } = await boot();
    const botId = await createBot(app, alice);
    const upload = await uploadFile(app, alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(app, alice, botId, "\u770b\u4e00\u4e0b", [upload.id]);
    const messageId = (sent.json() as { messageId: string }).messageId;
    await chatService(app).idle();
    const listed = await app.inject({
      method: "GET",
      url: `/api/bots/${botId}/conversations`,
      headers: { cookie: cookie(alice.token) },
    });
    const conversationId = (listed.json() as { conversations: Array<{ id: string }> }).conversations[0]?.id;
    const file = join(dir, "uploads", "user-a", upload.id);
    expect(existsSync(file)).toBe(true);
    const foreign = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: cookie(bob.token), "x-vb-csrf": bob.csrf },
    });
    expect(foreign.statusCode).toBe(404);
    expect(existsSync(file)).toBe(true);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf },
    });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect(db.prepare("select count(*) as n from uploads where id=?").get(upload.id)).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from messages where id=?").get(messageId)).toEqual({ n: 0 });
    const gone = await app.inject({
      method: "GET",
      url: `/api/uploads/${upload.id}`,
      headers: { cookie: cookie(alice.token) },
    });
    expect(gone.statusCode).toBe(404);
  });

  it("B4 rejects delete while any task is non-terminal and leaves rows and bytes unchanged", async () => {
    const { app, alice, bob, db, dir } = await boot();
    const botId = await createBot(app, alice);
    const upload = await uploadFile(app, alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(app, alice, botId, "look", [upload.id]);
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as { conversationId: string; messageId: string; taskId: string };
    await chatService(app).idle();
    const file = join(dir, "uploads", "user-a", upload.id);
    const bytes = readFileSync(file);
    db.prepare(
      "insert into approvals (id, task_id, tool, summary, args_json, state) values ('b4-approval', ?, 'shell', 'run', '{}', 'pending')",
    ).run(body.taskId);
    db.prepare(
      "insert into takeover_leases (id, bot_id, user_id, task_id, state, created_at, updated_at) values ('b4-lease', ?, 'user-a', ?, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run(botId, body.taskId);

    for (const state of ["queued", "running", "waiting_approval", "waiting_takeover", "waiting_input", "stopping"]) {
      db.prepare("update tasks set state=? where id=?").run(state, body.taskId);
      const before = snapshot(db, body.conversationId);
      const removed = await deleteConversation(app, alice, body.conversationId);
      expect(removed.statusCode, state).toBe(409);
      expect(removed.json().error).toBe("\u5bf9\u8bdd\u8fd8\u6709\u672a\u7ed3\u675f\u7684\u4efb\u52a1");
      expect(snapshot(db, body.conversationId)).toEqual(before);
      expect(readFileSync(file)).toEqual(bytes);
    }

    db.prepare("update tasks set state='queued' where id=?").run(body.taskId);
    const beforeForeign = snapshot(db, body.conversationId);
    const foreign = await deleteConversation(app, bob, body.conversationId);
    expect(foreign.statusCode).toBe(404);
    expect(snapshot(db, body.conversationId)).toEqual(beforeForeign);
    expect(readFileSync(file)).toEqual(bytes);

    db.prepare(
      "insert into tasks (id, bot_id, conversation_id, state, trigger, step_count) values ('b4-extra', ?, ?, 'queued', 'user', 0)",
    ).run(botId, body.conversationId);
    db.prepare("update tasks set state='succeeded' where id=?").run(body.taskId);
    const beforeMixed = snapshot(db, body.conversationId);
    const mixed = await deleteConversation(app, alice, body.conversationId);
    expect(mixed.statusCode).toBe(409);
    expect(snapshot(db, body.conversationId)).toEqual(beforeMixed);
    expect(readFileSync(file)).toEqual(bytes);

    db.prepare("update tasks set state='succeeded' where conversation_id=?").run(body.conversationId);
    const removed = await deleteConversation(app, alice, body.conversationId);
    expect(removed.statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect(db.prepare("select count(*) as n from tasks where conversation_id=?").get(body.conversationId)).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from approvals where id='b4-approval'").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from takeover_leases where id='b4-lease'").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from messages where id=?").get(body.messageId)).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from uploads where id=?").get(upload.id)).toEqual({ n: 0 });
  });

  it("B4 does not abort a live running task when delete is rejected", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, alice, db } = await boot({ hold });
    try {
      const botId = await createBot(app, alice);
      const sent = await send(app, alice, botId, "hold", []);
      expect(sent.statusCode).toBe(202);
      const body = sent.json() as { conversationId: string; taskId: string };
      await waitFor(() => taskState(db, body.taskId) === "running");
      const before = snapshot(db, body.conversationId);
      const removed = await deleteConversation(app, alice, body.conversationId);
      expect(removed.statusCode).toBe(409);
      expect(removed.json().error).toBe("\u5bf9\u8bdd\u8fd8\u6709\u672a\u7ed3\u675f\u7684\u4efb\u52a1");
      expect(snapshot(db, body.conversationId)).toEqual(before);
      expect(taskState(db, body.taskId)).toBe("running");
      release();
      await chatService(app).idle();
      expect(taskState(db, body.taskId)).toBe("succeeded");
    } finally {
      release();
    }
  });

  it("B4 still deletes conversations whose tasks are failed, cancelled, or interrupted", async () => {
    const { app, alice, bob, db, dir } = await boot();
    const botId = await createBot(app, alice);
    for (const state of ["failed", "cancelled", "interrupted"] as const) {
      const upload = await uploadFile(app, alice, `${state}.txt`, Buffer.from(state));
      const sent = await send(app, alice, botId, state, [upload.id]);
      expect(sent.statusCode).toBe(202);
      const body = sent.json() as { conversationId: string; messageId: string };
      await chatService(app).idle();
      db.prepare("update tasks set state=? where conversation_id=?").run(state, body.conversationId);
      const file = join(dir, "uploads", "user-a", upload.id);
      expect(existsSync(file)).toBe(true);
      if (state === "failed") {
        const foreign = await deleteConversation(app, bob, body.conversationId);
        expect(foreign.statusCode).toBe(404);
        expect(existsSync(file)).toBe(true);
      }
      const removed = await deleteConversation(app, alice, body.conversationId);
      expect(removed.statusCode, state).toBe(200);
      expect(existsSync(file)).toBe(false);
      expect(db.prepare("select count(*) as n from messages where id=?").get(body.messageId)).toEqual({ n: 0 });
    }
  });

  it("rejects an explicit bad attachment without a message or task, and still accepts text or a ready file", async () => {
    const { app, alice, bob, db, dir } = await boot();
    const botId = await createBot(app, alice);
    const missing = await send(app, alice, botId, "无效附件", ["missing-upload"]);
    expect(missing.statusCode).toBe(404);
    const foreign = await uploadFile(app, bob, "secret.txt", Buffer.from("nope"));
    const stolen = await send(app, alice, botId, "别人的附件", [foreign.id]);
    expect(stolen.statusCode).toBe(404);
    const unready = await uploadFile(app, alice, "partial.txt", Buffer.from("later"));
    rmSync(join(dir, "uploads", "user-a", unready.id));
    const early = await send(app, alice, botId, "还没好", [unready.id]);
    expect(early.statusCode).toBe(409);
    expect(String((early.json() as { error?: string }).error ?? "")).toMatch(/还没准备好/);
    const good = await uploadFile(app, alice, "ready.txt", Buffer.from("yes"));
    const mixed = await send(app, alice, botId, "混合附件", [good.id, unready.id]);
    expect(mixed.statusCode).toBe(409);
    expect(db.prepare("select message_id as messageId from uploads where id=?").get(good.id)).toEqual({ messageId: null });
    expect(db.prepare("select message_id as messageId from uploads where id=?").get(unready.id)).toEqual({ messageId: null });
    expect(db.prepare("select message_id as messageId from uploads where id=?").get(foreign.id)).toEqual({ messageId: null });
    expect(db.prepare("select count(*) as n from messages").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from tasks").get()).toEqual({ n: 0 });
    const text = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf, "content-type": "application/json" },
      payload: { text: "只有文字" },
    });
    expect(text.statusCode).toBe(202);
    const emptyIds = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf, "content-type": "application/json" },
      payload: { text: "空数组", uploadIds: [] },
    });
    expect(emptyIds.statusCode).toBe(202);
    await chatService(app).idle();
    const pure = await send(app, alice, botId, "   ", [good.id]);
    expect(pure.statusCode).toBe(202);
    const pureBody = pure.json() as { messageId: string };
    expect(db.prepare("select message_id as messageId from uploads where id=?").get(good.id)).toEqual({ messageId: pureBody.messageId });
    expect(db.prepare("select count(*) as n from messages where content_json like '%只有文字%'").get()).toEqual({ n: 1 });
    expect(db.prepare("select count(*) as n from messages where content_json like '%无效附件%' or content_json like '%别人的附件%' or content_json like '%还没好%' or content_json like '%混合附件%'").get()).toEqual({ n: 0 });
  });
});

async function boot(options?: { hold?: Promise<void> }) {
  const dir = mkdtempSync(join(tmpdir(), "vb-attach-"));
  dirs.push(dir);
  const modelPort = await listen(async (_req, res) => {
    if (options?.hold) await options.hold;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "\u597d" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
    VB_MODEL_API_KEY: "test-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
  });
  const ctx = contextFor(config);
  ensureDevUser(ctx.db, "user-a");
  ensureDevUser(ctx.db, "user-b");
  const app = buildApp(ctx, {
    ensureMachine: async () => {},
    prepareEndpoint: async (_userId, onPhase) => {
      onPhase("ready");
      return { host: "127.0.0.1", port: 9, token: "t" };
    },
  });
  await app.ready();
  closers.push(async () => {
    await chatService(app).idle();
    await app.close();
    ctx.db.$client.close();
  });
  const now = new Date();
  return {
    app,
    db: ctx.db.$client,
    dir,
    alice: createSession(ctx.db, ctx.key, "user-a", "refresh-a", now),
    bob: createSession(ctx.db, ctx.key, "user-b", "refresh-b", now),
  };
}

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  closers.push(() => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  return (server.address() as AddressInfo).port;
}

function cookie(token: string): string {
  return `vb_session=${token}`;
}

async function createBot(app: FastifyInstance, session: { token: string; csrf: string }): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/bots",
    headers: { cookie: cookie(session.token), "x-vb-csrf": session.csrf, "content-type": "application/json" },
    payload: { name: "Ada", model: "gpt-test", instructions: "" },
  });
  expect(created.statusCode).toBe(201);
  return created.json().bot.id as string;
}

async function uploadFile(
  app: FastifyInstance,
  session: { token: string; csrf: string },
  filename: string,
  content: Buffer,
): Promise<{ id: string }> {
  const boundary = "vbupload";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: {
      cookie: cookie(session.token),
      "x-vb-csrf": session.csrf,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  expect(created.statusCode).toBe(201);
  return created.json().upload as { id: string };
}

function send(
  app: FastifyInstance,
  session: { token: string; csrf: string },
  botId: string,
  text: string,
  uploadIds: string[],
) {
  return app.inject({
    method: "POST",
    url: `/api/bots/${botId}/messages`,
    headers: { cookie: cookie(session.token), "x-vb-csrf": session.csrf, "content-type": "application/json" },
    payload: { text, uploadIds },
  });
}

function deleteConversation(app: FastifyInstance, session: { token: string; csrf: string }, conversationId: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/conversations/${conversationId}`,
    headers: { cookie: cookie(session.token), "x-vb-csrf": session.csrf },
  });
}

function snapshot(db: Database, conversationId: string) {
  const all = (sql: string) => db.prepare(sql).all(conversationId);
  return {
    conversation: all("select * from conversations where id=?"),
    tasks: all("select * from tasks where conversation_id=? order by id"),
    messages: all("select * from messages where conversation_id=? order by id"),
    steps: all("select * from task_steps where task_id in (select id from tasks where conversation_id=?) order by id"),
    approvals: all("select * from approvals where task_id in (select id from tasks where conversation_id=?) order by id"),
    leases: all("select * from takeover_leases where task_id in (select id from tasks where conversation_id=?) order by id"),
    uploads: all("select * from uploads where message_id in (select id from messages where conversation_id=?) order by id"),
  };
}

function taskState(db: Database, taskId: string): string | undefined {
  return (db.prepare("select state from tasks where id=?").get(taskId) as { state: string } | undefined)?.state;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("\u7b49\u5f85\u8d85\u65f6");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
