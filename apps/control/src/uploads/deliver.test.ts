import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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
import { streamUpload } from "../../../machined/src/fs-ops.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("attachment delivery", () => {
  it("streams the file onto the machine once and skips it on the next turn", async () => {
    const machine = await createMachine();
    const { app, alice, modelCalls } = await boot(machine.port);
    const botId = await createBot(app, alice);
    const upload = await uploadFile(app, alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(app, alice, botId, "\u770b\u4e00\u4e0b", [upload.id]);
    expect(sent.statusCode).toBe(202);
    const first = sent.json() as { taskId: string; messageId: string };
    const task = await waitTask(app, alice, first.taskId);
    expect(task.state).toBe("succeeded");
    expect(machine.uploads).toEqual([
      { path: `/home/bot/uploads/${first.messageId}/notes.txt`, body: "secret-bytes" },
    ]);
    expect(modelCalls()).toBeGreaterThan(0);
    const again = await send(app, alice, botId, "\u7ee7\u7eed", []);
    expect(again.statusCode).toBe(202);
    const second = await waitTask(app, alice, (again.json() as { taskId: string }).taskId);
    expect(second.state).toBe("succeeded");
    expect(machine.uploads).toHaveLength(1);
  });

  it("does not upload again when takeover resumes the same task after a control restart", async () => {
    const machine = await createMachine();
    const first = await boot(machine.port);
    const botId = await createBot(first.app, first.alice);
    const upload = await uploadFile(first.app, first.alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(first.app, first.alice, botId, "\u770b\u4e00\u4e0b", [upload.id]);
    const body = sent.json() as { taskId: string; messageId: string };
    expect((await waitTask(first.app, first.alice, body.taskId)).state).toBe("succeeded");
    const remote = `/home/bot/uploads/${body.messageId}/notes.txt`;
    expect(machine.uploads).toEqual([{ path: remote, body: "secret-bytes" }]);
    writeFileSync(join(first.dir, "uploads", "user-a", upload.id), "edited-after-delivery");
    // 停在助手正文上时，现有运行器拒绝 continue。删掉这轮助手正文，让同一任务走接管恢复再进入投递。
    first.db.$client.prepare("delete from messages where task_id=? and role='assistant'").run(body.taskId);
    first.db.$client.prepare("update tasks set state='waiting_takeover', ended_at=null, error=null where id=?").run(body.taskId);
    await first.close();
    const restarted = await boot(machine.port, first.dir);
    await chatService(restarted.app).idle();
    expect(restarted.db.$client.prepare("select state, error from tasks where id=?").get(body.taskId)).toEqual({ state: "succeeded", error: null });
    expect(machine.attempts).toEqual([{ path: remote, status: 200 }]);
    expect(machine.uploads).toEqual([{ path: remote, body: "secret-bytes" }]);
  });

  it("does not upload again when approval resumes the same task after a control restart", async () => {
    const machine = await createMachine();
    const first = await boot(machine.port);
    const botId = await createBot(first.app, first.alice);
    const upload = await uploadFile(first.app, first.alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(first.app, first.alice, botId, "\u770b\u4e00\u4e0b", [upload.id]);
    const body = sent.json() as { taskId: string; messageId: string };
    expect((await waitTask(first.app, first.alice, body.taskId)).state).toBe("succeeded");
    const remote = `/home/bot/uploads/${body.messageId}/notes.txt`;
    // 停在助手正文上时，现有运行器拒绝 continue。删掉这轮助手正文，让同一任务走审批恢复再进入投递。
    first.db.$client.prepare("delete from messages where task_id=? and role='assistant'").run(body.taskId);
    first.db.$client.prepare(
      "insert into approvals (id, task_id, tool, summary, args_json, state) values (?, ?, 'shell_exec', 'run', '{}', 'pending')",
    ).run(`approval-${body.taskId}`, body.taskId);
    first.db.$client.prepare("update tasks set state='waiting_approval', ended_at=null, error=null where id=?").run(body.taskId);
    await first.close();
    const restarted = await boot(machine.port, first.dir);
    await chatService(restarted.app).idle();
    expect(restarted.db.$client.prepare("select state, error from tasks where id=?").get(body.taskId)).toEqual({ state: "succeeded", error: null });
    expect(machine.attempts).toEqual([{ path: remote, status: 200 }]);
    expect(machine.uploads).toEqual([{ path: remote, body: "secret-bytes" }]);
  });

  it("retries only the attachment that failed when the same task is resumed", async () => {
    const gate = { reject: (path: string) => path.endsWith("/data.bin") };
    const machine = await createMachine({ reject: (path) => gate.reject(path) });
    const first = await boot(machine.port);
    const botId = await createBot(first.app, first.alice);
    const notes = await uploadFile(first.app, first.alice, "notes.txt", Buffer.from("secret-bytes"));
    const data = await uploadFile(first.app, first.alice, "data.bin", Buffer.from("more-bytes"));
    const sent = await send(first.app, first.alice, botId, "\u770b\u4e00\u4e0b", [notes.id, data.id]);
    const taskId = (sent.json() as { taskId: string }).taskId;
    const failed = await waitTask(first.app, first.alice, taskId);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/data\.bin/);
    const notesPath = machine.uploads[0]?.path ?? "";
    expect(notesPath.endsWith("/notes.txt")).toBe(true);
    expect(machine.uploads).toEqual([{ path: notesPath, body: "secret-bytes" }]);
    expect(machine.attempts.map((item) => item.status)).toEqual([200, 500]);
    gate.reject = () => false;
    first.db.$client.prepare("update tasks set state='queued', ended_at=null, error=null where id=?").run(taskId);
    await first.close();
    const restarted = await boot(machine.port, first.dir);
    await chatService(restarted.app).idle();
    expect(restarted.db.$client.prepare("select state from tasks where id=?").get(taskId)).toEqual({ state: "succeeded" });
    expect(machine.uploads).toEqual([
      { path: notesPath, body: "secret-bytes" },
      { path: notesPath.replace(/notes\.txt$/, "data.bin"), body: "more-bytes" },
    ]);
    expect(machine.attempts.filter((item) => item.path.endsWith("/notes.txt"))).toHaveLength(1);
  });

  it("fails the task with a visible reason and does not call the model", async () => {
    const machine = await createMachine({ fail: true });
    const { app, alice, modelCalls } = await boot(machine.port);
    const botId = await createBot(app, alice);
    const upload = await uploadFile(app, alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(app, alice, botId, "\u770b\u4e00\u4e0b", [upload.id]);
    const task = await waitTask(app, alice, (sent.json() as { taskId: string }).taskId);
    expect(task.state).toBe("failed");
    expect(task.error).toMatch(/notes\.txt/);
    expect(modelCalls()).toBe(0);
  });

  it("sends an attachment without text and tells the model the path", async () => {
    const bodies: string[] = [];
    const machine = await createMachine();
    const { app, alice } = await boot(machine.port, undefined, { onModel: async (body) => { bodies.push(body); } });
    const botId = await createBot(app, alice);
    const upload = await uploadFile(app, alice, "notes.txt", Buffer.from("secret-bytes"));
    const blank = await send(app, alice, botId, "   ", []);
    expect(blank.statusCode).toBe(400);
    const sent = await send(app, alice, botId, "   ", [upload.id]);
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as { taskId: string; messageId: string; conversationId: string };
    expect((await waitTask(app, alice, body.taskId)).state).toBe("succeeded");
    expect(machine.uploads).toEqual([{ path: `/home/bot/uploads/${body.messageId}/notes.txt`, body: "secret-bytes" }]);
    expect(bodies[0]).toContain(`/home/bot/uploads/${body.messageId}/notes.txt`);
    const listed = await app.inject({
      method: "GET",
      url: `/api/conversations/${body.conversationId}/messages`,
      headers: { cookie: cookie(alice.token) },
    });
    const user = (listed.json().messages as Array<{ id: string; text: string }>).find((item) => item.id === body.messageId);
    expect(user?.text).toBe("");
  });

  it("delivers a follow-up attachment into the same task and the next model call", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bodies: string[] = [];
    const machine = await createMachine();
    const { app, alice, db } = await boot(machine.port, undefined, {
      onModel: async (body) => {
        bodies.push(body);
        if (bodies.length === 1) await held;
      },
    });
    const botId = await createBot(app, alice);
    const first = await uploadFile(app, alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(app, alice, botId, "\u770b\u4e00\u4e0b", [first.id]);
    const opened = sent.json() as { taskId: string; messageId: string };
    await waitFor(() => bodies.length === 1);
    const extra = await uploadFile(app, alice, "extra.txt", Buffer.from("extra-bytes"));
    const more = await send(app, alice, botId, "\u8865\u5145", [extra.id]);
    expect(more.statusCode).toBe(202);
    const followed = more.json() as { taskId: string; messageId: string };
    expect(followed.taskId).toBe(opened.taskId);
    release();
    expect((await waitTask(app, alice, opened.taskId)).state).toBe("succeeded");
    const extraPath = remotePath(db, followed.messageId, "extra.txt");
    expect(machine.uploads).toEqual([
      { path: `/home/bot/uploads/${opened.messageId}/notes.txt`, body: "secret-bytes" },
      { path: extraPath, body: "extra-bytes" },
    ]);
    expect(bodies[0]).not.toContain("extra.txt");
    expect(bodies.at(-1)).toContain(extraPath);
  });

  it("includes an attachment that arrives after the transcript snapshot and before the agent starts", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let skillsEntered = (): void => {};
    const skillsSeen = new Promise<void>((resolve) => {
      skillsEntered = resolve;
    });
    const bodies: string[] = [];
    const machine = await createMachine({
      onSkills: async () => {
        skillsEntered();
        await held;
      },
    });
    const { app, alice } = await boot(machine.port, undefined, { onModel: async (body) => { bodies.push(body); } });
    const botId = await createBot(app, alice);
    const first = await uploadFile(app, alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(app, alice, botId, "\u770b\u4e00\u4e0b", [first.id]);
    const opened = sent.json() as { taskId: string; messageId: string };
    await skillsSeen;
    const extra = await uploadFile(app, alice, "extra.txt", Buffer.from("extra-bytes"));
    const more = await send(app, alice, botId, "\u8865\u5145", [extra.id]);
    expect(more.statusCode).toBe(202);
    const followed = more.json() as { taskId: string; messageId: string };
    expect(followed.taskId).toBe(opened.taskId);
    release();
    expect((await waitTask(app, alice, opened.taskId)).state).toBe("succeeded");
    expect(machine.uploads).toEqual([
      { path: `/home/bot/uploads/${opened.messageId}/notes.txt`, body: "secret-bytes" },
      { path: `/home/bot/uploads/${followed.messageId}/extra.txt`, body: "extra-bytes" },
    ]);
    expect(bodies[0]).toContain(`/home/bot/uploads/${followed.messageId}/extra.txt`);
  });

  it("B1 does not overwrite a remote edit when the first delivery response is lost", async () => {
    const root = mkdtempSync(join("/tmp", "vb-b1-lost-"));
    dirs.push(root);
    const machine = await createFsMachine(root, { dropFirstSuccess: true });
    const first = await boot(machine.port);
    const botId = await createBot(first.app, first.alice);
    const upload = await uploadFile(first.app, first.alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(first.app, first.alice, botId, "看一下", [upload.id]);
    const body = sent.json() as { taskId: string; messageId: string };
    expect((await waitTask(first.app, first.alice, body.taskId)).state).toBe("failed");
    const remote = machine.file(body.messageId, "notes.txt");
    expect(readFileSync(remote, "utf8")).toBe("secret-bytes");
    expect(first.db.$client.prepare("select delivered_at from uploads where id=?").get(upload.id)).toEqual({ delivered_at: null });
    writeFileSync(remote, "user-rewrote");
    const edited = statSync(remote);
    first.db.$client.prepare("update tasks set state='queued', ended_at=null, error=null where id=?").run(body.taskId);
    await first.close();
    const restarted = await boot(machine.port, first.dir);
    await chatService(restarted.app).idle();
    expect(restarted.db.$client.prepare("select state, error from tasks where id=?").get(body.taskId)).toEqual({ state: "succeeded", error: null });
    expect(readFileSync(remote, "utf8")).toBe("user-rewrote");
    expect(statSync(remote).ino).toBe(edited.ino);
    expect(machine.attempts.map((item) => item.delivery)).toEqual([`${upload.id}_${body.messageId}`, `${upload.id}_${body.messageId}`]);
    const marked = restarted.db.$client.prepare("select delivered_at from uploads where id=?").get(upload.id) as { delivered_at: string | null };
    expect(marked.delivered_at).not.toBeNull();
  });

  it("B1 retries the unfinished attachment without overwriting an edited delivery", async () => {
    const root = mkdtempSync(join("/tmp", "vb-b1-part-"));
    dirs.push(root);
    const gate = { partial: true };
    const machine = await createFsMachine(root, {
      partial: (requested) => gate.partial && requested.endsWith("/data.bin"),
    });
    const first = await boot(machine.port);
    const botId = await createBot(first.app, first.alice);
    const notes = await uploadFile(first.app, first.alice, "notes.txt", Buffer.from("secret-bytes"));
    const data = await uploadFile(first.app, first.alice, "data.bin", Buffer.from("more-bytes"));
    const sent = await send(first.app, first.alice, botId, "看一下", [notes.id, data.id]);
    const body = sent.json() as { taskId: string; messageId: string };
    const failed = await waitTask(first.app, first.alice, body.taskId);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/data\.bin/);
    const notesPath = machine.file(body.messageId, "notes.txt");
    const dataPath = machine.file(body.messageId, "data.bin");
    expect(readFileSync(notesPath, "utf8")).toBe("secret-bytes");
    expect(existsSync(dataPath)).toBe(false);
    const book = join(notesPath, "..", ".vb-deliveries");
    if (existsSync(book)) expect(readdirSync(book).filter((name) => name.endsWith(".part"))).toEqual([]);
    expect(first.db.$client.prepare("select delivered_at from uploads where id=?").get(notes.id)).toMatchObject({ delivered_at: expect.any(String) });
    expect(first.db.$client.prepare("select delivered_at from uploads where id=?").get(data.id)).toEqual({ delivered_at: null });
    first.db.$client.prepare("update uploads set delivered_at=null where id=?").run(notes.id);
    writeFileSync(notesPath, "user-rewrote");
    const edited = statSync(notesPath);
    gate.partial = false;
    first.db.$client.prepare("update tasks set state='queued', ended_at=null, error=null where id=?").run(body.taskId);
    await first.close();
    const restarted = await boot(machine.port, first.dir);
    await chatService(restarted.app).idle();
    expect(restarted.db.$client.prepare("select state from tasks where id=?").get(body.taskId)).toEqual({ state: "succeeded" });
    expect(readFileSync(notesPath, "utf8")).toBe("user-rewrote");
    expect(statSync(notesPath).ino).toBe(edited.ino);
    expect(readFileSync(dataPath, "utf8")).toBe("more-bytes");
    expect(machine.attempts.map((item) => item.delivery)).toEqual([
      `${notes.id}_${body.messageId}`,
      `${data.id}_${body.messageId}`,
      `${notes.id}_${body.messageId}`,
      `${data.id}_${body.messageId}`,
    ]);
    const notesMark = restarted.db.$client.prepare("select delivered_at from uploads where id=?").get(notes.id) as { delivered_at: string | null };
    const dataMark = restarted.db.$client.prepare("select delivered_at from uploads where id=?").get(data.id) as { delivered_at: string | null };
    expect(notesMark.delivered_at).not.toBeNull();
    expect(dataMark.delivered_at).not.toBeNull();
  });
});

function remotePath(db: { $client: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } }, messageId: string, name: string): string {
  const row = db.$client.prepare("select content_json as contentJson from messages where id=?").get(messageId);
  let directory = messageId;
  if (typeof row === "object" && row !== null && "contentJson" in row && typeof row.contentJson === "string") {
    const parsed = JSON.parse(row.contentJson) as { attachments?: Array<{ name?: string; place?: string }> };
    const place = parsed.attachments?.find((item) => item.name === name)?.place;
    if (place) directory = place;
  }
  return `/home/bot/uploads/${directory}/${name}`;
}

