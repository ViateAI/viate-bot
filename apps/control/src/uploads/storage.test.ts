import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { settingsRepository } from "../db/settings.js";
import { ensureDevUser } from "../db/users.js";
import { createSession } from "../session.js";
import { deliverAttachments } from "./deliver.js";
import { presentForModel, type PresentedEntry } from "./present.js";
import {
  localUploadStorage,
  s3UploadStorage,
  uploadObjectKey,
  type UploadStorage,
} from "./storage.js";
import { ensureUploadStorage, UPLOAD_STORAGE_EPOCH, UPLOAD_STORAGE_KEY, uploadPredatesStorage } from "./switch.js";
import { UploadRejected, cleanupUnreferencedUploads, readAttachments, saveUpload } from "./store.js";

const SECRET = "s3-secret-do-not-print";
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0x02,
  0xfe, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const MAX_FILE = 25 * 1024 * 1024;
const MAX_USER = 2 * 1024 * 1024 * 1024;

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("upload storage contract", () => {
  it("stores, reads, and deletes the same bytes on local and s3", async () => {
    const body = Buffer.from("same-bytes");
    const local = await openLocal();
    const remote = await openFakeS3("team");
    try {
      for (const harness of [local, remote]) {
        const source = writeTemp(harness.dir, body);
        await harness.storage.put("user-a", "id1", source, body.length);
        expect(await readAll(await harness.storage.get("user-a", "id1"))).toEqual(body);
        expect(await harness.storage.exists("user-a", "id1")).toBe(true);
        expect(await harness.storage.exists("user-b", "id1")).toBe(false);
        await expect(harness.storage.get("user-b", "id1")).rejects.toThrow("找不到附件");
        expect(harness.keys()).toContain(uploadObjectKey(harness.prefix, "user-a", "id1"));
        expect(harness.keys().join("\n")).not.toContain("notes.txt");
        await harness.storage.remove("user-a", "id1");
        expect(await harness.storage.exists("user-a", "id1")).toBe(false);
      }
    } finally {
      await local.close();
      await remote.close();
    }
  });

  it("treats a missing object the same way on local and s3", async () => {
    const local = await openLocal();
    const remote = await openFakeS3("");
    try {
      const missing = await Promise.all([local, remote].map(async (harness) => {
        expect(await harness.storage.exists("user-a", "gone")).toBe(false);
        await expect(harness.storage.remove("user-a", "gone")).resolves.toBeUndefined();
        let message = "";
        try {
          await harness.storage.get("user-a", "gone");
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        return message;
      }));
      expect(missing[0]).toBe("找不到附件");
      expect(missing[0]).toBe(missing[1]);
    } finally {
      await local.close();
      await remote.close();
    }
  });
});

describe("s3 saveUpload", () => {
  it("returns a clear error and leaves no row, temp file, or partial object when put fails", async () => {
    const { db, dir } = openDb();
    seedUser(db, "user-a");
    const remote = await openFakeS3("team", { failPut: true, failBody: `boom ${SECRET}` });
    await expect(saveUpload({
      db,
      dataDir: dir,
      storage: remote.storage,
      userId: "user-a",
      filename: "notes.txt",
      stream: Readable.from(Buffer.from("hello")),
      now: new Date("2026-11-20T00:00:00.000Z"),
    })).rejects.toMatchObject({ name: UploadRejected.name, statusCode: 502, message: "无法保存附件" });
    try {
      await saveUpload({
        db,
        dataDir: dir,
        storage: remote.storage,
        userId: "user-a",
        filename: "notes.txt",
        stream: Readable.from(Buffer.from("hello")),
        now: new Date("2026-11-20T00:00:00.000Z"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("boom");
    }
    expect(db.$client.prepare("select count(*) as n from uploads").get()).toEqual({ n: 0 });
    expect(filesIn(join(dir, "uploads"))).toEqual([]);
    expect(remote.keys()).toEqual([]);
    await remote.close();
  });

  it("keeps the size limit, quota, and header sniff in front of put", async () => {
    const { db, dir } = openDb();
    seedUser(db, "user-a");
    seedUser(db, "user-b");
    const remote = await openFakeS3("");
    const overflow = new CountingStream(MAX_FILE + 64 * 1024);
    await expect(saveUpload({
      db,
      dataDir: dir,
      storage: remote.storage,
      userId: "user-a",
      filename: "big.bin",
      stream: overflow,
      now: new Date(),
    })).rejects.toMatchObject({ statusCode: 413, message: expect.stringMatching(/25 MB/) });
    expect(remote.keys()).toEqual([]);
    expect(filesIn(join(dir, "uploads"))).toEqual([]);
    const held = await saveUpload({
      db,
      dataDir: dir,
      storage: remote.storage,
      userId: "user-a",
      filename: "held.bin",
      stream: Readable.from(Buffer.from("held")),
      now: new Date(),
    });
    db.$client.prepare("update uploads set size=? where id=?").run(MAX_USER - 4, held.id);
    const before = remote.keys().length;
    await expect(saveUpload({
      db,
      dataDir: dir,
      storage: remote.storage,
      userId: "user-a",
      filename: "more.bin",
      stream: Readable.from(Buffer.alloc(8, 1)),
      now: new Date(),
    })).rejects.toMatchObject({ statusCode: 413, message: expect.stringMatching(/删除旧对话/) });
    expect(remote.keys()).toHaveLength(before);
    const sniffed = await saveUpload({
      db,
      dataDir: dir,
      storage: remote.storage,
      userId: "user-b",
      filename: "photo.bin",
      stream: Readable.from(PNG),
      now: new Date(),
    });
    expect(sniffed).toMatchObject({ kind: "image", mime: "image/png", size: PNG.length });
    expect(remote.keys()).toContain(uploadObjectKey("", "user-b", sniffed.id));
    expect(remote.keys().join("\n")).not.toContain("photo.bin");
    expect(await readAll(await remote.storage.get("user-b", sniffed.id))).toEqual(PNG);
    await remote.close();
  });

  it("serves the same bytes for preview, model reads, and machine delivery", async () => {
    const remote = await openFakeS3("team");
    const { app, alice, dir, ctx } = await boot({
      VB_UPLOAD_STORAGE: "s3",
      VB_S3_BUCKET: "attachments",
      VB_S3_REGION: "us-east-1",
      VB_S3_ENDPOINT: remote.url,
      VB_S3_FORCE_PATH_STYLE: "1",
      VB_S3_PREFIX: "team",
      VB_S3_ACCESS_KEY_ID: "test-access-key",
      VB_S3_SECRET_ACCESS_KEY: SECRET,
    });
    const packed = multipart("shot.png", PNG);
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: {
        cookie: cookie(alice.token),
        "x-vb-csrf": alice.csrf,
        "content-type": packed.contentType,
      },
      payload: packed.body,
    });
    expect(created.statusCode).toBe(201);
    const upload = created.json().upload as { id: string; sha256: string };
    expect(upload.sha256).toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(remote.keys()).toEqual([uploadObjectKey("team", "user-a", upload.id)]);
    expect(filesIn(join(dir, "uploads"))).toEqual([]);
    const downloaded = await app.inject({
      method: "GET",
      url: `/api/uploads/${upload.id}`,
      headers: { cookie: cookie(alice.token) },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
    expect(downloaded.rawPayload.equals(PNG)).toBe(true);
    const storage = ctx.uploads;
    if (!storage) throw new Error("missing storage");
    const entries: PresentedEntry[] = [{
      id: "m1",
      message: { role: "user", content: "看一下", timestamp: 1 },
      attachments: [{ id: upload.id, name: "shot.png", size: PNG.length, mime: "image/png", kind: "image" }],
    }];
    const shown = await presentForModel(entries, { vision: true, storage, userId: "user-a" });
    expect(JSON.stringify(shown[0]?.message)).toContain(PNG.toString("base64"));
    const delivered: Buffer[] = [];
    await deliverAttachments(
      storage,
      "user-a",
      [{ messageId: "m1", id: upload.id, name: "shot.png" }],
      async (_path, body) => {
        delivered.push(await readAll(body));
      },
      new Set(),
      () => {},
    );
    expect(Buffer.concat(delivered).equals(PNG)).toBe(true);
    await remote.close();
  });
});

describe("upload storage switch", () => {
  it("refuses a backend change when uploads exist unless the switch is explicitly accepted", () => {
    const { db, dir } = openDb();
    seedUser(db, "user-a");
    const first = loadConfig({ VB_DATA_DIR: dir, VB_UPLOAD_STORAGE: "local" });
    const started = ensureUploadStorage(db, first, new Date("2026-11-20T00:00:00.000Z"));
    expect(started).toEqual({ backend: "local", since: "2026-11-20T00:00:00.000Z" });
    db.$client.prepare(
      "insert into uploads (id, user_id, message_id, name, size, mime, sha256, kind, created_at) values (?, ?, null, 'a.txt', 1, 'application/octet-stream', ?, 'file', ?)",
    ).run("old-upload", "user-a", "ab".repeat(32), "2026-11-20T00:00:01.000Z");
    const switched = s3Config(dir, {});
    expect(() => ensureUploadStorage(db, switched, new Date("2026-11-20T01:00:00.000Z"))).toThrow(/VB_UPLOAD_STORAGE_ACCEPT_SWITCH/);
    try {
      ensureUploadStorage(db, switched, new Date("2026-11-20T01:00:00.000Z"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/预览/);
      expect(message).toMatch(/不会删除/);
      expect(message).not.toContain(SECRET);
    }
    expect(settingsRepository(db).getJson(UPLOAD_STORAGE_KEY)).toEqual(started);
    const empty = openDb();
    ensureUploadStorage(empty.db, loadConfig({ VB_DATA_DIR: empty.dir }), new Date("2026-11-20T00:00:00.000Z"));
    const moved = ensureUploadStorage(empty.db, s3Config(empty.dir, {}), new Date("2026-11-20T02:00:00.000Z"));
    expect(moved).toEqual({ backend: "s3", since: "2026-11-20T02:00:00.000Z" });
    const accepted = ensureUploadStorage(db, s3Config(dir, { VB_UPLOAD_STORAGE_ACCEPT_SWITCH: "1" }), new Date("2026-11-20T03:00:00.000Z"));
    expect(accepted).toEqual({ backend: "s3", since: "2026-11-20T03:00:00.000Z" });
    expect(uploadPredatesStorage("2026-11-20T00:00:01.000Z", accepted.since)).toBe(true);
    expect(uploadPredatesStorage(accepted.since, accepted.since)).toBe(false);
  });

  it("treats a first s3 start with existing uploads and no storage record as a switch from local", () => {
    const { db, dir } = openDb();
    seedUser(db, "user-a");
    db.$client.prepare(
      "insert into uploads (id, user_id, message_id, name, size, mime, sha256, kind, created_at) values (?, ?, null, 'a.txt', 1, 'application/octet-stream', ?, 'file', ?)",
    ).run("old-upload", "user-a", "ab".repeat(32), "2020-01-01T00:00:00.000Z");
    const now = new Date("2026-11-20T03:00:00.000Z");
    expect(() => ensureUploadStorage(db, s3Config(dir, {}), now)).toThrow(/VB_UPLOAD_STORAGE_ACCEPT_SWITCH/);
    try {
      ensureUploadStorage(db, s3Config(dir, {}), now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/从 local/);
      expect(message).toMatch(/预览/);
      expect(message).toMatch(/不会删除/);
      expect(message).not.toContain(SECRET);
    }
    expect(settingsRepository(db).getJson(UPLOAD_STORAGE_KEY)).toBeUndefined();

    const local = openDb();
    seedUser(local.db, "user-b");
    local.db.$client.prepare(
      "insert into uploads (id, user_id, message_id, name, size, mime, sha256, kind, created_at) values (?, ?, null, 'a.txt', 1, 'application/octet-stream', ?, 'file', ?)",
    ).run("old-local", "user-b", "ab".repeat(32), "2020-01-01T00:00:00.000Z");
    expect(
      ensureUploadStorage(local.db, loadConfig({ VB_DATA_DIR: local.dir, VB_UPLOAD_STORAGE: "local" }), now),
    ).toEqual({ backend: "local", since: UPLOAD_STORAGE_EPOCH });
  });

  it("marks existing uploads stale when the first s3 start is explicitly accepted", () => {
    const { db, dir } = openDb();
    seedUser(db, "user-a");
    db.$client.prepare(
      "insert into uploads (id, user_id, message_id, name, size, mime, sha256, kind, created_at) values (?, ?, null, 'a.txt', 1, 'application/octet-stream', ?, 'file', ?)",
    ).run("old-upload", "user-a", "ab".repeat(32), "2020-01-01T00:00:00.000Z");
    const now = new Date("2026-11-20T03:00:00.000Z");
    const accepted = ensureUploadStorage(db, s3Config(dir, { VB_UPLOAD_STORAGE_ACCEPT_SWITCH: "1" }), now);
    expect(accepted).toEqual({ backend: "s3", since: now.toISOString() });
    expect(uploadPredatesStorage("2020-01-01T00:00:00.000Z", accepted.since)).toBe(true);
    expect(settingsRepository(db).getJson(UPLOAD_STORAGE_KEY)).toEqual(accepted);
  });

  it("keeps the first local files readable and only cuts off uploads from before an accepted switch", async () => {
    const remote = await openFakeS3("team");
    const dir = scratchDir();
    const seeded = openDatabase(join(dir, "viate-bot.sqlite"));
    migrate(seeded, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    seedUser(seeded, "user-a");
    seeded.$client.prepare(
      "insert into uploads (id, user_id, message_id, name, size, mime, sha256, kind, created_at) values (?, 'user-a', null, 'legacy.txt', 6, 'application/octet-stream', ?, 'file', ?)",
    ).run("legacy", "cd".repeat(32), "2020-01-01T00:00:00.000Z");
    seeded.$client.close();
    mkdirSync(join(dir, "uploads", "user-a"), { recursive: true });
    writeFileSync(join(dir, "uploads", "user-a", "legacy"), Buffer.from("legacy"));
    const local = await boot({ VB_DATA_DIR: dir, VB_UPLOAD_STORAGE: "local" });
    const legacyDownload = await local.app.inject({
      method: "GET",
      url: "/api/uploads/legacy",
      headers: { cookie: cookie(local.alice.token) },
    });
    expect(legacyDownload.statusCode).toBe(200);
    expect(legacyDownload.rawPayload.toString()).toBe("legacy");
    await local.close();

    expect(() => bootApp(s3Config(dir, {}))).toThrow(/VB_UPLOAD_STORAGE_ACCEPT_SWITCH/);
    const switched = await boot({
      VB_DATA_DIR: dir,
      VB_UPLOAD_STORAGE: "s3",
      VB_S3_BUCKET: "attachments",
      VB_S3_REGION: "us-east-1",
      VB_S3_ENDPOINT: remote.url,
      VB_S3_FORCE_PATH_STYLE: "1",
      VB_S3_PREFIX: "team",
      VB_S3_ACCESS_KEY_ID: "test-access-key",
      VB_S3_SECRET_ACCESS_KEY: SECRET,
      VB_UPLOAD_STORAGE_ACCEPT_SWITCH: "1",
    });
    const stale = await switched.app.inject({
      method: "GET",
      url: "/api/uploads/legacy",
      headers: { cookie: cookie(switched.alice.token) },
    });
    expect(stale.statusCode).toBe(410);
    expect(stale.json()).toEqual({ error: "附件存储已切换，原文件不可用" });
    const bot = await createBot(switched.app, switched.alice);
    const before = switched.ctx.db.$client.prepare("select count(*) as n from messages").get();
    const sent = await send(switched.app, switched.alice, bot, "请看旧文件", ["legacy"]);
    expect(sent.statusCode).toBe(409);
    expect(sent.json()).toEqual({ error: "附件无效" });
    expect(switched.ctx.db.$client.prepare("select count(*) as n from messages").get()).toEqual(before);
    expect(switched.ctx.db.$client.prepare("select count(*) as n from tasks").get()).toEqual({ n: 0 });
    const storage = switched.ctx.uploads;
    const since = switched.ctx.uploadStorageSince;
    if (!storage || !since) throw new Error("missing storage");
    let reads = 0;
    const guarded: UploadStorage = {
      put: (userId, id, source, size) => storage.put(userId, id, source, size),
      get: async (userId, id) => {
        reads += 1;
        return storage.get(userId, id);
      },
      exists: (userId, id) => storage.exists(userId, id),
      remove: (userId, id) => storage.remove(userId, id),
    };
    const staleEntry: PresentedEntry[] = [{
      id: "m-old",
      message: { role: "user", content: "旧图", timestamp: 1 },
      attachments: [{ id: "legacy", name: "legacy.txt", size: 6, mime: "text/plain", kind: "file" }],
    }];
    await presentForModel(staleEntry, {
      vision: true,
      storage: guarded,
      userId: "user-a",
      unavailable: (id) => id === "legacy",
    });
    await expect(deliverAttachments(
      guarded,
      "user-a",
      [{ messageId: "m-old", id: "legacy", name: "legacy.txt" }],
      async () => {},
      new Set(),
      () => {},
      (id) => id === "legacy",
    )).rejects.toThrow(/无法把 legacy\.txt 放到机器上/);
    expect(reads).toBe(0);
    expect(readFileSync(join(dir, "uploads", "user-a", "legacy")).toString()).toBe("legacy");
    const removed = await cleanupUnreferencedUploads(switched.ctx.db, storage, new Date(), since, 0);
    expect(removed).toBe(0);
    expect(existsSync(join(dir, "uploads", "user-a", "legacy"))).toBe(true);
    expect(switched.ctx.db.$client.prepare("select id from uploads where id='legacy'").get()).toEqual({ id: "legacy" });
    const packed = multipart("fresh.txt", Buffer.from("fresh"));
    const created = await switched.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: {
        cookie: cookie(switched.alice.token),
        "x-vb-csrf": switched.alice.csrf,
        "content-type": packed.contentType,
      },
      payload: packed.body,
    });
    expect(created.statusCode).toBe(201);
    const fresh = created.json().upload as { id: string };
    const downloaded = await switched.app.inject({
      method: "GET",
      url: `/api/uploads/${fresh.id}`,
      headers: { cookie: cookie(switched.alice.token) },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload.toString()).toBe("fresh");
    const refs = await readAttachments(switched.ctx.db, "user-a", [fresh.id], storage, since);
    expect(refs.map((item) => item.id)).toEqual([fresh.id]);
    await expect(readAttachments(switched.ctx.db, "user-a", ["legacy"], storage, since)).rejects.toMatchObject({
      statusCode: 409,
      message: "附件无效",
    });
    await remote.close();
  });
});

interface Harness {
  dir: string;
  prefix: string;
  url: string;
  storage: UploadStorage;
  keys: () => string[];
  close: () => Promise<void>;
}

async function openLocal(): Promise<Harness> {
  const dir = scratchDir();
  return {
    dir,
    prefix: "",
    url: "",
    storage: localUploadStorage(dir),
    keys: () => filesIn(join(dir, "uploads")).map((name) => name.split("/").join("/")).map((name) => {
      const [userId, id] = name.split("/");
      return uploadObjectKey("", userId ?? "", id ?? "");
    }),
    close: async () => {},
  };
}

async function openFakeS3(prefix: string, options?: { failPut?: boolean; failBody?: string }): Promise<Harness> {
  const dir = scratchDir();
  const objects = new Map<string, Buffer>();
  const server = createServer((req, res) => handleS3(req, res, objects, options));
  const port = await listenRange(server);
  const url = `http://127.0.0.1:${port}`;
  closers.push(() => closeServer(server));
  return {
    dir,
    prefix,
    url,
    storage: s3UploadStorage({
      bucket: "attachments",
      region: "us-east-1",
      endpoint: url,
      forcePathStyle: true,
      prefix,
      accessKeyId: "test-access-key",
      secretAccessKey: SECRET,
    }),
    keys: () => [...objects.keys()].sort(),
    close: () => closeServer(server),
  };
}

function handleS3(
  req: IncomingMessage,
  res: ServerResponse,
  objects: Map<string, Buffer>,
  options?: { failPut?: boolean; failBody?: string },
): void {
  if (req.headers.expect === "100-continue") res.writeContinue();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = decodeURIComponent(url.pathname).split("/").filter((part) => part.length > 0);
  const key = parts.slice(1).join("/");
  if (req.method === "PUT") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (options?.failPut) {
        objects.set(key, body);
        res.writeHead(500, { "content-type": "text/plain" }).end(options.failBody ?? "fail");
        return;
      }
      objects.set(key, body);
      res.writeHead(200, { etag: '"test"' }).end();
    });
    return;
  }
  if (req.method === "HEAD") {
    const body = objects.get(key);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": String(body.length), etag: '"test"' }).end();
    return;
  }
  if (req.method === "GET") {
    const body = objects.get(key);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": String(body.length), etag: '"test"' }).end(body);
    return;
  }
  if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204).end();
    return;
  }
  res.writeHead(405).end();
}

