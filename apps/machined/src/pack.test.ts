import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { packConfined } from "./fs-ops.js";
import { buildServer } from "./server.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join("/tmp", "vb-pack-"));
  dirs.push(dir);
  return dir;
}

function entries(archive: Buffer): Array<{ path: string; mode: number; data: Buffer }> {
  const found: Array<{ path: string; mode: number; data: Buffer }> = [];
  let at = 0;
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512);
    at += 512;
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const path = [prefix, name].filter((part) => part.length > 0).join("/");
    const mode = Number.parseInt(header.subarray(100, 108).toString("utf8").trim(), 8);
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").trim(), 8);
    const type = header[156];
    const data = Buffer.from(archive.subarray(at, at + size));
    at += Math.ceil(size / 512) * 512;
    if (type === 48 || type === 0) found.push({ path, mode, data });
  }
  return found;
}

async function packed(path: string): Promise<Buffer> {
  const archive = await packConfined(path);
  if (Buffer.isBuffer(archive)) return archive;
  const chunks: Buffer[] = [];
  for await (const chunk of archive as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("machined directory pack", () => {
  it("refuses a parent replaced with a symlink before streaming", async () => {
    const root = scratch();
    const app = join(root, "app");
    mkdirSync(app);
    const path = join(app, "private.txt");
    writeFileSync(path, "inside");
    const stream = await packConfined(app);
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "outside");
    rmSync(app, { recursive: true });
    symlinkSync(outside, app);
    await expect(async () => { for await (const _chunk of stream) { /* Drain. */ } }).rejects.toThrow(/路径已改变/);
  });

  it("streams bounded chunks and propagates a late file read failure", async () => {
    const app = scratch();
    const path = join(app, "large.bin");
    writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 0x61));
    const stream = await packConfined(app);
    expect(stream).toBeInstanceOf(Readable);
    let size = 0;
    for await (const chunk of stream as Readable) {
      expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
      size += chunk.length;
    }
    expect(size).toBe(2 * 1024 * 1024 + 512 + 1024);
    const broken = await packConfined(app);
    rmSync(path);
    await expect(async () => {
      for await (const _chunk of broken as Readable) { /* Drain the failed response. */ }
    }).rejects.toThrow();
  });

  it("rejects a directory outside /home/bot and /tmp", async () => {
    await expect(packConfined("/etc")).rejects.toThrow(/超出/);
  });

  it("does not pack a symlink that points outside the directory", async () => {
    const root = scratch();
    const app = join(root, "app");
    const outsideDir = join(root, "outside");
    mkdirSync(app);
    mkdirSync(outsideDir);
    writeFileSync(join(app, "keep.txt"), "keep");
    writeFileSync(join(outsideDir, "secret.txt"), "secret-outside");
    symlinkSync(join(outsideDir, "secret.txt"), join(app, "leak"));
    symlinkSync(outsideDir, join(app, "leak-dir"));
    const archive = await packed(app);
    expect(archive.includes(Buffer.from("secret-outside"))).toBe(false);
    expect(entries(archive).map((entry) => entry.path)).toEqual(["keep.txt"]);
  });

  it("omits fifo, socket, and other non-regular files", async () => {
    const app = scratch();
    writeFileSync(join(app, "keep.txt"), "keep");
    execFileSync("mkfifo", [join(app, "pipe")]);
    const socket = join(app, "sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const archive = await packed(app);
      expect(entries(archive).map((entry) => entry.path)).toEqual(["keep.txt"]);
      expect(archive.includes(Buffer.from("pipe"))).toBe(false);
    } finally {
      server.close();
    }
  });

  it("stops before packing more than 5000 files or 200MB", async () => {
    const counted = scratch();
    for (let index = 0; index < 5001; index += 1) writeFileSync(join(counted, `f${index}`), "");
    await expect(packConfined(counted)).rejects.toThrow(/5000/);

    const heavy = scratch();
    const fd = openSync(join(heavy, "big.bin"), "w");
    try {
      ftruncateSync(fd, 200 * 1024 * 1024 + 1);
    } finally {
      closeSync(fd);
    }
    await expect(packConfined(heavy)).rejects.toThrow(/200/);
  });

  it("keeps the executable bit and serves the tar from POST /fs/pack", async () => {
    const app = scratch();
    writeFileSync(join(app, "run.sh"), "echo ok\n", { mode: 0o755 });
    writeFileSync(join(app, "note.txt"), "hi\n", { mode: 0o644 });
    chmodSync(join(app, "run.sh"), 0o755);
    chmodSync(join(app, "note.txt"), 0o644);
    const archive = await packed(app);
    const files = entries(archive);
    const run = files.find((entry) => entry.path === "run.sh");
    const note = files.find((entry) => entry.path === "note.txt");
    if (!run || !note) throw new Error("packed files missing");
    expect(run.mode & 0o111).toBe(0o111);
    expect(note.mode & 0o111).toBe(0);
    expect(run.data.toString("utf8")).toBe("echo ok\n");

    const http = buildServer({ token: "test-token" });
    const response = await http.inject({
      method: "POST",
      url: "/fs/pack",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      payload: { path: app },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-tar");
    expect(entries(response.rawPayload).map((entry) => entry.path).sort()).toEqual(["note.txt", "run.sh"]);
    const denied = await http.inject({
      method: "POST",
      url: "/fs/pack",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      payload: { path: "/etc" },
    });
    expect(denied.statusCode).toBe(400);
    await http.close();
  });
});