async function createMachine(options: { fail?: boolean; reject?: (path: string) => boolean; onSkills?: () => Promise<void> } = {}): Promise<{ port: number; uploads: Array<{ path: string; body: string }>; attempts: Array<{ path: string; status: number }> }> {
  const uploads: Array<{ path: string; body: string }> = [];
  const attempts: Array<{ path: string; status: number }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/skills" && options.onSkills) {
      void options.onSkills().then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skills: [] }));
      }, () => {
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/fs/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const path = url.searchParams.get("path") ?? "";
        const body = Buffer.concat(chunks).toString("utf8");
        const rejected = options.fail === true || options.reject?.(path) === true;
        attempts.push({ path, status: rejected ? 500 : 200 });
        if (!rejected) uploads.push({ path, body });
        if (rejected) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "disk full" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path, bytes: body.length, sha256: "abc" }));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/skills") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ skills: [] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const port = await listenAsync((req, res) => server.emit("request", req, res));
  return { port, uploads, attempts };
}

async function createFsMachine(
  root: string,
  options: { dropFirstSuccess?: boolean; partial?: (requested: string) => boolean } = {},
): Promise<{ port: number; attempts: Array<{ path: string; delivery: string; status: number }>; file: (messageId: string, name: string) => string }> {
  const attempts: Array<{ path: string; delivery: string; status: number }> = [];
  let drop = options.dropFirstSuccess === true;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/skills") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ skills: [] }));
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/fs/upload") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const requested = url.searchParams.get("path") ?? "";
        const delivery = url.searchParams.get("delivery") ?? "";
        const local = mapDeliveryPath(root, requested);
        try {
          const source = options.partial?.(requested) ? failingUpload() : Readable.from(Buffer.concat(chunks));
          await streamUpload(local, source, 25 * 1024 * 1024, delivery || "missing-delivery");
          const dropped = drop;
          if (drop) drop = false;
          attempts.push({ path: requested, delivery, status: 200 });
          if (dropped) {
            res.destroy();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: requested, bytes: Buffer.concat(chunks).length, sha256: "receipt" }));
        } catch (error) {
          const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
          attempts.push({ path: requested, delivery, status });
          if (!res.destroyed && !res.headersSent) {
            const message = error instanceof Error ? error.message : "upload failed";
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: message }));
          }
        }
      })().catch((error: unknown) => {
        if (!res.destroyed && !res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "upload failed" }));
        }
      });
    });
  });
  const port = await listenAsync((req, res) => server.emit("request", req, res));
  return {
    port,
    attempts,
    file: (messageId, name) => join(root, "home", "bot", "uploads", messageId, name),
  };
}

