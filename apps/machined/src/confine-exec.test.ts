import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type * as ChildProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";

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
    const outside = mkdtempSync(join(tmpdir(), "vb-cwd-"));
    dirs.push(outside);
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
      await app.close();
    }
  });
});
