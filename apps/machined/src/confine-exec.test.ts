import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type * as ChildProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import { __setRootsForTest, BOT_HOME, BOT_TMP } from "./paths.js";

const spawns: Array<{ args: readonly string[]; cwd: string | undefined }> = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    spawn(_command: string, args: readonly string[] = [], options: { cwd?: string } = {}) {
      spawns.push({ args, cwd: options.cwd });
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        pid: number;
        signalCode: NodeJS.Signals | null;
      };
      child.stdout = Readable.from([]);
      child.stderr = Readable.from([]);
      child.pid = 2_147_483_646;
      child.signalCode = null;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  };
});

const dirs: string[] = [];

afterEach(() => {
  spawns.splice(0);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("exec cwd confine", () => {
  it("uses another absolute cwd only when confine is false, and otherwise stays at /home/bot", async () => {
    const base = mkdtempSync(join(tmpdir(), "vb-cwd-"));
    dirs.push(base);
    const allowed = join(base, "allowed");
    const outside = join(base, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    __setRootsForTest([allowed]);
    const app = buildServer({ token: "test-token", execSpawn: { command: process.execPath, baseArgs: ["run-as-bot.mjs"] } });
    try {
      const headers = { authorization: "Bearer test-token" };
      const blocked = await app.inject({
        method: "POST",
        url: "/exec",
        headers,
        payload: { cmd: "true", cwd: outside },
      });
      expect(blocked.statusCode).toBe(400);
      expect(spawns).toEqual([]);

      const opened = await app.inject({
        method: "POST",
        url: "/exec",
        headers,
        payload: { cmd: "true", cwd: outside, confine: false },
      });
      expect(opened.statusCode).toBe(200);
      expect(spawns.at(-1)?.cwd).toBe(outside);

      const relative = await app.inject({
        method: "POST",
        url: "/exec",
        headers,
        payload: { cmd: "true", cwd: "relative", confine: false },
      });
      expect(relative.statusCode).toBe(400);

      const home = await app.inject({
        method: "POST",
        url: "/exec",
        headers,
        payload: { cmd: "true", confine: false },
      });
      expect(home.statusCode).toBe(200);
      expect(spawns.at(-1)?.cwd).toBe("/home/bot");
    } finally {
      __setRootsForTest([BOT_HOME, BOT_TMP]);
      await app.close();
    }
  });

  it("checks cwd against confinePolicy and ignores the lists when confine is false", async () => {
    const outside = mkdtempSync(join(tmpdir(), "vb-cwd-policy-"));
    dirs.push(outside);
    mkdirSync(join(outside, "secret"));
    mkdirSync(join(outside, "secret-other"));
    const app = buildServer({ token: "test-token", execSpawn: { command: process.execPath, baseArgs: ["run-as-bot.mjs"] } });
    try {
      const headers = { authorization: "Bearer test-token" };
      const allowed = await app.inject({
        method: "POST",
        url: "/exec",
        headers,
        payload: { cmd: "true", cwd: outside, confinePolicy: { allow: [outside], deny: [] } },
      });
      expect(allowed.statusCode).toBe(200);
      expect(spawns.at(-1)?.cwd).toBe(outside);

      const replaced = await app.inject({
        method: "POST",
        url: "/exec",
        headers,
        payload: { cmd: "true", cwd: "/tmp", confinePolicy: { allow: [outside], deny: [] } },
      });
      expect(replaced.statusCode).toBe(400);
      expect(replaced.body).toContain("允许目录");

      const denied = await app.inject({
        method: "POST",
        url: "/exec",
        headers,
        payload: {
          cmd: "true",
          cwd: join(outside, "secret"),
          confinePolicy: { allow: [outside], deny: [join(outside, "secret")] },
        },
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.body).toContain("黑名单");

      const beside = await app.inject({
        method: "POST",
        url: "/exec",
        headers,
        payload: {
          cmd: "true",
          cwd: join(outside, "secret-other"),
          confinePolicy: { allow: [outside], deny: [join(outside, "secret")] },
        },
      });
      expect(beside.statusCode).toBe(200);
      expect(spawns.at(-1)?.cwd).toBe(join(outside, "secret-other"));

      const opened = await app.inject({
        method: "POST",
        url: "/exec",
        headers,
        payload: { cmd: "true", cwd: outside, confine: false, confinePolicy: { allow: ["/home/bot"], deny: [outside] } },
      });
      expect(opened.statusCode).toBe(200);
      expect(spawns.at(-1)?.cwd).toBe(outside);
    } finally {
      await app.close();
    }
  });
});
