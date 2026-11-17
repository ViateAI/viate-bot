import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCli } from "./cli.js";
import { writeTokenFile } from "./token.js";
import { readClientConfig, writeClientConfig } from "./config.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("egress cli", () => {
  it("keeps the CLI alive and reconnects after the WebSocket closes", async () => {
    // A child process must survive the actual Node event-loop idle check; fake timers cannot prove that.
    const dir = mkdtempSync(join(tmpdir(), "vb-egress-cli-"));
    dirs.push(dir);
    const token = join(dir, "token");
    writeTokenFile(token, "test-token");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("没有监听端口");
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "run", "--base", `http://127.0.0.1:${address.port}`, "--token-file", token, "--config", join(dir, "config.json")], { stdio: "ignore" });
    let connections = 0;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.on("connection", (socket) => {
      connections++;
      if (connections === 1) socket.close();
      else resolve();
    });
    child.once("exit", () => reject(new Error("客户端在重连前退出")));
    try { await promise; }
    finally {
      const exited = child.exitCode !== null ? Promise.resolve() : once(child, "exit");
      child.kill("SIGTERM");
      for (const socket of server.clients) socket.terminate();
      const closed = once(server, "close");
      server.close();
      await Promise.all([exited, closed]);
    }
  });

  it("defaults fake-IP off and persists only an explicit choice", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-egress-config-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    expect(readClientConfig(path).allowFakeIp).toBe(false);
    expect(parseCli(["run"]).allowFakeIp).toBeUndefined();
    expect(parseCli(["run", "--allow-fake-ip"]).allowFakeIp).toBe(true);
    writeClientConfig(path, { allowFakeIp: true });
    expect(readClientConfig(path).allowFakeIp).toBe(true);
    writeClientConfig(path, { allowFakeIp: false });
    expect(readClientConfig(path).allowFakeIp).toBe(false);
  });

  it("does not enable the private allow list unless the flag is present", () => {
    expect(parseCli(["run", "--base", "http://127.0.0.1:4418"]).allowPrivate).toBeUndefined();
    expect(() => parseCli(["run", "--base", "http://127.0.0.1:4418", "--allow-private"])).toThrow(/显式/);
    expect(parseCli(["run", "--allow-private", "10.1.2.3"]).allowPrivate).toEqual(["10.1.2.3"]);
  });

  it("writes the token file with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-egress-token-"));
    dirs.push(dir);
    const path = join(dir, "nested", "token");
    writeTokenFile(path, "secret-token");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
