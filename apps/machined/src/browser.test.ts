import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { buildServer } from "./server.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("browser routes", () => {
  it("reports a stopped browser and rejects the websocket", async () => {
    const app = buildServer({
      token: "test-token",
      browserVersionUrl: "http://127.0.0.1:9/json/version",
    });
    closers.push(() => app.close());
    const headers = { authorization: "Bearer test-token" };
    const denied = await app.inject({ method: "GET", url: "/browser/status" });
    expect(denied.statusCode).toBe(401);
    const status = await app.inject({ method: "GET", url: "/browser/status", headers });
    expect(status.json()).toEqual({ running: false, version: null });
    const http = await app.inject({ method: "GET", url: "/browser/cdp", headers });
    expect(http.statusCode).toBe(503);
    expect(http.json()).toEqual({ error: "Chromium 尚未就绪" });

    const port = await listen(app);
    const unauthenticated = await expectUpgrade(`ws://127.0.0.1:${port}/browser/cdp`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toContain("未认证");
    const unavailable = await expectUpgrade(`ws://127.0.0.1:${port}/browser/cdp`, headers);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toContain("Chromium 尚未就绪");
  }, 15_000);

  it("proxies browser CDP and refuses a non-local debugger url", async () => {
    const received: string[] = [];
    const fake = await startFake(received);
    const app = buildServer({
      token: "test-token",
      browserVersionUrl: `http://127.0.0.1:${fake.port}/json/version`,
      browserDebugPort: fake.port,
    });
    closers.push(async () => {
      await app.close();
      await fake.close();
    });
    fake.setBody({
      Browser: "Chrome/1.2.3",
      webSocketDebuggerUrl: `ws://127.0.0.1:${fake.port}/devtools/browser/test`,
    });
    const headers = { authorization: "Bearer test-token" };
    const status = await app.inject({ method: "GET", url: "/browser/status", headers });
    expect(status.json()).toEqual({ running: true, version: "Chrome/1.2.3" });
    const upgrade = await app.inject({ method: "GET", url: "/browser/cdp", headers });
    expect(upgrade.statusCode).toBe(426);

    const port = await listen(app);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/browser/cdp`, { headers });
    const messages: string[] = [];
    const echoed = new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => {
        messages.push(data.toString());
        if (messages.some((item) => item.includes("echoed"))) resolve();
      });
      ws.once("error", reject);
      ws.once("close", () => {
        if (!messages.some((item) => item.includes("echoed"))) reject(new Error("CDP 在回包前关闭"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ id: 7, method: "Browser.getVersion" }));
    await echoed;
    expect(messages.some((item) => item.includes("targetCreated"))).toBe(true);
    expect(messages.some((item) => item.includes("Browser.getVersion"))).toBe(true);
    expect(received.some((item) => item.includes("Browser.getVersion"))).toBe(true);
    ws.close();

    fake.setBody({
      Browser: "Chrome/9",
      webSocketDebuggerUrl: "ws://1.2.3.4:9222/devtools/browser/x",
    });
    const refused = await app.inject({ method: "GET", url: "/browser/cdp", headers });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: "Chromium 调试端点不在本机" });
    const stillRunning = await app.inject({ method: "GET", url: "/browser/status", headers });
    expect(stillRunning.json()).toEqual({ running: true, version: "Chrome/9" });
  });

  it("restarts through the injected hook", async () => {
    let calls = 0;
    const app = buildServer({
      token: "test-token",
      restartBrowser: async () => {
        calls += 1;
      },
    });
    closers.push(() => app.close());
    const headers = { authorization: "Bearer test-token" };
    const ok = await app.inject({ method: "POST", url: "/browser/restart", headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(calls).toBe(1);
    const failing = buildServer({
      token: "test-token",
      restartBrowser: async () => {
        throw new Error("no");
      },
    });
    closers.push(() => failing.close());
    const failed = await failing.inject({ method: "POST", url: "/browser/restart", headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error).toContain("重启 Chromium 失败");
  });

  it("closes while a CDP client is still connected", async () => {
    const fake = await startFake([]);
    const app = buildServer({
      token: "test-token",
      browserVersionUrl: `http://127.0.0.1:${fake.port}/json/version`,
      browserDebugPort: fake.port,
    });
    fake.setBody({
      Browser: "Chrome/1.2.3",
      webSocketDebuggerUrl: `ws://127.0.0.1:${fake.port}/devtools/browser/test`,
    });
    const port = await listen(app);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/browser/cdp`, {
      headers: { authorization: "Bearer test-token" },
    });
    const clientClosed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const upstreamGone = fake.whenEmpty();
      await app.close();
      await clientClosed;
      await upstreamGone;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
      expect(fake.clients()).toBe(0);
    } finally {
      ws.terminate();
      await app.close().catch(() => undefined);
      await fake.close();
    }
  });

  it("closes while the debugger version lookup is still in flight", async () => {
    let releaseVersion: () => void = () => undefined;
    const versionHeld = new Promise<void>((resolve) => {
      releaseVersion = resolve;
    });
    let sawVersion: () => void = () => undefined;
    const versionSeen = new Promise<void>((resolve) => {
      sawVersion = resolve;
    });
    const upstream = new WebSocketServer({ noServer: true });
    const server = createServer((request, response) => {
      if (!request.url?.startsWith("/json/version")) {
        response.statusCode = 404;
        response.end();
        return;
      }
      sawVersion();
      void versionHeld.then(() => {
        if (response.writableEnded) return;
        response.setHeader("content-type", "application/json");
        response.end(body);
      });
    });
    server.on("upgrade", (request, socket, head) => {
      upstream.handleUpgrade(request, socket, head, () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const fakePort = (server.address() as AddressInfo).port;
    const body = JSON.stringify({
      Browser: "Chrome/1.2.3",
      webSocketDebuggerUrl: `ws://127.0.0.1:${fakePort}/devtools/browser/test`,
    });
    const app = buildServer({
      token: "test-token",
      browserVersionUrl: `http://127.0.0.1:${fakePort}/json/version`,
      browserDebugPort: fakePort,
    });
    const port = await listen(app);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/browser/cdp`, {
      headers: { authorization: "Bearer test-token" },
    });
    ws.on("error", () => undefined);
    const clientClosed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    try {
      await versionSeen;
      const closed = app.close();
      releaseVersion();
      await closed;
      await clientClosed;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
      expect(upstream.clients.size).toBe(0);
    } finally {
      releaseVersion();
      ws.terminate();
      await app.close().catch(() => undefined);
      for (const client of upstream.clients) client.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

async function listen(app: ReturnType<typeof buildServer>): Promise<number> {
  if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("没有监听端口");
  return address.port;
}

function expectUpgrade(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
    ws.on("error", () => undefined);
    ws.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("不应该升级成功"));
    });
  });
}

async function startFake(received: string[]): Promise<{
  port: number;
  setBody: (body: unknown) => void;
  clients: () => number;
  whenEmpty: () => Promise<void>;
  close: () => Promise<void>;
}> {
  let body: unknown = {};
  const server: Server = createServer((request, response) => {
    if (request.url?.startsWith("/json/version")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => {
      client.send(JSON.stringify({ method: "Target.targetCreated", params: { targetId: "pushed" } }));
      client.on("message", (data) => {
        const text = data.toString();
        received.push(text);
        const message = JSON.parse(text) as { id?: number; method?: string };
        client.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    setBody: (next) => {
      body = next;
    },
    clients: () => wss.clients.size,
    whenEmpty: () => {
      if (wss.clients.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = () => {
          if (wss.clients.size === 0) resolve();
        };
        for (const client of wss.clients) client.on("close", check);
      });
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
