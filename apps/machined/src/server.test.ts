import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { __setRootsForTest, BOT_HOME, BOT_TMP } from "./paths.js";
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
  it("refuses writes through aliases that could escape an approved path prefix", async () => {
    const app = buildServer({ token: "test-token" });
    const scratch = mkdtempSync(join("/tmp", "vb-write-alias-"));
    dirs.push(scratch);
    mkdirSync(join(scratch, "approved"));
    mkdirSync(join(scratch, "private"));
    const target = join(scratch, "private", "keep.txt");
    writeFileSync(target, "keep");
    symlinkSync(join(scratch, "private"), join(scratch, "approved", "alias"));
    try {
      const response = await app.inject({ method: "POST", url: "/fs/write", headers: { authorization: "Bearer test-token" }, payload: { path: join(scratch, "approved", "alias", "keep.txt"), content: "overwritten" } });
      expect(response.statusCode).toBe(400);
      expect(readFileSync(target, "utf8")).toBe("keep");
    } finally {
      await app.close();
    }
  });

  it("refuses deletion through final or escaping parent symlinks", async () => {
    const app = buildServer({ token: "test-token" });
    const scratch = mkdtempSync(join("/tmp", "vb-machined-delete-"));
    dirs.push(scratch);
    const home = join(scratch, "home");
    const outside = join(scratch, "outside");
    mkdirSync(home);
    mkdirSync(outside);
    const target = join(home, "target");
    const fileLink = join(home, "file-link");
    const outsideFile = join(outside, "secret");
    const parentLink = join(home, "escape");
    writeFileSync(target, "keep");
    writeFileSync(outsideFile, "secret");
    symlinkSync(target, fileLink);
    symlinkSync(outside, parentLink);
    const headers = { authorization: "Bearer test-token" };
    __setRootsForTest([home]);
    try {
      const finalLink = await app.inject({ method: "POST", url: "/fs/delete", headers, payload: { path: fileLink } });
      expect(finalLink.statusCode).toBe(400);
      expect(lstatSync(fileLink).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("keep");

      const escaped = await app.inject({
        method: "POST", url: "/fs/delete", headers, payload: { path: join(parentLink, "secret") },
      });
      expect(escaped.statusCode).toBe(400);
      expect(lstatSync(parentLink).isSymbolicLink()).toBe(true);
      expect(readFileSync(outsideFile, "utf8")).toBe("secret");
    } finally {
      __setRootsForTest([BOT_HOME, BOT_TMP]);
      await app.close();
    }
  });

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
    const target = join(dir, "important.txt");
    writeFileSync(target, "keep");
    const fileLink = join(dir, "file-link");
    symlinkSync(target, fileLink);
    const deleted = await app.inject({ method: "POST", url: "/fs/delete", headers, payload: { path: fileLink } });
    expect(deleted.statusCode).toBe(400);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(lstatSync(fileLink).isSymbolicLink()).toBe(true);
    const outside = join("/tmp", `vb-outside-${dir.split("/").at(-1)}.txt`);
    writeFileSync(outside, "secret");
    const escape = join(dir, "escape");
    symlinkSync(outside, escape);
    try {
      const escapedDelete = await app.inject({ method: "POST", url: "/fs/delete", headers, payload: { path: escape } });
      expect(escapedDelete.statusCode).toBe(400);
      expect(readFileSync(outside, "utf8")).toBe("secret");
    } finally {
      rmSync(outside, { force: true });
    }
    const removed = await app.inject({ method: "POST", url: "/fs/delete", headers, payload: { path: target } });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(target)).toBe(false);
    await app.close();
  });
});