function listenRange(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const tryPort = (port: number) => {
    if (port > 4439) {
      reject(new Error("4430-4439 are all in use"));
      return;
    }
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      tryPort(port + 1);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", onListening);
  };
  tryPort(4430);
  return promise;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

function openDb(): { db: AppDatabase; dir: string } {
  const dir = scratchDir();
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => {
    db.$client.close();
  });
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, dir };
}

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vb-up-s3-"));
  dirs.push(dir);
  return dir;
}

function writeTemp(dir: string, body: Buffer): string {
  const path = join(dir, "source.bin");
  writeFileSync(path, body);
  return path;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const piece of stream) chunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece));
  return Buffer.concat(chunks);
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

function seedUser(db: AppDatabase, id: string): void {
  db.$client
    .prepare("insert into users (id, email, name, status, created_at) values (?, ?, ?, 'active', ?)")
    .run(id, `${id}@example.com`, id, "2026-11-19T00:00:00.000Z");
}

class CountingStream extends Readable {
  sent = 0;
  constructor(private readonly total: number) {
    super();
  }
  override _read(): void {
    if (this.sent >= this.total) {
      this.push(null);
      return;
    }
    const size = Math.min(64 * 1024, this.total - this.sent);
    this.sent += size;
    this.push(Buffer.alloc(size, 0x61));
  }
}

