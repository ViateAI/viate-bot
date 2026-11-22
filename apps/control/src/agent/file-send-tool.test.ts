import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { loadConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { chatRepository } from "../db/chat.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { settingsRepository } from "../db/settings.js";
import { ensureDevUser } from "../db/users.js";
import { ulid } from "../id.js";
import { userScope, type UserScope } from "../scope.js";
import { createSession } from "../session.js";
import { localUploadStorage, type UploadStorage } from "../uploads/storage.js";
import { approvalClass, READ_ONLY_TOOLS } from "../m2/risk.js";
import { createSendFileTool } from "./file-send-tool.js";
import { redactMessages, toolLabel } from "./process-detail.js";
import { loadTranscriptEntries, messageView, storedContent } from "./view.js";
import type { TaskView } from "./view.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0x02, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const GIF = Buffer.from("GIF89a");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("send_file", () => {
  it("is read-only so it skips approval", () => {
    expect(READ_ONLY_TOOLS.send_file).toBe(true);
    expect(approvalClass("send_file")).toBeUndefined();
    expect(toolLabel("send_file")).toBe("正在发送文件");
  });

  it("sends an image or a file, masks the caption, and keeps the model transcript paired", async () => {
    const fx = fixture();
    const published: string[] = [];
    const calls: Array<{ path: string; maxBytes: number; confine?: boolean; policy?: { allow: string[]; deny: string[] } }> = [];
    const bodies = new Map<string, Buffer>([
      ["/tmp/dot.png", PNG],
      ["/tmp/dot.jpg", JPEG],
      ["/tmp/dot.gif", GIF],
      ["/tmp/dot.webp", WEBP],
      ["/tmp/notes.bin", Buffer.from("hello")],
    ]);
    const tool = createSendFileTool({
      ...fx.binding,
      knownSecrets: () => [{ name: "API", value: "sk-live-secret-value" }],
      publish: (messageId) => published.push(messageId),
      files: {
        download: async (path, maxBytes, _signal, confine, policy) => {
          const call: (typeof calls)[number] = { path, maxBytes };
          if (confine !== undefined) call.confine = confine;
          if (policy !== undefined) call.policy = policy;
          calls.push(call);
          const body = bodies.get(path);
          if (!body) throw new Error("文件不存在");
          return Readable.from([body]);
        },
      },
    });
    const chat = chatRepository(fx.db);
    const user = chat.insertMessage(fx.scope, {
      id: ulid(),
      conversationId: fx.conversationId,
      role: "user",
      contentJson: storedContent({ role: "user", content: "发过来", timestamp: 1 }, "发过来"),
      taskId: fx.taskId,
    });
    const assistant = toolCallMessage("send_file", "call-send", { path: "/tmp/dot.png" });
    const assistantRow = chat.insertMessage(fx.scope, {
      id: ulid(),
      conversationId: fx.conversationId,
      role: "assistant",
      contentJson: storedContent(assistant, ""),
      taskId: fx.taskId,
    });
    const image = await tool.execute("call-send", { path: "/tmp/dot.png", caption: "密钥 sk-live-secret-value" });
    expect(calls[0]).toMatchObject({
      path: "/tmp/dot.png",
      maxBytes: 25 * 1024 * 1024,
      confine: true,
      policy: { allow: ["/tmp/work"], deny: ["/tmp/work/secret"] },
    });
    expect(image.details).toMatchObject({ kind: "image", mime: "image/png", name: "dot.png" });
    expect(textOf(image)).toMatch(/^已发送图片：dot\.png（\d+ B，image\/png）$/);
    expect(published).toHaveLength(1);

    const samples = [
      ["/tmp/dot.jpg", "image", "image/jpeg"],
      ["/tmp/dot.gif", "image", "image/gif"],
      ["/tmp/dot.webp", "image", "image/webp"],
      ["/tmp/notes.bin", "file", "application/octet-stream"],
    ] as const;
    for (const [path, kind, mime] of samples) {
      const result = await tool.execute("call", { path, filename: path.split("/").at(-1) });
      expect(result.details).toMatchObject({ kind, mime });
    }

    const rows = chat.listMessages(fx.scope, fx.conversationId) ?? [];
    const fileRow = rows.find((row) => row.id === published[0]);
    if (!fileRow || !user || !assistantRow) throw new Error("missing rows");
    expect(fileRow.role).toBe("assistant");
    expect(fileRow.taskId).toBe(fx.taskId);
    const stored = JSON.parse(fileRow.contentJson) as { pi?: unknown; text?: string; delivery?: string; attachments?: Array<{ kind: string }> };
    expect(stored.pi).toBeUndefined();
    expect(stored.delivery).toBe("file");
    expect(stored.text).toBe("密钥 {{secret:API}}");
    expect(stored.text).not.toContain("sk-live-secret-value");
    const view = messageView(fileRow);
    expect(view.text).toBe("密钥 {{secret:API}}");
    expect(view.attachments?.[0]).toMatchObject({ kind: "image", mime: "image/png", name: "dot.png" });
    expect(view.toolCalls).toBeUndefined();

    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-send",
      toolName: "send_file",
      content: [{ type: "text", text: textOf(image) }],
      isError: false,
      timestamp: 3,
    };
    const resultRow = chat.insertMessage(fx.scope, {
      id: ulid(),
      conversationId: fx.conversationId,
      role: "toolResult",
      contentJson: storedContent(toolResult, textOf(image)),
      taskId: fx.taskId,
    });
    if (!resultRow) throw new Error("missing tool result");
    const ordered = chat.listMessages(fx.scope, fx.conversationId) ?? [];
    const ids = ordered.map((row) => row.id);
    expect(ids.indexOf(assistantRow.id)).toBeLessThan(ids.indexOf(fileRow.id));
    expect(ids.indexOf(fileRow.id)).toBeLessThan(ids.indexOf(resultRow.id));
    const transcript = loadTranscriptEntries(ordered);
    expect(transcript.map((entry) => entry.message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(transcript.some((entry) => entry.id === fileRow.id)).toBe(false);
    const call = transcript[1]?.message;
    const followed = transcript[2]?.message;
    if (call?.role !== "assistant" || followed?.role !== "toolResult") throw new Error("pair missing");
    expect(call.content.some((block) => block.type === "toolCall" && block.id === "call-send")).toBe(true);
    expect(followed.toolCallId).toBe("call-send");

    const visible = ordered.filter((row) => row.id !== fileRow.id).map((row) => row.id);
    expect(chat.canSummarize(fx.scope, fx.conversationId, visible, resultRow.id)).toBe(true);
    expect(chat.canSummarize(fx.scope, fx.conversationId, visible.filter((id) => id !== user.id), resultRow.id)).toBe(false);

    const views = ordered.map(messageView);
    const running = taskView(fx, "running");
    const hidden = redactMessages(views, [running], false);
    const fileIds = ordered.filter((row) => {
      const parsed = JSON.parse(row.contentJson) as { delivery?: string };
      return parsed.delivery === "file";
    }).map((row) => row.id);
    expect(hidden.map((item) => item.id)).toEqual([user.id, ...fileIds]);
    const finished = redactMessages(views, [{ ...running, state: "succeeded" }], false);
    expect(finished.some((item) => item.id === fileRow.id)).toBe(true);
    expect(finished.some((item) => item.id === resultRow.id)).toBe(false);
  });

  it("stops past 20 sends and reports missing, escaped, and oversized files without a message", async () => {
    const fx = fixture();
    let mode: "ok" | "missing" | "escape" | "dir" | "huge" = "ok";
    const tool = createSendFileTool({
      ...fx.binding,
      files: {
        download: async () => {
          if (mode === "missing") throw new Error("文件不存在");
          if (mode === "escape") throw new Error("路径超出 /home/bot 和 /tmp：/etc/passwd");
          if (mode === "dir") throw new Error("不是普通文件");
          if (mode === "huge") return hugeStream();
          return Readable.from([Buffer.from("x")]);
        },
      },
    });
    for (let index = 0; index < 20; index += 1) {
      await tool.execute("call", { path: `/tmp/n-${index}.txt` });
    }
    await expect(tool.execute("call", { path: "/tmp/extra.txt" })).rejects.toThrow(/20/);
    expect(countUploads(fx.db, fx.userId)).toBe(20);

    const fresh = fixture();
    const failing = createSendFileTool({
      ...fresh.binding,
      files: {
        download: async () => {
          if (mode === "missing") throw new Error("文件不存在");
          if (mode === "escape") throw new Error("路径超出 /home/bot 和 /tmp：/etc/passwd");
          if (mode === "dir") throw new Error("不是普通文件");
          return hugeStream();
        },
      },
    });
    mode = "missing";
    await expect(failing.execute("call", { path: "/tmp/missing.txt" })).rejects.toThrow(/文件不存在/);
    mode = "escape";
    await expect(failing.execute("call", { path: "/etc/passwd" })).rejects.toThrow(/超出/);
    mode = "dir";
    await expect(failing.execute("call", { path: "/tmp" })).rejects.toThrow(/不是普通文件/);
    mode = "huge";
    await expect(failing.execute("call", { path: "/tmp/huge.bin" })).rejects.toThrow(/25 MB/);
    await expect(failing.execute("call", { path: "" })).rejects.toThrow(/路径不能为空/);
    await expect(failing.execute("call", { path: "/tmp/a.txt", caption: "a".repeat(1001) })).rejects.toThrow(/1000/);
    expect(countUploads(fresh.db, fresh.userId)).toBe(0);
    expect(chatRepository(fresh.db).listMessages(fresh.scope, fresh.conversationId)).toEqual([]);
  });

  it("drops the upload when the message transaction fails", async () => {
    const fx = fixture();
    const published: string[] = [];
    const tool = createSendFileTool({
      ...fx.binding,
      publish: (messageId) => published.push(messageId),
      files: { download: async () => Readable.from([Buffer.from("orphan")]) },
    });
    fx.db.$client.prepare("update tasks set state='succeeded' where id=?").run(fx.taskId);
    expect(chatRepository(fx.db).deleteConversation(fx.scope, fx.conversationId)).toEqual([]);
    await expect(tool.execute("call", { path: "/tmp/orphan.txt" })).rejects.toThrow();
    expect(published).toEqual([]);
    expect(countUploads(fx.db, fx.userId)).toBe(0);
    expect(filesIn(join(fx.binding.dataDir, "uploads"))).toEqual([]);
  });

  it("keeps the file visible while the task is running and after it ends, and cleans it up with the conversation", async () => {
    const http = await boot();
    const machine = await listen((req, res) => {
      if (req.url !== "/fs/download") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(PNG);
    });
    const seen: string[] = [];
    let releaseModel: () => void = () => {};
    let releaseSecond: () => void = () => {};
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondStarted: () => void = () => {};
    const secondSeen = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const model = await listen(async (_req, res, body) => {
      seen.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (body.includes("已发送图片")) {
        secondStarted();
        await secondGate;
        res.end(textSse("已经发出"));
        return;
      }
      if (body.includes("把图发给我")) {
        await modelGate;
        res.end(toolSse("send_file", { path: "/tmp/dot.png", caption: "看这张图" }));
        return;
      }
      res.end(textSse("好"));
    });
    const { app, config, db } = await appFor(http, {
      VB_MODEL_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
    }, { host: "127.0.0.1", port: machine.port, token: "machine" });
    settingsRepository(db).setFsConfineConfig({ enabled: true, allow: ["/tmp"], deny: ["/tmp/secret"] });
    const session = createSession(db, http.key, "user-a", "refresh-a", new Date());
    ensureDevUser(db, "user-b");
    const other = createSession(db, http.key, "user-b", "refresh-b", new Date());
    const headers = { cookie: `vb_session=${session.token}`, "x-vb-csrf": session.csrf, "content-type": "application/json" };
    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name: "Ada", model: "fake" },
    });
    expect(created.statusCode).toBe(201);
    const botId = created.json().bot.id as string;
    const address = app.server.address() as AddressInfo;
    config.publicUrl = `http://127.0.0.1:${address.port}`;
    const sent = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers,
      payload: { text: "把图发给我" },
    });
    expect(sent.statusCode).toBe(202);
    const conversationId = sent.json().conversationId as string;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { cookie: `vb_session=${session.token}`, origin: config.publicUrl },
    });
    closers.push(() => {
      socket.close();
    });
    const events: Array<{ type?: string; message?: { text?: string; attachments?: Array<{ id: string; kind: string }> } }> = [];
    socket.on("message", (raw) => {
      events.push(JSON.parse(String(raw)) as (typeof events)[number]);
    });
    await onceOpen(socket);
    socket.send(JSON.stringify({ type: "subscribe", conversationId }));
    await waitFor(() => events.some((event) => event.type === "subscribed"));
    try {
    releaseModel();
    await secondSeen;
    await waitFor(() => events.some((event) => event.type === "message" && (event.message?.attachments?.length ?? 0) > 0));
    const pushed = events.find((event) => event.type === "message" && (event.message?.attachments?.length ?? 0) > 0);
    expect(pushed?.message?.text).toBe("看这张图");
    expect(pushed?.message?.attachments?.[0]?.kind).toBe("image");
    const running = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: headers.cookie },
    });
    expect(running.statusCode).toBe(200);
    const runningMessages = running.json().messages as Array<{ text: string; attachments?: Array<{ id: string }> }>;
    expect(runningMessages.some((item) => item.text === "看这张图" && (item.attachments?.length ?? 0) > 0)).toBe(true);
    expect(JSON.stringify(runningMessages)).not.toContain("sk-");
    expect(seen.some((body) => body.includes("send_file"))).toBe(true);
    const follow = seen.find((body) => body.includes("已发送图片"));
    expect(follow).toBeTruthy();
    expect(follow).not.toContain('"delivery":"file"');
    expect(follow).not.toContain('"delivery": "file"');
    const download = machine.bodies.find((body) => body.includes("/tmp/dot.png"));
    expect(download).toContain('"confine":true');
    expect(download).toContain('"/tmp"');
    expect(download).toContain('"/tmp/secret"');
    expect(db.$client.prepare("select count(*) as n from approvals").get()).toEqual({ n: 0 });
    releaseSecond();
    await chatService(app).idle();
    const done = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { cookie: headers.cookie },
    });
    const doneMessages = done.json().messages as Array<{ text: string; attachments?: Array<{ id: string; kind: string }> }>;
    const file = doneMessages.find((item) => (item.attachments?.length ?? 0) > 0);
    expect(file?.text).toBe("看这张图");
    expect(doneMessages.some((item) => item.text === "已经发出")).toBe(true);
    const uploadId = file?.attachments?.[0]?.id;
    if (!uploadId) throw new Error("missing upload");
    const owned = await app.inject({ method: "GET", url: `/api/uploads/${uploadId}`, headers: { cookie: headers.cookie } });
    expect(owned.statusCode).toBe(200);
    expect(owned.headers["content-type"]).toMatch(/image\/png/);
    expect(owned.rawPayload.equals(PNG)).toBe(true);
    const foreign = await app.inject({
      method: "GET",
      url: `/api/uploads/${uploadId}`,
      headers: { cookie: `vb_session=${other.token}` },
    });
    expect(foreign.statusCode).toBe(404);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: headers.cookie, "x-vb-csrf": session.csrf },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(countUploads(db, "user-a")).toBe(0);
    expect(await http.storage.exists("user-a", uploadId)).toBe(false);
    } finally {
      releaseModel();
      releaseSecond();
    }
  });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

