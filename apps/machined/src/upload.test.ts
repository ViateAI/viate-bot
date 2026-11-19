import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { createWorkerFsClient } from "./fs-client.js";
import { streamUpload } from "./fs-ops.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("POST /fs/upload", () => {
  it("writes the streamed body inside the confined path", async () => {
    const app = buildServer({ token: "test-token" });
    const dir = mkdtempSync(join("/tmp", "vb-upload-"));
    dirs.push(dir);
    const path = join(dir, "uploads", "m1", "notes.txt");
    const response = await app.inject({
      method: "POST",
      url: `/fs/upload?path=${encodeURIComponent(path)}&delivery=notes-1`,
      headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" },
      payload: Buffer.from("secret-bytes"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ path, bytes: 12 });
    expect(readFileSync(path).equals(Buffer.from("secret-bytes"))).toBe(true);
    const escaped = await app.inject({
      method: "POST",
      url: `/fs/upload?path=${encodeURIComponent("/tmp/../../etc/passwd")}&delivery=escape-1`,
      headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" },
      payload: Buffer.from("nope"),
    });
    expect(escaped.statusCode).toBe(400);
    await app.close();
  });

  it("stops a stream past 25 MB and leaves no file", async () => {
    const dir = mkdtempSync(join("/tmp", "vb-upload-big-"));
    dirs.push(dir);
    const path = join(dir, "big.bin");
    const source = new CountingStream(26 * 1024 * 1024);
    await expect(streamUpload(path, source, 25 * 1024 * 1024, "oversize-1")).rejects.toMatchObject({
      statusCode: 413,
      message: expect.stringMatching(/25 MB/),
    });
    expect(source.sent).toBeGreaterThan(25 * 1024 * 1024);
    expect(source.sent).toBeLessThan(25 * 1024 * 1024 + 1024 * 1024);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects an http body over 25 MB and leaves no file", async () => {
    const app = buildServer({ token: "test-token" });
    const dir = mkdtempSync(join("/tmp", "vb-upload-http-"));
    dirs.push(dir);
    const path = join(dir, "big.bin");
    const response = await app.inject({
      method: "POST",
      url: `/fs/upload?path=${encodeURIComponent(path)}&delivery=oversize-http`,
      headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" },
      payload: Buffer.alloc(25 * 1024 * 1024 + 1, 4),
    });
    expect(response.statusCode).toBe(413);
    expect(response.body).toMatch(/25 MB/);
    expect(existsSync(path)).toBe(false);
    await app.close();
  });

  it("B1 keeps a user edit when the same delivery is retried", async () => {
    const dir = mkdtempSync(join("/tmp", "vb-b1-retry-"));
    dirs.push(dir);
    const path = join(dir, "notes.txt");
    await streamUpload(path, Readable.from(Buffer.from("original")), 25 * 1024 * 1024, "deliv-retry");
    writeFileSync(path, "user-rewrote");
    const edited = statSync(path);
    await streamUpload(path, Readable.from(Buffer.from("original-resent")), 25 * 1024 * 1024, "deliv-retry");
    expect(readFileSync(path, "utf8")).toBe("user-rewrote");
    expect(statSync(path).ino).toBe(edited.ino);
  });

  it("B1 does not treat an existing file as this delivery", async () => {
    const dir = mkdtempSync(join("/tmp", "vb-b1-foreign-"));
    dirs.push(dir);
    const path = join(dir, "notes.txt");
    writeFileSync(path, "same-bytes");
    const before = statSync(path);
    await expect(streamUpload(path, Readable.from(Buffer.from("same-bytes")), 25 * 1024 * 1024, "deliv-foreign")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(readFileSync(path, "utf8")).toBe("same-bytes");
    expect(statSync(path).ino).toBe(before.ino);
    expect(existsSync(join(dir, ".vb-deliveries", "deliv-foreign"))).toBe(false);

    const owned = join(dir, "owned.txt");
    await streamUpload(owned, Readable.from(Buffer.from("from-a")), 25 * 1024 * 1024, "deliv-a");
    const committed = statSync(owned);
    await expect(streamUpload(owned, Readable.from(Buffer.from("from-b")), 25 * 1024 * 1024, "deliv-b")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(readFileSync(owned, "utf8")).toBe("from-a");
    expect(statSync(owned).ino).toBe(committed.ino);
    expect(existsSync(join(dir, ".vb-deliveries", "deliv-b"))).toBe(false);
  });

  it("B1 does not damage the target when a partial write fails", async () => {
    const dir = mkdtempSync(join("/tmp", "vb-b1-partial-"));
    dirs.push(dir);
    const kept = join(dir, "kept.txt");
    writeFileSync(kept, "keep-me");
    const keptIno = statSync(kept).ino;
    await expect(streamUpload(kept, failingStream(), 25 * 1024 * 1024, "deliv-kept")).rejects.toThrow(/disk full/);
    expect(readFileSync(kept, "utf8")).toBe("keep-me");
    expect(statSync(kept).ino).toBe(keptIno);

    const fresh = join(dir, "fresh.txt");
    await expect(streamUpload(fresh, failingStream(), 25 * 1024 * 1024, "deliv-fresh")).rejects.toThrow(/disk full/);
    expect(existsSync(fresh)).toBe(false);
    const book = join(dir, ".vb-deliveries");
    if (existsSync(book)) {
      expect(readdirSync(book).filter((name) => name.endsWith(".part"))).toEqual([]);
    }
    await streamUpload(fresh, Readable.from(Buffer.from("complete-bytes")), 25 * 1024 * 1024, "deliv-fresh");
    expect(readFileSync(fresh, "utf8")).toBe("complete-bytes");
    expect(readFileSync(kept, "utf8")).toBe("keep-me");
  });

  it("B1 confirms a hard-linked part without rewriting a later edit", async () => {
    const dir = mkdtempSync(join("/tmp", "vb-b1-link-"));
    dirs.push(dir);
    const path = join(dir, "notes.txt");
    const part = join(dir, ".vb-deliveries", "deliv-link.part");
    mkdirSync(join(dir, ".vb-deliveries"), { recursive: true });
    writeFileSync(part, "original");
    linkSync(part, path);
    writeFileSync(path, "user-rewrote");
    const edited = statSync(path);
    await streamUpload(path, Readable.from(Buffer.from("resent-bytes")), 25 * 1024 * 1024, "deliv-link");
    expect(readFileSync(path, "utf8")).toBe("user-rewrote");
    expect(statSync(path).ino).toBe(edited.ino);
  });

  it("B1 does not replace a user edit when the same delivery is posted again", async () => {
    const app = buildServer({ token: "test-token" });
    const dir = mkdtempSync(join("/tmp", "vb-b1-http-"));
    dirs.push(dir);
    const path = join(dir, "notes.txt");
    const headers = { authorization: "Bearer test-token", "content-type": "application/octet-stream" };
    const url = `/fs/upload?path=${encodeURIComponent(path)}&delivery=deliv-http`;
    try {
      const first = await app.inject({
        method: "POST",
        url,
        headers,
        payload: Buffer.from("original"),
      });
      expect(first.statusCode).toBe(200);
      writeFileSync(path, "user-rewrote");
      const edited = statSync(path);
      const second = await app.inject({
        method: "POST",
        url,
        headers,
        payload: Buffer.from("original-resent"),
      });
      expect(second.statusCode).toBe(200);
      expect(readFileSync(path, "utf8")).toBe("user-rewrote");
      expect(statSync(path).ino).toBe(edited.ino);
    } finally {
      await app.close();
    }
  });

  it("concurrent same-delivery writes do not share one truncatable part or change a published file", async () => {
    const dir = mkdtempSync(join("/tmp", "vb-concurrent-"));
    dirs.push(dir);
    const path = join(dir, "notes.txt");
    const book = join(dir, ".vb-deliveries");
    let releaseLeft: () => void = () => {};
    let releaseRight: () => void = () => {};
    const leftGate = new Promise<void>((resolve) => {
      releaseLeft = resolve;
    });
    const rightGate = new Promise<void>((resolve) => {
      releaseRight = resolve;
    });
    let leftWaiting = false;
    let rightOpened = false;
    const left = streamUpload(path, gatedBytes([Buffer.from("AAAA"), Buffer.from("AAAA")], [
      undefined,
      async () => {
        leftWaiting = true;
        await leftGate;
      },
    ]), 25 * 1024 * 1024, "same-delivery");
    const right = streamUpload(path, gatedBytes([Buffer.from("BBBB")], [
      async () => {
        rightOpened = true;
        await rightGate;
      },
    ]), 25 * 1024 * 1024, "same-delivery");
    try {
      await waitUntil(() => leftWaiting && rightOpened);
      const shared = readdirSync(book).filter((name) => name.endsWith(".part"));
      releaseRight();
      await right;
      const published = readFileSync(path);
      const publishedIno = statSync(path).ino;
      releaseLeft();
      await left.catch(() => undefined);
      expect(readFileSync(path).toString("utf8")).toBe(published.toString("utf8"));
      expect(statSync(path).ino).toBe(publishedIno);
      expect(published.equals(Buffer.from("BBBB")) || published.equals(Buffer.from("AAAAAAAA"))).toBe(true);
      expect(shared.length).toBe(2);
      await left;
      await right;
    } finally {
      releaseLeft();
      releaseRight();
      await Promise.allSettled([left, right]);
    }
  });

  it("B1 does not create a file when the delivery id is missing", async () => {
    const app = buildServer({ token: "test-token" });
    const dir = mkdtempSync(join("/tmp", "vb-b1-noid-"));
    dirs.push(dir);
    const path = join(dir, "notes.txt");
    try {
      const response = await app.inject({
        method: "POST",
        url: `/fs/upload?path=${encodeURIComponent(path)}`,
        headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" },
        payload: Buffer.from("original"),
      });
      expect(response.statusCode).toBe(400);
      expect(existsSync(path)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("I3 rejects an early worker upload without an unhandled EPIPE and still accepts the next file", async () => {
    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => {
      crashes.push(error);
    };
    process.on("uncaughtException", onCrash);
    const dir = mkdtempSync(join("/tmp", "vb-worker-upload-"));
    dirs.push(dir);
    const worker = join(dir, "fs-worker.mjs");
    await build({
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      entryPoints: [fileURLToPath(new URL("./fs-worker.ts", import.meta.url))],
      outfile: worker,
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    process.env.VB_FS_WORKER_BIN = worker;
    const app = buildServer({ token: "test-token", files: createWorkerFsClient() });
    try {
      const rejected = await app.inject({
        method: "POST",
        url: `/fs/upload?path=${encodeURIComponent("/tmp/../../etc/passwd")}&delivery=bad-path`,
        headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" },
        payload: Buffer.alloc(1024 * 1024, 7),
      });
      expect(rejected.statusCode).toBe(400);
      const limited = await app.inject({
        method: "POST",
        url: `/fs/upload?path=${encodeURIComponent(join(dir, "too-big.bin"))}&delivery=too-big`,
        headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" },
        payload: new CountingStream(26 * 1024 * 1024),
      });
      expect(limited.statusCode).toBe(413);
      expect(existsSync(join(dir, "too-big.bin"))).toBe(false);
      const path = join(dir, "uploads", "m1", "notes.txt");
      const ok = await app.inject({
        method: "POST",
        url: `/fs/upload?path=${encodeURIComponent(path)}&delivery=notes-ok`,
        headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" },
        payload: Buffer.from("secret-bytes"),
      });
      expect(ok.statusCode).toBe(200);
      expect(readFileSync(path).equals(Buffer.from("secret-bytes"))).toBe(true);
      const health = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: "Bearer test-token" },
      });
      expect(health.statusCode).toBe(200);
      expect(crashes).toEqual([]);
    } finally {
      delete process.env.VB_FS_WORKER_BIN;
      process.removeListener("uncaughtException", onCrash);
      await app.close();
    }
  });
});

function gatedBytes(chunks: Buffer[], before: Array<(() => Promise<void>) | undefined>): Readable {
  let index = 0;
  let busy = false;
  return new Readable({
    read() {
      if (busy || index >= chunks.length) return;
      busy = true;
      const hook = before[index];
      const chunk = chunks[index];
      index += 1;
      void Promise.resolve()
        .then(() => hook?.())
        .then(() => {
          this.push(chunk);
          if (index === chunks.length) this.push(null);
          busy = false;
        });
    },
  });
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("并发写入没有同时进入暂存");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function failingStream(): Readable {
  return Readable.from(
    (async function* () {
      yield Buffer.from("partial-bytes");
      throw new Error("disk full");
    })(),
  );
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
    this.push(Buffer.alloc(size, 3));
  }
}
