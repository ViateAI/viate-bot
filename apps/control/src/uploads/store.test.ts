import { createHash } from "node:crypto";
import { WriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type ControlContext } from "../app.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { ensureDevUser } from "../db/users.js";
import { createSession } from "../session.js";
import { UploadRejected, cleanupUnreferencedUploads, saveUpload } from "./store.js";

const MAX_FILE = 25 * 1024 * 1024;
const MAX_USER = 2 * 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0x02,
  0xfe, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("uploads", () => {
  it("I2 keeps browser FormData utf-8 names and download bytes", async () => {
    const { app, alice } = await boot();
    const samples = [
      { name: "报告.txt", expected: "报告.txt" },
      { name: "计划📊.md", expected: "计划📊.md" },
      { name: `${"报".repeat(43)}.txt`, expected: `${"报".repeat(41)}.txt` },
    ];
    for (const sample of samples) {
      const bytes = Buffer.from(`payload:${sample.name}`);
      const form = new FormData();
      form.set("file", new File([bytes], sample.name));
      const outbound = new Request("http://127.0.0.1/api/uploads", { method: "POST", body: form });
      const contentType = outbound.headers.get("content-type") ?? "";
      expect(contentType.toLowerCase()).not.toContain("filename*");
      const created = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: {
          cookie: cookie(alice.token),
          "x-vb-csrf": alice.csrf,
          "content-type": contentType,
        },
        payload: Buffer.from(await outbound.arrayBuffer()),
      });
      expect(created.statusCode, sample.name).toBe(201);
      const upload = created.json().upload as { id: string; name: string };
      expect(upload.name, sample.name).toBe(sample.expected);
      expect(Buffer.byteLength(upload.name)).toBeLessThanOrEqual(128);
      const downloaded = await app.inject({
        method: "GET",
        url: `/api/uploads/${upload.id}`,
        headers: { cookie: cookie(alice.token) },
      });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.rawPayload.equals(bytes)).toBe(true);
    }
  });

  it("records an upload owned by the user and keeps the bytes out of the row", async () => {
    const { db, dir } = open();
    seedUser(db, "user-a");
    const saved = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "note.txt",
      stream: Readable.from(Buffer.from("hello")),
      now: new Date("2026-11-19T00:00:00.000Z"),
    });
    expect(saved).toMatchObject({
      userId: "user-a",
      messageId: null,
      name: "note.txt",
      size: 5,
      mime: "application/octet-stream",
      kind: "file",
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      createdAt: "2026-11-19T00:00:00.000Z",
    });
    const columns = columnNames(db, "uploads");
    expect(columns).toEqual(["id", "user_id", "message_id", "name", "size", "mime", "sha256", "kind", "created_at", "delivered_at"]);
    const row = db.$client.prepare("select * from uploads where id=?").get(saved.id) as Record<string, unknown>;
    expect(row.delivered_at).toBeNull();
    expect(JSON.stringify(row)).not.toContain("hello");
    expect(readFileSync(join(dir, "uploads", "user-a", saved.id)).equals(Buffer.from("hello"))).toBe(true);
    const fks = db.$client.prepare("select \"from\", \"table\" from pragma_foreign_key_list('uploads')").all();
    expect(fks).toEqual(
      expect.arrayContaining([
        { from: "user_id", table: "users" },
        { from: "message_id", table: "messages" },
      ]),
    );
  });

  it("stops a stream past 25 MB and leaves no partial file", async () => {
    const { db, dir } = open();
    seedUser(db, "user-a");
    const stream = new CountingStream(40 * 1024 * 1024);
    await expect(
      saveUpload({ db, dataDir: dir, userId: "user-a", filename: "big.bin", stream, now: new Date() }),
    ).rejects.toMatchObject({ statusCode: 413, message: expect.stringMatching(/25 MB/) });
    expect(stream.sent).toBeGreaterThan(MAX_FILE);
    expect(stream.sent).toBeLessThan(MAX_FILE + 1024 * 1024);
    expect(filesIn(join(dir, "uploads"))).toEqual([]);
    expect(db.$client.prepare("select count(*) as n from uploads").get()).toEqual({ n: 0 });
    const exact = new CountingStream(MAX_FILE);
    const saved = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "exact.bin",
      stream: exact,
      now: new Date(),
    });
    expect(saved.size).toBe(MAX_FILE);
    expect(exact.sent).toBe(MAX_FILE);
  });

  it("rejects a user who would pass 2 GB and tells them to delete old conversations", async () => {
    const { db, dir } = open();
    seedUser(db, "user-a");
    seedUser(db, "user-b");
    const held = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "held.bin",
      stream: Readable.from(Buffer.from("held")),
      now: new Date(),
    });
    db.$client.prepare("update uploads set size=? where id=?").run(MAX_USER - 5, held.id);
    await expect(
      saveUpload({
        db,
        dataDir: dir,
        userId: "user-a",
        filename: "more.bin",
        stream: Readable.from(Buffer.alloc(10, 1)),
        now: new Date(),
      }),
    ).rejects.toMatchObject({ name: UploadRejected.name, statusCode: 413, message: expect.stringMatching(/\u5220\u9664\u65e7\u5bf9\u8bdd/) });
    expect(filesIn(join(dir, "uploads", "user-a")).map((name) => name.split("/").pop())).toEqual([held.id]);
    const fitting = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "fit.bin",
      stream: Readable.from(Buffer.alloc(5, 2)),
      now: new Date(),
    });
    expect(fitting.size).toBe(5);
    const other = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-b",
      filename: "other.bin",
      stream: Readable.from(Buffer.alloc(32, 3)),
      now: new Date(),
    });
    expect(other.userId).toBe("user-b");
  });

  it("keeps only the last path segment, strips controls, truncates to 128 bytes, and numbers duplicates", async () => {
    const { db, dir } = open();
    seedUser(db, "user-a");
    const now = new Date();
    const first = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "..\\..\\a\u0000b\u001f.txt",
      stream: Readable.from(Buffer.from("a")),
      now,
    });
    expect(first.name).toBe("ab.txt");
    const long = `${"\u4f60".repeat(50)}.pdf`;
    const truncated = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: `C:\\temp\\${long}`,
      stream: Readable.from(Buffer.from("b")),
      now,
    });
    expect(Buffer.byteLength(truncated.name)).toBeLessThanOrEqual(128);
    expect(truncated.name.endsWith(".pdf")).toBe(true);
    expect(truncated.name).not.toMatch(/[\u0000-\u001f\u007f/\\]/);
    const again = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: first.name,
      stream: Readable.from(Buffer.from("c")),
      now,
    });
    expect(again.name).toBe("ab-2.txt");
    const third = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "ab.txt",
      stream: Readable.from(Buffer.from("d")),
      now,
    });
    expect(third.name).toBe("ab-3.txt");
    const stuffed = "a".repeat(128);
    const wide = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: stuffed,
      stream: Readable.from(Buffer.from("e")),
      now,
    });
    const wide2 = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: stuffed,
      stream: Readable.from(Buffer.from("f")),
      now,
    });
    expect(Buffer.byteLength(wide.name)).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(wide2.name)).toBeLessThanOrEqual(128);
    expect(wide2.name).not.toBe(wide.name);
    expect(wide2.name).toContain("-2");
  });

  it("classifies png, jpeg, gif, and webp by header and treats a renamed svg as a file", async () => {
    const { db, dir } = open();
    seedUser(db, "user-a");
    const now = new Date();
    const samples: Array<{ name: string; body: Buffer; kind: string; mime: string }> = [
      { name: "x.txt", body: PNG, kind: "image", mime: "image/png" },
      { name: "x.png", body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), kind: "image", mime: "image/jpeg" },
      { name: "x.png", body: Buffer.from("GIF89a-not-really"), kind: "image", mime: "image/gif" },
      { name: "x.bin", body: Buffer.from("RIFF\x18\x00\x00\x00WEBP"), kind: "image", mime: "image/webp" },
      { name: "photo.png", body: Buffer.from("not a picture"), kind: "file", mime: "application/octet-stream" },
      { name: "icon.svg", body: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), kind: "file", mime: "application/octet-stream" },
    ];
    for (const sample of samples) {
      const saved = await saveUpload({
        db,
        dataDir: dir,
        userId: "user-a",
        filename: sample.name,
        stream: Readable.from(sample.body),
        now,
      });
      expect(saved, sample.name).toMatchObject({ kind: sample.kind, mime: sample.mime });
    }
  });

  it("drops an unreferenced upload after 24 hours and keeps a referenced one", async () => {
    const { db, dir } = open();
    seedUser(db, "user-a");
    const now = new Date("2026-11-19T12:00:00.000Z");
    const stale = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "stale.txt",
      stream: Readable.from(Buffer.from("stale")),
      now: new Date(now.getTime() - DAY),
    });
    const fresh = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "fresh.txt",
      stream: Readable.from(Buffer.from("fresh")),
      now: new Date(now.getTime() - DAY + 1),
    });
    const kept = await saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "kept.txt",
      stream: Readable.from(Buffer.from("kept")),
      now: new Date(now.getTime() - DAY - 60_000),
    });
    attachMessage(db, "user-a", kept.id);
    expect(cleanupUnreferencedUploads(db, dir, now)).toBe(1);
    expect(existsSync(join(dir, "uploads", "user-a", stale.id))).toBe(false);
    expect(readFileSync(join(dir, "uploads", "user-a", fresh.id)).toString()).toBe("fresh");
    expect(readFileSync(join(dir, "uploads", "user-a", kept.id)).toString()).toBe("kept");
    expect(db.$client.prepare("select id from uploads order by name").all()).toEqual([{ id: fresh.id }, { id: kept.id }]);
  });

  it("removes the partial file when the stream fails", async () => {
    const { db, dir } = open();
    seedUser(db, "user-a");
    const stream = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("\u65ad\u5f00"));
      },
    });
    await expect(
      saveUpload({ db, dataDir: dir, userId: "user-a", filename: "part.bin", stream, now: new Date() }),
    ).rejects.toThrow(/\u65ad\u5f00/);
    expect(filesIn(join(dir, "uploads"))).toEqual([]);
    expect(db.$client.prepare("select count(*) as n from uploads").get()).toEqual({ n: 0 });
  });

  it("deletes only this partial when the stream fails during an in-flight write", async () => {
    const { db, dir } = open();
    seedUser(db, "user-a");
    const userDir = join(dir, "uploads", "user-a");
    mkdirSync(userDir, { recursive: true });
    const neighbor = join(userDir, "neighbor.bin");
    const otherPart = join(userDir, "other-upload.part");
    const neighborBytes = Buffer.from("keep-neighbor");
    const otherPartBytes = Buffer.from("keep-other-part");
    writeFileSync(neighbor, neighborBytes);
    writeFileSync(otherPart, otherPartBytes);
    const payload = Buffer.from("partial-bytes!");

    const nodeFs = createRequire(import.meta.url)("node:fs") as { write: (this: unknown, ...args: unknown[]) => unknown };
    const originalWrite = nodeFs.write;
    const originalDestroy = WriteStream.prototype.destroy;
    let held = false;
    const writeReleased = Promise.withResolvers<void>();
    const writeStarted = Promise.withResolvers<void>();
    const destroyStarted = Promise.withResolvers<void>();
    // The successful fs.write callback stays pending until destroy has started.
    nodeFs.write = function (this: unknown, ...args: unknown[]) {
      const buf = args[1];
      const cb = args[args.length - 1];
      if (!held && typeof cb === "function" && Buffer.isBuffer(buf) && buf.equals(payload)) {
        held = true;
        writeStarted.resolve();
        void writeReleased.promise.then(() => {
          originalWrite.apply(this, args);
        });
        return;
      }
      return originalWrite.apply(this, args);
    };
    WriteStream.prototype.destroy = function (this: WriteStream, error?: Error) {
      const result = originalDestroy.call(this, error);
      const path = String(this.path);
      if (path.startsWith(userDir) && path.endsWith(".part") && path !== otherPart) destroyStarted.resolve();
      return result;
    };

    const stream = new Readable({
      read() {
        if ((this as Readable & { pushed?: boolean }).pushed) return;
        (this as Readable & { pushed?: boolean }).pushed = true;
        this.push(payload);
      },
    });
    const pending = saveUpload({
      db,
      dataDir: dir,
      userId: "user-a",
      filename: "part.bin",
      stream,
      now: new Date(),
    });
    try {
      await writeStarted.promise;
      stream.destroy(new Error("断开"));
      await destroyStarted.promise;
      writeReleased.resolve();
      await expect(pending).rejects.toMatchObject({ message: "断开" });
      expect(filesIn(userDir)).toEqual(["neighbor.bin", "other-upload.part"]);
      expect(readFileSync(neighbor).equals(neighborBytes)).toBe(true);
      expect(readFileSync(otherPart).equals(otherPartBytes)).toBe(true);
      expect(db.$client.prepare("select count(*) as n from uploads").get()).toEqual({ n: 0 });
    } finally {
      writeReleased.resolve();
      nodeFs.write = originalWrite;
      WriteStream.prototype.destroy = originalDestroy;
    }
  });
});