function taskView(fx: Fixture, state: string): TaskView {
  return {
    id: fx.taskId,
    botId: fx.botId,
    conversationId: fx.conversationId,
    state,
    error: null,
    stepCount: 1,
    startedAt: null,
    endedAt: null,
  };
}

function toolCallMessage(name: string, id: string, args: Record<string, string>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "openai-completions",
    provider: "viate-bot",
    model: "gpt-test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function countUploads(db: AppDatabase, userId: string): number {
  const row = db.$client.prepare("select count(*) as n from uploads where user_id=?").get(userId) as { n: number };
  return row.n;
}

function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const rel = String(entry);
    if (statSync(join(dir, rel)).isFile()) found.push(rel.split("\\").join("/"));
  }
  return found.sort();
}

function hugeStream(): Readable {
  const total = 25 * 1024 * 1024 + 1;
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= total) {
        this.push(null);
        return;
      }
      const size = Math.min(64 * 1024, total - sent);
      sent += size;
      this.push(Buffer.alloc(size, 1));
    },
  });
}

interface Fixture {
  db: AppDatabase;
  storage: UploadStorage;
  scope: UserScope;
  userId: string;
  botId: string;
  conversationId: string;
  taskId: string;
  binding: {
    db: AppDatabase;
    dataDir: string;
    storage: UploadStorage;
    userId: string;
    scope: UserScope;
    taskId: string;
    conversationId: string;
    confined: boolean;
    confineNow: () => boolean;
    confinePolicyNow: () => { allow: string[]; deny: string[] };
    knownSecrets: () => Array<{ name: string; value: string }>;
    now: () => Date;
    publish: (messageId: string) => void;
  };
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "vb-send-file-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => {
    db.$client.close();
  });
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  ensureDevUser(db, "user-a");
  const scope = userScope("user-a");
  const botId = ulid();
  const conversationId = ulid();
  const taskId = ulid();
  db.$client.prepare("insert into bots (id, user_id, name, model, created_at, updated_at) values (?, ?, 'Ada', 'fake', 't', 't')").run(botId, "user-a");
  db.$client.prepare("insert into conversations (id, bot_id, title, created_at, updated_at) values (?, ?, '', 't', 't')").run(conversationId, botId);
  db.$client.prepare("insert into tasks (id, bot_id, conversation_id, state, trigger) values (?, ?, ?, 'running', 'user')").run(taskId, botId, conversationId);
  const storage = localUploadStorage(dir);
  const policy = { allow: ["/tmp/work"], deny: ["/tmp/work/secret"] };
  return {
    db,
    storage,
    scope,
    userId: "user-a",
    botId,
    conversationId,
    taskId,
    binding: {
      db,
      dataDir: dir,
      storage,
      userId: "user-a",
      scope,
      taskId,
      conversationId,
      confined: true,
      confineNow: () => true,
      confinePolicyNow: () => policy,
      knownSecrets: () => [],
      now: () => new Date(),
      publish: () => {},
    },
  };
}

async function boot(): Promise<ControlContext & { storage: UploadStorage }> {
  const dir = mkdtempSync(join(tmpdir(), "vb-send-http-"));
  dirs.push(dir);
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "test-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
  });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  ensureDevUser(db, "user-a");
  const ctx: ControlContext = { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
  closers.push(() => {
    db.$client.close();
  });
  return { ...ctx, storage: localUploadStorage(dir) };
}

async function appFor(ctx: ControlContext, env: Record<string, string>, endpoint: { host: string; port: number; token: string }) {
  ctx.config = loadConfig({
    VB_DATA_DIR: ctx.config.dataDir,
    VB_PUBLIC_URL: ctx.config.publicUrl,
    VB_MODEL_API_KEY: "test-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
    ...env,
  });
  const app = buildApp(ctx, {
    ensureMachine: async () => {},
    prepareEndpoint: async (_userId, onPhase) => {
      onPhase("ready");
      return endpoint;
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  closers.push(async () => {
    await app.close();
  });
  return { app, config: ctx.config, db: ctx.db };
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>): Promise<{ port: number; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      void Promise.resolve(handler(req, res, body)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, bodies };
}

function toolSse(name: string, args: Record<string, string>): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function textSse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
