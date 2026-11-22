import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerFsClient } from "./fs-client.js";
import { openDownloadStream } from "./fs-ops.js";
import { buildServer } from "./server.js";

const dirs: string[] = [];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join("/tmp", "vb-download-"));
  dirs.push(dir);
  return dir;
}

function sparse(path: string, size: number): void {
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("POST /fs/download", () => {
  it("streams a binary file and an empty file", async () => {
    const app = buildServer({ token: "test-token" });
    const dir = scratch();
    const png = join(dir, "dot.png");
    const empty = join(dir, "empty.bin");
    writeFileSync(png, PNG);
    writeFileSync(empty, Buffer.alloc(0));
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    try {
      const image = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: { path: png },
      });
      expect(image.statusCode).toBe(200);
      expect(image.headers["content-type"]).toContain("application/octet-stream");
      expect(image.rawPayload.equals(PNG)).toBe(true);

      const zero = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: { path: empty, maxBytes: MAX_UPLOAD_BYTES },
      });
      expect(zero.statusCode).toBe(200);
      expect(zero.headers["content-type"]).toContain("application/octet-stream");
      expect(zero.rawPayload.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("honors confine allow and deny lists", async () => {
    const app = buildServer({ token: "test-token" });
    const root = scratch();
    const allowed = join(root, "ok");
    const denied = join(root, "no");
    mkdirSync(allowed);
    mkdirSync(denied);
    writeFileSync(join(allowed, "a.txt"), "yes");
    writeFileSync(join(denied, "b.txt"), "secret");
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    try {
      const outside = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: { path: "/etc/passwd" },
      });
      expect(outside.statusCode).toBe(400);

      const deniedHit = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: {
          path: join(denied, "b.txt"),
          confinePolicy: { allow: [root], deny: [denied] },
        },
      });
      expect(deniedHit.statusCode).toBe(400);
      expect(deniedHit.body).not.toContain("secret");

      const allowMiss = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: {
          path: join(denied, "b.txt"),
          confinePolicy: { allow: [allowed], deny: [] },
        },
      });
      expect(allowMiss.statusCode).toBe(400);

      const allowHit = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: {
          path: join(allowed, "a.txt"),
          confinePolicy: { allow: [allowed], deny: [] },
        },
      });
      expect(allowHit.statusCode).toBe(200);
      expect(allowHit.rawPayload.toString("utf8")).toBe("yes");
    } finally {
      await app.close();
    }
  });

  it("rejects symlink escapes before reading the target", async () => {
    const app = buildServer({ token: "test-token" });
    const root = scratch();
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, "keep.txt"), "keep");
    symlinkSync("/etc/passwd", join(home, "leak"));
    symlinkSync("/etc", join(home, "escape"));
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    try {
      const fileLink = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: { path: join(home, "leak") },
      });
      expect(fileLink.statusCode).toBe(400);
      expect(fileLink.body).not.toMatch(/root:/);

      const parentLink = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: { path: join(home, "escape", "passwd") },
      });
      expect(parentLink.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for a missing file and 400 for a directory", async () => {
    const app = buildServer({ token: "test-token" });
    const dir = scratch();
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: { path: join(dir, "missing.bin") },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toMatch(/文件不存在/);

      const directory = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: { path: dir },
      });
      expect(directory.statusCode).toBe(400);
      expect(directory.body).toMatch(/不是普通文件/);
    } finally {
      await app.close();
    }
  });

  it("returns 413 when the file exceeds maxBytes, including the 25 MB cap", async () => {
    const app = buildServer({ token: "test-token" });
    const dir = scratch();
    const huge = join(dir, "huge.bin");
    const small = join(dir, "small.txt");
    sparse(huge, MAX_UPLOAD_BYTES + 1);
    writeFileSync(small, "123456");
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    try {
      const capped = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: { path: huge, maxBytes: MAX_UPLOAD_BYTES * 4 },
      });
      expect(capped.statusCode).toBe(413);
      expect(capped.body).toMatch(/25 MB/);

      const limited = await app.inject({
        method: "POST",
        url: "/fs/download",
        headers,
        payload: { path: small, maxBytes: 5 },
      });
      expect(limited.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });

  it("stops a file that grows past maxBytes while it is being read", async () => {
    const dir = scratch();
    const path = join(dir, "grow.bin");
    writeFileSync(path, Buffer.alloc(100, 1));
    const opened = await openDownloadStream(path, 100);
    writeFileSync(path, Buffer.alloc(180, 2));
    await expect(readAll(opened.stream)).rejects.toMatchObject({ statusCode: 413 });
  });
});

describe("WorkerFs.download", () => {
  it("streams a normal file and an empty file, and passes 400 and 413 from the child", async () => {
    const dir = scratch();
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
    const files = createWorkerFsClient();
    const png = join(dir, "dot.png");
    const empty = join(dir, "empty.bin");
    const huge = join(dir, "huge.bin");
    const secret = join(dir, "secret");
    mkdirSync(secret);
    writeFileSync(png, PNG);
    writeFileSync(empty, Buffer.alloc(0));
    writeFileSync(join(secret, "no.txt"), "hidden");
    sparse(huge, MAX_UPLOAD_BYTES + 1);
    try {
      expect((await readAll(await files.download(png, MAX_UPLOAD_BYTES))).equals(PNG)).toBe(true);
      expect((await readAll(await files.download(empty, MAX_UPLOAD_BYTES))).length).toBe(0);
      await expect(files.download("/etc/passwd", MAX_UPLOAD_BYTES)).rejects.toMatchObject({ statusCode: 400 });
      await expect(files.download(join(dir, "missing.bin"), MAX_UPLOAD_BYTES)).rejects.toMatchObject({ statusCode: 404 });
      await expect(files.download(dir, MAX_UPLOAD_BYTES)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/不是普通文件/),
      });
      await expect(files.download(huge, MAX_UPLOAD_BYTES)).rejects.toMatchObject({ statusCode: 413 });
      await expect(files.download(join(secret, "no.txt"), MAX_UPLOAD_BYTES, true, { allow: [dir], deny: [secret] })).rejects.toMatchObject({
        statusCode: 400,
      });
    } finally {
      delete process.env.VB_FS_WORKER_BIN;
    }
  });
});