describe("upload http", () => {
  it("stores a multipart file and only the owner can download it", async () => {
    const { app, alice, bob, admin } = await boot();
    const packed = multipart("..\\notes.txt", Buffer.from("hello"), "image/png");
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
    const upload = created.json().upload as { id: string; name: string; kind: string; mime: string; sha256: string };
    expect(upload.name).toBe("notes.txt");
    expect(upload.kind).toBe("file");
    expect(upload.mime).toBe("application/octet-stream");
    expect(upload.sha256).toBe(createHash("sha256").update("hello").digest("hex"));
    const own = await app.inject({
      method: "GET",
      url: `/api/uploads/${upload.id}`,
      headers: { cookie: cookie(alice.token) },
    });
    expect(own.statusCode).toBe(200);
    expect(own.headers["content-disposition"]).toMatch(/attachment/);
    expect(own.headers["content-disposition"]).toMatch(/notes\.txt/);
    expect(String(own.headers["content-type"])).not.toMatch(/^image\//);
    expect(own.rawPayload.equals(Buffer.from("hello"))).toBe(true);
    const image = multipart("shot.png", PNG, "text/plain");
    const imaged = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: {
        cookie: cookie(alice.token),
        "x-vb-csrf": alice.csrf,
        "content-type": image.contentType,
      },
      payload: image.body,
    });
    const imageId = imaged.json().upload.id as string;
    const picture = await app.inject({
      method: "GET",
      url: `/api/uploads/${imageId}`,
      headers: { cookie: cookie(alice.token) },
    });
    expect(picture.statusCode).toBe(200);
    expect(picture.headers["content-type"]).toMatch(/image\/png/);
    expect(picture.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(picture.headers["content-disposition"] ?? "")).not.toMatch(/attachment/);
    expect(picture.rawPayload.equals(PNG)).toBe(true);
    for (const token of [bob.token, admin.token]) {
      const foreign = await app.inject({
        method: "GET",
        url: `/api/uploads/${upload.id}`,
        headers: { cookie: cookie(token) },
      });
      expect(foreign.statusCode).toBe(404);
    }
    const anon = await app.inject({ method: "GET", url: `/api/uploads/${upload.id}` });
    expect(anon.statusCode).toBe(401);
  });

  it("aborts an http upload over 25 MB without leaving a file", async () => {
    const { app, alice, dir } = await boot();
    const address = app.server.address() as AddressInfo;
    const result = await postUntilRejected(address.port, alice.token, alice.csrf);
    expect(result.status).toBe(413);
    expect(result.body).toMatch(/25 MB/);
    expect(result.fileBytes).toBeGreaterThan(MAX_FILE);
    // Same-process writes fill the socket before the handler runs. The stream test checks the 25 MB cutoff; this checks the connection is rejected before the rest of the body is sent.
    expect(result.fileBytes).toBeLessThan(40 * 1024 * 1024);
    expect(filesIn(join(dir, "uploads"))).toEqual([]);
  });
});