function s3Config(dir: string, extra: NodeJS.ProcessEnv): ControlConfig {
  return loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "test-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
    VB_UPLOAD_STORAGE: "s3",
    VB_S3_BUCKET: "attachments",
    VB_S3_REGION: "us-east-1",
    VB_S3_ENDPOINT: "http://127.0.0.1:9",
    VB_S3_FORCE_PATH_STYLE: "1",
    VB_S3_ACCESS_KEY_ID: "test-access-key",
    VB_S3_SECRET_ACCESS_KEY: SECRET,
    ...extra,
  });
}

function bootApp(config: ControlConfig): void {
  const db = openDatabase(config.databasePath);
  try {
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    const ctx: ControlContext = { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
    buildApp(ctx, { ensureMachine: async () => {}, prepareEndpoint: async () => ({ host: "127.0.0.1", port: 9, token: "t" }) });
  } finally {
    db.$client.close();
  }
}

async function boot(env: NodeJS.ProcessEnv) {
  const dir = typeof env.VB_DATA_DIR === "string" ? env.VB_DATA_DIR : scratchDir();
  if (!dirs.includes(dir)) dirs.push(dir);
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "test-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
    VB_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
    ...env,
  });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const ctx: ControlContext = { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
  ensureDevUser(ctx.db, "user-a");
  const app = buildApp(ctx, {
    ensureMachine: async () => {},
    prepareEndpoint: async () => ({ host: "127.0.0.1", port: 9, token: "t" }),
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
  return { app, ctx, dir, alice: createSession(ctx.db, ctx.key, "user-a", "refresh-a", new Date()), close };
}

function cookie(token: string): string {
  return `vb_session=${token}`;
}

function multipart(filename: string, content: Buffer): { body: Buffer; contentType: string } {
  const boundary = "vbupload";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
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