function mapDeliveryPath(root: string, requested: string): string {
  const prefix = "/home/bot/uploads/";
  if (!requested.startsWith(prefix) || requested.includes("\0") || requested.split("/").includes("..")) {
    throw Object.assign(new Error("路径无效"), { statusCode: 400 });
  }
  return join(root, "home", "bot", "uploads", requested.slice(prefix.length));
}

function failingUpload(): Readable {
  return Readable.from(
    (async function* () {
      yield Buffer.from("partial-bytes");
      throw new Error("disk full");
    })(),
  );
}

async function boot(machinePort: number, existingDir?: string, hooks?: { onModel?: (body: string) => Promise<void> }) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "vb-deliver-"));
  if (!existingDir) dirs.push(dir);
  let calls = 0;
  const modelPort = await listenAsync(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    await hooks?.onModel?.(Buffer.concat(chunks).toString("utf8"));
    calls += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
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
  const app = buildApp(ctx, {
    ensureMachine: async () => {},
    prepareEndpoint: async (_userId, onPhase) => {
      onPhase("ready");
      return { host: "127.0.0.1", port: machinePort, token: "t" };
    },
  });
  await app.ready();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await chatService(app).idle();
    await app.close();
    ctx.db.$client.close();
  };
  closers.push(close);
  const now = new Date();
  return { app, alice: createSession(ctx.db, ctx.key, "user-a", "refresh-a", now), modelCalls: () => calls, dir, db: ctx.db, close };
}

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

async function listenAsync(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
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

async function waitFor(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 5_000) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitTask(
  app: FastifyInstance,
  session: { token: string },
  taskId: string,
): Promise<{ state: string; error: string | null }> {
  await chatService(app).idle();
  const response = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}`,
    headers: { cookie: cookie(session.token) },
  });
  const task = response.json().task as { state: string; error: string | null };
  if (task.state === "succeeded" || task.state === "failed" || task.state === "cancelled") return task;
  throw new Error("task did not finish");
}