function open(): { db: AppDatabase; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "vb-up-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => {
    db.$client.close();
  });
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, dir };
}

function seedUser(db: AppDatabase, id: string): void {
  db.$client
    .prepare("insert into users (id, email, name, status, created_at) values (?, ?, ?, 'active', ?)")
    .run(id, `${id}@example.com`, id, "2026-11-19T00:00:00.000Z");
}

function attachMessage(db: AppDatabase, userId: string, uploadId: string): void {
  db.$client
    .prepare("insert into bots (id, user_id, name, model, created_at, updated_at) values (?, ?, 'b', 'm', 't', 't')")
    .run(`${userId}-bot`, userId);
  db.$client
    .prepare("insert into conversations (id, bot_id, created_at, updated_at) values (?, ?, 't', 't')")
    .run(`${userId}-conv`, `${userId}-bot`);
  db.$client
    .prepare("insert into messages (id, conversation_id, role, content_json, created_at) values (?, ?, 'user', '{}', 't')")
    .run(`${userId}-msg`, `${userId}-conv`);
  db.$client.prepare("update uploads set message_id=? where id=?").run(`${userId}-msg`, uploadId);
}

function columnNames(db: AppDatabase, table: string): string[] {
  const rows = db.$client.prepare("select name from pragma_table_info(?)").all(table);
  const names: string[] = [];
  for (const row of rows) {
    if (row && typeof row === "object" && "name" in row && typeof row.name === "string") names.push(row.name);
  }
  return names;
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

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-up-http-"));
  dirs.push(dir);
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "test-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
  });
  const ctx = contextFor(config);
  ensureDevUser(ctx.db, "user-a");
  ensureDevUser(ctx.db, "user-b");
  ensureDevUser(ctx.db, "user-admin");
  ctx.db.$client.prepare("update users set is_admin=1 where id=?").run("user-admin");
  const app = buildApp(ctx, { ensureMachine: async () => {}, prepareEndpoint: async () => ({ host: "127.0.0.1", port: 9, token: "t" }) });
  await app.listen({ host: "127.0.0.1", port: 0 });
  closers.push(async () => {
    await app.close();
    ctx.db.$client.close();
  });
  const now = new Date();
  return {
    app,
    dir,
    alice: createSession(ctx.db, ctx.key, "user-a", "refresh-a", now),
    bob: createSession(ctx.db, ctx.key, "user-b", "refresh-b", now),
    admin: createSession(ctx.db, ctx.key, "user-admin", "refresh-admin", now),
  };
}

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

