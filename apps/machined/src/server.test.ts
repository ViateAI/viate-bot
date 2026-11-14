import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, captureStream } from "./server.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("exec output capture", () => {
  it("keeps the first and last 8KB and reports what was dropped", async () => {
    const head = "H".repeat(8 * 1024);
    const middle = "M".repeat(100);
    const tail = "T".repeat(8 * 1024);
    const events: { type: string; data?: string; droppedBytes?: number }[] = [];
    await captureStream(Readable.from([Buffer.from(head + middle + tail)]), "stdout", (event) => events.push(event));
    const stdout = events.filter((event) => event.type === "stdout").map((event) => event.data ?? "");
    expect(stdout.join("")).toBe(head + tail);
    expect(events.find((event) => event.type === "truncated")?.droppedBytes).toBe(100);
  });

  it("keeps a short stream intact", async () => {
    const events: { type: string; data?: string }[] = [];
    await captureStream(Readable.from([Buffer.from("hello")]), "stdout", (event) => events.push(event));
    expect(events).toEqual([{ type: "stdout", data: "hello" }]);
  });
});

describe("filesystem confinement over http", () => {
  it("writes and reads inside /tmp and rejects an escape", async () => {
    const app = buildServer({ token: "test-token" });
    const dir = mkdtempSync(join("/tmp", "vb-machined-"));
    dirs.push(dir);
    const path = join(dir, "note.txt");
    const headers = { authorization: "Bearer test-token" };
    const written = await app.inject({
      method: "POST",
      url: "/fs/write",
      headers,
      payload: { path, content: "hello" },
    });
    expect(written.statusCode).toBe(200);
    const read = await app.inject({ method: "POST", url: "/fs/read", headers, payload: { path } });
    expect(read.json()).toMatchObject({ content: "hello", truncated: false });
    const escaped = await app.inject({
      method: "POST",
      url: "/fs/read",
      headers,
      payload: { path: "/tmp/../../etc/passwd" },
    });
    expect(escaped.statusCode).toBe(400);
    const link = join(dir, "link");
    symlinkSync("/etc/passwd", link);
    const overwritten = await app.inject({
      method: "POST",
      url: "/fs/write",
      headers,
      payload: { path: link, content: "pwned" },
    });
    expect(overwritten.statusCode).toBe(400);
    const binaryPath = join(dir, "blob.bin");
    const uploaded = await app.inject({
      method: "PUT",
      url: `/fs/file?path=${encodeURIComponent(binaryPath)}`,
      headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" },
      payload: Buffer.from("binary-payload"),
    });
    expect(uploaded.statusCode).toBe(200);
    const downloaded = await app.inject({
      method: "GET",
      url: `/fs/file?path=${encodeURIComponent(binaryPath)}`,
      headers: { authorization: "Bearer test-token" },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe("binary-payload");
    const unauthenticated = await app.inject({ method: "GET", url: "/metrics" });
    expect(unauthenticated.statusCode).toBe(401);
    const health = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer test-token" },
    });
    expect(health.statusCode).toBe(200);
    const healthDenied = await app.inject({ method: "GET", url: "/health" });
    expect(healthDenied.statusCode).toBe(401);
    await app.close();
  });
});
