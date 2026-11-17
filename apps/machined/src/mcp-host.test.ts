import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { assertMcpRemoteUrl, createMcpHost, registerMcpRoutes, type McpHost } from "./mcp-host.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "vb-mcp-"));
  dirs.push(dir);
  return dir;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(address.port);
    });
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.filter((item): item is Buffer => item instanceof Buffer)).toString("utf8");
  return "";
}

function stdioScript(home: string): void {
  writeFileSync(join(home, "server.mjs"), `#!/usr/bin/env node
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let index = buf.indexOf("\\n");
  while (index >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    index = buf.indexOf("\\n");
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const text = msg.params && msg.params.arguments ? String(msg.params.arguments.text ?? "") : "";
    const result = msg.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local", version: "0" } }
      : msg.method === "tools/list"
        ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`);
  chmodSync(join(home, "server.mjs"), 0o755);
}

describe("mcp host", () => {
  it("lists and calls a local stdio tool, including over an authenticated websocket", async () => {
    const home = temp();
    stdioScript(home);
    const host = createMcpHost({ homeDir: home, timeoutMs: 3_000 });
    const app = Fastify({ logger: false });
    registerMcpRoutes(app, host, { token: "tok" });
    let socket: WebSocket | undefined;
    try {
      await host.startStdio("local", { command: "./server.mjs", args: ["bash"], cwd: home });
      expect(await host.call("local", "tools/list", {})).toMatchObject({ tools: [{ name: "echo" }] });
      expect(await host.call("local", "tools/call", { name: "echo", arguments: { text: "hi" } })).toEqual({
        content: [{ type: "text", text: "hi" }],
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const url = `ws://127.0.0.1:${address.port}/mcp/local`;
      const denied = new WebSocket(url);
      const deniedOutcome = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 3_000);
        const done = (value: string): void => {
          clearTimeout(timer);
          resolve(value);
        };
        denied.once("open", () => done("open"));
        denied.once("error", () => done("error"));
        denied.once("close", () => done("close"));
      });
      denied.terminate();
      expect(deniedOutcome === "error" || deniedOutcome === "close").toBe(true);
      socket = new WebSocket(url, { headers: { authorization: "Bearer tok" } });
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", () => resolve());
        socket?.once("error", reject);
      });
      const result = await new Promise<unknown>((resolve, reject) => {
        socket?.once("message", (data) => resolve(JSON.parse(messageText(data)) as unknown));
        socket?.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }));
        setTimeout(() => reject(new Error("websocket timeout")), 3_000);
      });
      expect(result).toMatchObject({ id: 7, result: { tools: [{ name: "echo" }] } });
    } finally {
      socket?.close();
      await app.close();
      await host.close();
    }
  }, 20_000);

  it("keeps a remote call unconfirmed when the local request times out", async () => {
    // 产品超时是真实时钟；这里等的是 status，不是猜一个睡眠当成功。
    const remote = createServer((request, response) => {
      void readBody(request).then((body) => {
        const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
        if (message.method === "tools/call") return;
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "0" } },
        }));
      });
    });
    const host = createMcpHost({ timeoutMs: 80 });
    try {
      const port = await listen(remote);
      await host.startRemote("remote", { url: `http://127.0.0.1:${port}/mcp` });
      let settled = false;
      const pending = host.call("remote", "tools/call", { name: "echo", arguments: { text: "x" } }).finally(() => {
        settled = true;
      });
      const deadline = Date.now() + 1000;
      while ((host.status("remote")?.unconfirmed.length ?? 0) === 0) {
        if (Date.now() > deadline) throw new Error("没有进入未确认");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(settled).toBe(false);
      await host.stop("remote");
      await expect(pending).rejects.toThrow(/remote_unconfirmed/);
    } finally {
      await host.close();
      await stop(remote);
    }
  }, 20_000);

  it("keeps a tool call unconfirmed when the server accepts it and then drops the connection", async () => {
    let calls = 0;
    const remote = createServer((request, response) => {
      void readBody(request).then((body) => {
        const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
        if (message.method === "tools/call") {
          calls += 1;
          request.socket.destroy();
          return;
        }
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "0" } },
        }));
      });
    });
    const host = createMcpHost({ timeoutMs: 1_000 });
    try {
      const port = await listen(remote);
      await host.startRemote("remote", { url: `http://127.0.0.1:${port}/mcp` });
      let settled = false;
      const pending = host.call("remote", "tools/call", { name: "echo", arguments: { text: "x" } }).finally(() => {
        settled = true;
      });
      const deadline = Date.now() + 1_000;
      while ((host.status("remote")?.unconfirmed.length ?? 0) === 0) {
        if (Date.now() > deadline) throw new Error("没有进入未确认");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(calls).toBe(1);
      expect(settled).toBe(false);
      await host.stop("remote");
      await expect(pending).rejects.toThrow(/remote_unconfirmed/);
    } finally {
      await host.close();
      await stop(remote);
    }
  }, 20_000);

  it("does not hold initialize when the server refuses the connection", async () => {
    const host = createMcpHost({ timeoutMs: 1_000 });
    try {
      await expect(host.startRemote("remote", { url: "http://127.0.0.1:1/mcp" })).rejects.toThrow();
      expect(host.status("remote")?.unconfirmed ?? []).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("reports a complete JSON-RPC error as a failed tool call instead of unconfirmed", async () => {
    const remote = createServer((request, response) => {
      void readBody(request).then((body) => {
        const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        const result = message.method === "tools/call"
          ? { error: { code: -32000, message: "工具拒绝" } }
          : { result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "0" } } };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...result }));
      });
    });
    const host = createMcpHost({ timeoutMs: 1_000 });
    try {
      const port = await listen(remote);
      await host.startRemote("remote", { url: `http://127.0.0.1:${port}/mcp` });
      await expect(host.call("remote", "tools/call", { name: "echo", arguments: {} })).rejects.toThrow(/MCP 调用失败/);
      expect(host.status("remote")?.unconfirmed ?? []).toEqual([]);
    } finally {
      await host.close();
      await stop(remote);
    }
  });

  it("keeps a tool call unconfirmed when the response is not a matching JSON-RPC result", async () => {
    const cases = [
      { status: 202, body: "" },
      { status: 200, body: "" },
      { status: 200, body: "{}" },
      { status: 200, body: JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }) },
      { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: "other", error: { code: -32000, message: "别的请求" } }) },
    ];
    for (const item of cases) {
      let calls = 0;
      const remote = createServer((request, response) => {
        void readBody(request).then((body) => {
          const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
          if (message.method === "tools/call") {
            calls += 1;
            response.writeHead(item.status, { "content-type": "application/json" });
            response.end(item.body);
            return;
          }
          if (message.id === undefined) {
            response.writeHead(202);
            response.end();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "0" } } }));
        });
      });
      const host = createMcpHost({ timeoutMs: 1_000 });
      try {
        const port = await listen(remote);
        await host.startRemote("remote", { url: `http://127.0.0.1:${port}/mcp` });
        let settled = false;
        const pending = host.call("remote", "tools/call", { name: "echo", arguments: {} }).finally(() => { settled = true; });
        const deadline = Date.now() + 1_000;
        while ((host.status("remote")?.unconfirmed.length ?? 0) === 0) {
          if (Date.now() > deadline) throw new Error(`没有进入未确认 ${item.status}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(calls).toBe(1);
        expect(settled).toBe(false);
        await host.stop("remote");
        await expect(pending).rejects.toThrow(/remote_unconfirmed/);
      } finally {
        await host.close();
        await stop(remote);
      }
    }
  }, 20_000);

  it("kills only the timed-out owner and does not wait for a cancel response", async () => {
    const home = temp();
    const marker = join(home, "boots");
    const cancelled = join(home, "cancelled");
    writeFileSync(join(home, "server.mjs"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let index = buf.indexOf("\\n");
  while (index >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    index = buf.indexOf("\\n");
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "notifications/cancelled") {
      appendFileSync(${JSON.stringify(cancelled)}, "x");
      continue;
    }
    if (msg.id === undefined) continue;
    const text = msg.params && msg.params.arguments ? String(msg.params.arguments.text ?? "") : "";
    if (text === "hold") continue;
    const result = msg.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local", version: "0" } }
      : { content: [{ type: "text", text }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`);
    chmodSync(join(home, "server.mjs"), 0o755);
    const host = createMcpHost({ homeDir: home, timeoutMs: 150 });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await host.startStdio("task-a", { command: "./server.mjs", cwd: home });
      await host.startStdio("task-b", { command: "./server.mjs", cwd: home });
      const [pidA, pidB] = readFileSync(marker, "utf8").trim().split("\n").map((line) => Number(line));
      const held = host.call("task-a", "tools/call", { name: "echo", arguments: { text: "hold" } });
      await expect(host.call("task-b", "tools/call", { name: "echo", arguments: { text: "ok" } })).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
      });
      await expect(held).rejects.toThrow(/退出/);
      expect(alive(pidA!)).toBe(false);
      expect(alive(pidB!)).toBe(true);
      expect(existsSync(cancelled)).toBe(false);
      await host.stop("task-b");
      expect(alive(pidB!)).toBe(false);
    } finally {
      await host.close();
    }
  }, 20_000);

  it("keeps a shared session until the last ref stops and does not stop a different server", async () => {
    const home = temp();
    const marker = join(home, "boots");
    writeFileSync(join(home, "server.mjs"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, process.pid + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let index = buf.indexOf("\\n");
  while (index >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    index = buf.indexOf("\\n");
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const text = msg.params && msg.params.arguments ? String(msg.params.arguments.text ?? "") : "";
    const result = msg.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local", version: "0" } }
      : { content: [{ type: "text", text }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`);
    chmodSync(join(home, "server.mjs"), 0o755);
    const host = createMcpHost({ homeDir: home, timeoutMs: 3_000 });
    try {
      await host.startStdio("alpha", { command: "./server.mjs", cwd: home });
      await host.startStdio("alpha", { command: "./server.mjs", cwd: home });
      await host.startStdio("beta", { command: "./server.mjs", cwd: home });
      const boots = readFileSync(marker, "utf8").trim().split("\n");
      expect(boots).toHaveLength(2);
      await host.stop("alpha");
      expect(await host.call("alpha", "tools/call", { name: "echo", arguments: { text: "still" } })).toEqual({
        content: [{ type: "text", text: "still" }],
      });
      expect(await host.call("beta", "tools/call", { name: "echo", arguments: { text: "other" } })).toEqual({
        content: [{ type: "text", text: "other" }],
      });
      await host.stop("alpha");
      await expect(host.call("alpha", "tools/call", { name: "echo", arguments: { text: "gone" } })).rejects.toThrow();
      expect(await host.call("beta", "tools/call", { name: "echo", arguments: { text: "kept" } })).toEqual({
        content: [{ type: "text", text: "kept" }],
      });
    } finally {
      await host.close();
    }
  }, 20_000);

  it("dials loopback http without following redirects or expanding placeholders", async () => {
    const seen: { url: string; header: string; session: string } = { url: "", header: "", session: "" };
    const remote = createServer((request, response) => {
      void readBody(request).then((body) => {
        const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
        seen.url = request.url ?? "";
        seen.header = String(request.headers["x-test"] ?? "");
        if (message.method === "tools/list") seen.session = String(request.headers["mcp-session-id"] ?? "");
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "0" } }
          : { tools: [{ name: "echo" }] };
        response.writeHead(200, {
          "content-type": "application/json",
          ...(message.method === "initialize" ? { "mcp-session-id": "sess-1" } : {}),
        });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    const home = temp();
    const host = createMcpHost({ homeDir: home, timeoutMs: 3_000 });
    try {
      const port = await listen(remote);
      await host.startRemote("remote", {
        url: `http://127.0.0.1:${port}/mcp/\${PLUGIN_ROOT}`,
        headers: { "X-Test": "${PLUGIN_ROOT}" },
      });
      expect(seen.header).toBe("${PLUGIN_ROOT}");
      expect(seen.url).toContain("PLUGIN_ROOT");
      expect(seen.url).not.toContain(home);
      expect(await host.call("remote", "tools/list", {})).toMatchObject({ tools: [{ name: "echo" }] });
      expect(seen.session).toBe("sess-1");
    } finally {
      await host.close();
      await stop(remote);
    }
  }, 20_000);

  it("drops Authorization and injected headers on a cross-origin redirect", async () => {
    const secret = "header-secret-value";
    const landed: { token: string; authorization: string; trace: string; url: string } = { token: "", authorization: "", trace: "", url: "" };
    const next = createServer((request, response) => {
      void readBody(request).then((body) => {
        const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
        landed.token = String(request.headers["x-api-token"] ?? "");
        landed.authorization = String(request.headers.authorization ?? "");
        landed.trace = String(request.headers["x-trace"] ?? "");
        landed.url = request.url ?? "";
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "landed", version: "0" } }
          : { tools: [{ name: "echo" }] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    let firstToken = "";
    const first = createServer((request, response) => {
      request.resume();
      firstToken = String(request.headers["x-api-token"] ?? "");
      response.writeHead(302, { location: "" });
      response.end();
    });
    const host = createMcpHost({ timeoutMs: 3_000 });
    try {
      const nextPort = await listen(next);
      const redirectTo = `http://127.0.0.1:${nextPort}/mcp`;
      first.removeAllListeners("request");
      first.on("request", (request, response) => {
        request.resume();
        firstToken = String(request.headers["x-api-token"] ?? "");
        response.writeHead(302, { location: redirectTo });
        response.end();
      });
      const port = await listen(first);
      await host.startRemote("remote", {
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "X-Trace": "kept", Authorization: "Bearer literal-token", "X-Api-Token": secret },
        injectedHeaders: ["X-Api-Token"],
      });
      expect(firstToken).toBe(secret);
      expect(landed.token).toBe("");
      expect(landed.authorization).toBe("");
      expect(landed.trace).toBe("kept");
      expect(landed.url).not.toContain(secret);
      expect(await host.call("remote", "tools/list", {})).toMatchObject({ tools: [{ name: "echo" }] });
      expect(landed.token).toBe("");
      expect(landed.authorization).toBe("");
      let kept = "";
      const same = createServer((request, response) => {
        void readBody(request).then((body) => {
          const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
          if (request.url === "/mcp") {
            response.writeHead(302, { location: "/landed" });
            response.end();
            return;
          }
          kept = String(request.headers["x-api-token"] ?? "");
          if (message.id === undefined) {
            response.writeHead(202);
            response.end();
            return;
          }
          const result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "same", version: "0" } };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        });
      });
      const samePort = await listen(same);
      await host.startRemote("same", {
        url: `http://127.0.0.1:${samePort}/mcp`,
        headers: { "X-Api-Token": secret },
        injectedHeaders: ["X-Api-Token"],
      });
      expect(kept).toBe(secret);
      await stop(same);
    } finally {
      await host.close();
      await stop(first);
      await stop(next);
    }
  }, 20_000);

  it("refuses a public http URL before any connection", async () => {
    let called = 0;
    const host = createMcpHost({
      fetchImpl: async () => {
        called += 1;
        throw new Error("called");
      },
    });
    try {
      await expect(host.startRemote("public", { url: "http://example.com/mcp" })).rejects.toThrow(/HTTPS/);
      expect(called).toBe(0);
      expect(() => assertMcpRemoteUrl("http://user:pass@127.0.0.1/mcp")).toThrow(/无效/);
      expect(() => assertMcpRemoteUrl("http://127.0.0.1/mcp#x")).toThrow(/无效/);
      expect(assertMcpRemoteUrl("https://example.com/mcp").protocol).toBe("https:");
    } finally {
      await host.close();
    }
  });

  it("reads tool results from a same-origin sse stream", async () => {
    let stream: ServerResponse | undefined;
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        stream = response;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      void readBody(request).then((body) => {
        const message = JSON.parse(body || "{}") as { id?: unknown; method?: string };
        if (message.id !== undefined && stream) {
          const result = message.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "sse", version: "0" } }
            : { tools: [{ name: "ping" }] };
          stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
        }
        response.writeHead(202);
        response.end();
      });
    });
    const host: McpHost = createMcpHost({ timeoutMs: 3_000 });
    try {
      const port = await listen(server);
      await host.startRemote("sse", { url: `http://127.0.0.1:${port}/sse`, transport: "sse" });
      expect(await host.call("sse", "tools/list", {})).toMatchObject({ tools: [{ name: "ping" }] });
    } finally {
      await host.close();
      await stop(server);
    }
  }, 20_000);
});