describe("exec cancellation", () => {
  it.each(["cancel", "disconnect"])("stops descendant writes after %s", async (mode) => {
    const dir = mkdtempSync(join("/tmp", "vb-exec-tree-"));
    dirs.push(dir);
    const marker = join(dir, "marker");
    const script = join(dir, "parent.mjs");
    writeFileSync(script, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const marker = process.argv[3];",
      "const child = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker + '.ready')}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500);`], { stdio: 'ignore' });",
      "writeFileSync(marker + '.pid', String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const app = buildServer({ token: "test-token", execSpawn: { command: process.execPath, baseArgs: [script] } });
    const controller = new AbortController();
    let descendant = 0;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
      const response = await fetch(`${base}/exec`, { method: "POST", headers, body: JSON.stringify({ cmd: marker, cwd: dir }), signal: controller.signal });
      await expect.poll(() => existsSync(`${marker}.ready`)).toBe(true);
      descendant = Number(readFileSync(`${marker}.pid`, "utf8"));
      if (mode === "cancel") {
        const cancel = await fetch(`${base}/exec/cancel`, { method: "POST", headers, body: JSON.stringify({ id: response.headers.get("x-exec-id") }) });
        expect(cancel.status).toBe(200);
      } else controller.abort();
      await response.body?.cancel().catch(() => undefined);
      // The child runs in a separate Node process; fake timers cannot advance its delayed disk write.
      const elapsed = Promise.withResolvers<void>();
      setTimeout(elapsed.resolve, 700);
      await elapsed.promise;
      expect(existsSync(marker)).toBe(false);
    } finally {
      controller.abort();
      if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ } }
      await app.close();
    }
  });

  it("kills the process and acknowledges before the late write", async () => {
    const dir = mkdtempSync(join("/tmp", "vb-exec-cancel-"));
    dirs.push(dir);
    const marker = join(dir, "marker");
    const script = join(dir, "hang.mjs");
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      "const marker = process.argv[3];",
      "writeFileSync(marker + '.started', String(process.pid));",
      "setTimeout(() => writeFileSync(marker, 'done'), 800);",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const app = buildServer({
      token: "test-token",
      execSpawn: { command: process.execPath, baseArgs: [script] },
    });
    let pid = 0;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
      const running = fetch(`http://127.0.0.1:${address.port}/exec`, {
        method: "POST",
        headers,
        body: JSON.stringify({ cmd: marker, cwd: dir }),
      });
      const started = Date.now();
      while (!existsSync(`${marker}.started`)) {
        if (Date.now() - started > 2000) throw new Error("进程没有启动");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const response = await running;
      const id = response.headers.get("x-exec-id");
      expect(id).toBeTruthy();
      const cancel = await fetch(`http://127.0.0.1:${address.port}/exec/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id }),
      });
      expect(cancel.status).toBe(200);
      await response.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(existsSync(marker)).toBe(false);
      pid = Number(readFileSync(`${marker}.started`, "utf8"));
      expect(Number.isInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      if (pid) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await app.close();
    }
  });

  it("stops the process when the client connection closes", async () => {
    const dir = mkdtempSync(join("/tmp", "vb-exec-drop-"));
    dirs.push(dir);
    const marker = join(dir, "marker");
    const script = join(dir, "hang.mjs");
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      "const marker = process.argv[3];",
      "writeFileSync(marker + '.started', String(process.pid));",
      "setTimeout(() => writeFileSync(marker, 'done'), 700);",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const app = buildServer({
      token: "test-token",
      execSpawn: { command: process.execPath, baseArgs: [script] },
    });
    let pid = 0;
    const controller = new AbortController();
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const response = await fetch(`http://127.0.0.1:${address.port}/exec`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ cmd: marker, cwd: dir }),
        signal: controller.signal,
      });
      const started = Date.now();
      while (!existsSync(`${marker}.started`)) {
        if (Date.now() - started > 2000) throw new Error("进程没有启动");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      pid = Number(readFileSync(`${marker}.started`, "utf8"));
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(existsSync(marker)).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      controller.abort();
      if (pid) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await app.close();
    }
  });
});