function cookie(token: string): string {
  return `vb_session=${token}`;
}

function multipart(filename: string, content: Buffer, type: string): { body: Buffer; contentType: string } {
  const boundary = "vbupload";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function postUntilRejected(port: number, token: string, csrf: string): Promise<{ status: number; body: string; fileBytes: number }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string; fileBytes: number }>();
  let fileBytes = 0;
  let status = 0;
  let body = "";
  let stop = false;
  const req = request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/uploads",
      headers: {
        cookie: cookie(token),
        "x-vb-csrf": csrf,
        "content-type": "multipart/form-data; boundary=vb",
      },
    },
    (res: IncomingMessage) => {
      stop = true;
      status = res.statusCode ?? 0;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status, body, fileBytes }));
    },
  );
  req.on("error", (error) => {
    if (fileBytes > 0) resolve({ status, body, fileBytes });
    else reject(error);
  });
  req.write('--vb\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n');
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  const pump = () => {
    if (stop || req.destroyed || fileBytes >= 40 * 1024 * 1024) {
      if (!req.destroyed) req.end("\r\n--vb--\r\n");
      return;
    }
    fileBytes += chunk.length;
    const queued = req.write(chunk);
    if (stop || req.destroyed) return;
    if (!queued) req.once("drain", pump);
    else setImmediate(pump);
  };
  pump();
  return promise;
}