describe("fs confine switch", () => {
  it("reads and writes an absolute path outside the roots only when confine is false", async () => {
    const app = buildServer({ token: "test-token" });
    const outside = mkdtempSync(join(tmpdir(), "vb-fs-open-"));
    dirs.push(outside);
    const path = join(outside, "note.txt");
    writeFileSync(path, "outside-ok");
    const headers = { authorization: "Bearer test-token" };
    try {
      const opened = await app.inject({
        method: "POST",
        url: "/fs/read",
        headers,
        payload: { path, confine: false },
      });
      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({ content: "outside-ok" });

      const written = await app.inject({
        method: "POST",
        url: "/fs/write",
        headers,
        payload: { path: join(outside, "new.txt"), content: "made", confine: false },
      });
      expect(written.statusCode).toBe(200);
      expect(readFileSync(join(outside, "new.txt"), "utf8")).toBe("made");

      const listed = await app.inject({
        method: "POST",
        url: "/fs/list",
        headers,
        payload: { path: outside, confine: false },
      });
      expect(listed.statusCode).toBe(200);

      const removed = await app.inject({
        method: "POST",
        url: "/fs/delete",
        headers,
        payload: { path: join(outside, "new.txt"), confine: false },
      });
      expect(removed.statusCode).toBe(200);
      expect(existsSync(join(outside, "new.txt"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("still rejects an empty path, a relative path, and a non-false confine value", async () => {
    const app = buildServer({ token: "test-token" });
    const outside = mkdtempSync(join(tmpdir(), "vb-fs-reject-"));
    dirs.push(outside);
    const path = join(outside, "note.txt");
    writeFileSync(path, "secret");
    const headers = { authorization: "Bearer test-token" };
    try {
      for (const payload of [
        { path: "", confine: false },
        { path: "note.txt", confine: false },
        { path, confine: true },
        { path },
        { path, confine: "false" },
      ]) {
        const response = await app.inject({ method: "POST", url: "/fs/read", headers, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(readFileSync(path, "utf8")).toBe("secret");
      }
    } finally {
      await app.close();
    }
  });

  it("rejects the named escapes when confine is on and allows them when it is false", async () => {
    const app = buildServer({ token: "test-token" });
    const headers = { authorization: "Bearer test-token" };
    const linkDir = mkdtempSync(join("/tmp", "vb-fs-link-"));
    dirs.push(linkDir);
    const link = join(linkDir, "escape");
    symlinkSync("/etc/passwd", link);
    const inside = mkdtempSync(join("/tmp", "vb-fs-inside-"));
    dirs.push(inside);
    writeFileSync(join(inside, "note.txt"), "inside");
    try {
      for (const path of ["/etc/hosts", "/tmp/../etc/passwd", "/home/bot-evil/file", link]) {
        const forced = await app.inject({ method: "POST", url: "/fs/read", headers, payload: { path, confine: true } });
        expect(forced.statusCode, path).toBe(400);
        const omitted = await app.inject({ method: "POST", url: "/fs/read", headers, payload: { path } });
        expect(omitted.statusCode, `omitted ${path}`).toBe(400);
      }
      const hosts = await app.inject({ method: "POST", url: "/fs/read", headers, payload: { path: "/etc/hosts", confine: false } });
      expect(hosts.statusCode).toBe(200);
      expect(hosts.json().content).toBe(readFileSync("/etc/hosts", "utf8"));
      const passwd = await app.inject({
        method: "POST",
        url: "/fs/read",
        headers,
        payload: { path: "/tmp/../etc/passwd", confine: false },
      });
      expect(passwd.statusCode).toBe(200);
      expect(passwd.json().content).toBe(readFileSync("/etc/passwd", "utf8"));
      const linked = await app.inject({ method: "POST", url: "/fs/read", headers, payload: { path: link, confine: false } });
      expect(linked.statusCode).toBe(200);
      expect(linked.json().content).toBe(readFileSync("/etc/passwd", "utf8"));
      const missing = await app.inject({
        method: "POST",
        url: "/fs/read",
        headers,
        payload: { path: "/home/bot-evil/file", confine: false },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).not.toContain("超出");
      const allowed = await app.inject({
        method: "POST",
        url: "/fs/read",
        headers,
        payload: { path: join(inside, "note.txt"), confine: true },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ content: "inside" });
      const home = await app.inject({
        method: "POST",
        url: "/fs/read",
        headers,
        payload: { path: "/home/bot/note.txt", confine: true },
      });
      expect(home.statusCode).toBe(404);
      expect(home.body).not.toContain("超出");
    } finally {
      await app.close();
    }
  });

  it("keeps upload and raw file routes confined unless confine is false", async () => {
    const app = buildServer({ token: "test-token" });
    const outside = mkdtempSync(join(tmpdir(), "vb-fs-upload-"));
    dirs.push(outside);
    const headers = { authorization: "Bearer test-token", "content-type": "application/octet-stream" };
    const path = join(outside, "blob.bin");
    try {
      const blocked = await app.inject({
        method: "PUT",
        url: `/fs/file?path=${encodeURIComponent(path)}`,
        headers,
        payload: Buffer.from("nope"),
      });
      expect(blocked.statusCode).toBe(400);
      const uploaded = await app.inject({
        method: "POST",
        url: `/fs/upload?path=${encodeURIComponent(path)}&delivery=open-1&confine=false`,
        headers,
        payload: Buffer.from("bytes"),
      });
      expect(uploaded.statusCode).toBe(200);
      expect(readFileSync(path).equals(Buffer.from("bytes"))).toBe(true);
      const still = await app.inject({
        method: "POST",
        url: `/fs/upload?path=${encodeURIComponent(join(outside, "other.bin"))}&delivery=closed-1`,
        headers,
        payload: Buffer.from("nope"),
      });
      expect(still.statusCode).toBe(400);
      expect(existsSync(join(outside, "other.bin"))).toBe(false);
    } finally {
      await app.close();
    }
  });
});
