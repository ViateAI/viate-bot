import { once } from "node:events";
import net from "node:net";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createClientPeer, createMachinePeer, type BytePipe } from "@viate-bot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { proxyEnvironment, startEgressProxy, type EgressProxy } from "./egress-proxy.js";
import { buildServer } from "./server.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe("machined egress proxy", () => {
  it("passes an absolute ws URL upgrade through the checked target", async () => {
    const upstream = await scripted("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nopaque-websocket-data");
    const proxy = await listen(startEgressProxy({ port: 0, resolve: async () => ["9.9.9.9"], dial: () => net.connect(upstream.port, "127.0.0.1") }));
    const response = await raw(proxy.port, "GET ws://example.com/chat HTTP/1.1\r\nHost: private.internal\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    expect(response.status).toBe(101);
    expect(response.body).toContain("opaque-websocket-data");
    expect(upstream.text()).toMatch(/^GET \/chat HTTP\/1.1\r\n/);
  });

  it("streams a chunked POST with an authoritative Host and does not duplicate writes under backpressure", async () => {
    const expected = Buffer.alloc(2 * 1024 * 1024, 65);
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => res.end(JSON.stringify({ host: req.headers.host, bytes: Buffer.concat(chunks).length })));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    closers.push(async () => { upstream.closeAllConnections(); const done = once(upstream, "close"); upstream.close(); await done; });
    const proxy = await listen(startEgressProxy({ port: 0, resolve: async () => ["9.9.9.9"], dial: () => net.connect((upstream.address() as AddressInfo).port, "127.0.0.1") }));
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const request = http.request({ host: "127.0.0.1", port: proxy.port, path: "http://example.com/upload", method: "POST", headers: { host: "private.internal" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    request.on("error", reject);
    request.write(expected.subarray(0, 1024 * 1024));
    request.end(expected.subarray(1024 * 1024));
    const result = await promise;
    expect(JSON.parse(result)).toEqual({ host: "example.com", bytes: expected.length });
  });

  it("finishes a chunked response without waiting for the upstream TCP connection to close", async () => {
    const upstream = net.createServer((socket) => {
      socket.on("data", () => socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n0\r\n\r\n"));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    closers.push(async () => { const done = once(upstream, "close"); upstream.close(); await done; });
    const proxy = await listen(startEgressProxy({ port: 0, resolve: async () => ["9.9.9.9"], dial: () => net.connect((upstream.address() as AddressInfo).port, "127.0.0.1") }));
    expect(await httpBody(proxy.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")).toBe("ab");
  });

  it("rejects private targets and non-80/443 ports in direct mode", async () => {
    const dialed: Array<{ address: string; port: number }> = [];
    const proxy = await listen(startEgressProxy({
      port: 0,
      resolve: async () => ["9.9.9.9"],
      dial: (address, port) => {
        dialed.push({ address, port });
        return net.connect(1, "127.0.0.1");
      },
    }));
    expect((await raw(proxy.port, "CONNECT 127.0.0.1:7070 HTTP/1.1\r\nHost: 127.0.0.1:7070\r\n\r\n")).status).toBe(403);
    expect((await raw(proxy.port, "CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: 127.0.0.1:80\r\n\r\n")).status).toBe(403);
    expect((await raw(proxy.port, "CONNECT 2130706433:80 HTTP/1.1\r\nHost: 2130706433:80\r\n\r\n")).status).toBe(403);
    expect((await raw(proxy.port, "CONNECT example.com:22 HTTP/1.1\r\nHost: example.com:22\r\n\r\n")).status).toBe(403);
    expect((await raw(proxy.port, "GET http://example.com:8080/ HTTP/1.1\r\nHost: example.com:8080\r\n\r\n")).status).toBe(403);
    expect(dialed).toEqual([]);
  });

  it("dials the resolved public address in direct mode", async () => {
    const upstream = await closingServer();
    const dialed: Array<{ address: string; port: number }> = [];
    const proxy = await listen(startEgressProxy({
      port: 0,
      resolve: async () => ["9.9.9.9"],
      dial(address, port) {
        dialed.push({ address, port });
        return net.connect(upstream.port, "127.0.0.1");
      },
    }));
    const response = await raw(proxy.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    expect(response.status, response.body).toBe(200);
    expect(dialed).toEqual([{ address: "9.9.9.9", port: 443 }]);
  });

  it("returns the offline page and falls back only when configured", async () => {
    const upstream = await scripted("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
    const dialed: string[] = [];
    const proxy = await listen(startEgressProxy({
      port: 0,
      resolve: async () => ["9.9.9.9"],
      dial(address) {
        dialed.push(address);
        return net.connect(upstream.port, "127.0.0.1");
      },
    }));
    proxy.setConfig({ mode: "user_network", offlinePolicy: "pause", deviceOnline: false });
    const paused = await raw(proxy.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect(paused.status).toBe(503);
    expect(paused.body).toContain("用户网络离线，请打开 viate-bot 桌面客户端");
    expect(dialed).toEqual([]);
    proxy.setConfig({ mode: "user_network", offlinePolicy: "fallback_direct", deviceOnline: false });
    const fallback = await raw(proxy.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect(fallback.status).toBe(200);
    expect(fallback.body).toContain("OK");
    expect(dialed).toEqual(["9.9.9.9"]);
  });

  it("decodes a chunked upstream body before writing it to the client", async () => {
    const upstream = await scripted("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n");
    const proxy = await listen(startEgressProxy({
      port: 0,
      resolve: async () => ["9.9.9.9"],
      dial() {
        return net.connect(upstream.port, "127.0.0.1");
      },
    }));
    const body = await httpBody(proxy.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect(body).toBe("abcd");
  });

  it("forwards user_network connections through the peer instead of dialing", async () => {
    const upstream = await scripted("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
    let machineSend: (frame: Buffer) => void = () => undefined;
    const client = createClientPeer(
      (frame) => machineSend(frame),
      async (host, port) => {
        expect(host).toBe("example.com");
        expect(port).toBe(80);
        return { ok: true, pipe: await socketPipe(upstream.port) };
      },
    );
    const machine = createMachinePeer((frame) => client.ingest(frame));
    machineSend = (frame) => machine.ingest(frame);
    const proxy = await listen(startEgressProxy({
      port: 0,
      resolve: async () => {
        throw new Error("隧道模式不应该在机器里解析");
      },
      dial: () => {
        throw new Error("隧道模式不应该直连");
      },
    }));
    proxy.setPeer(machine);
    proxy.setConfig({ mode: "user_network", offlinePolicy: "pause", deviceOnline: true });
    const response = await raw(proxy.port, "GET http://example.com/hello HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect(response.status, response.body).toBe(200);
    expect(response.body).toContain("OK");
    expect(upstream.text()).toContain("GET /hello HTTP/1.1");
    const headers = Object.fromEntries(upstream.text().split("\r\n").slice(1).filter((line) => line.includes(":")).map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
    expect(headers.host).toBe("example.com");
  });

  it("forces proxy variables over the command environment", () => {
    const env = proxyEnvironment(3128, { PATH: "/bin", HTTP_PROXY: "http://evil" }, { https_proxy: "http://also-evil" });
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:3128");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(env.http_proxy).toBe("http://127.0.0.1:3128");
    expect(env.https_proxy).toBe("http://127.0.0.1:3128");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
  });

  it("authenticates /egress and applies a config frame", async () => {
    const proxyPort = await freePort();
    const app = buildServer({ token: "machine-token", egressProxyPort: proxyPort });
    await app.listen({ host: "127.0.0.1", port: 0 });
    closers.push(() => app.close());
    const address = app.server.address() as AddressInfo;
    expect((await raw(proxyPort, "CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: 127.0.0.1:80\r\n\r\n")).status).toBe(503);
    await expect(openSocket(address.port, undefined)).rejects.toThrow();
    const ws = await openSocket(address.port, "machine-token");
    closers.push(async () => {
      ws.terminate();
    });
    ws.send(JSON.stringify({ type: "config", egressMode: "user_network", offlinePolicy: "pause", deviceOnline: false }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paused = await raw(proxyPort, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    expect(paused.status).toBe(503);
  });
});

function listen(proxy: EgressProxy): Promise<EgressProxy> {
  closers.push(() => proxy.close());
  return proxy.ready.then(() => proxy);
}

function httpBody(port: number, payload: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("end", () => {
    const rawText = Buffer.concat(chunks).toString("utf8");
    const split = rawText.indexOf("\r\n\r\n");
    const head = split < 0 ? rawText : rawText.slice(0, split);
    const rest = split < 0 ? "" : rawText.slice(split + 4);
    if (!/transfer-encoding:\s*chunked/i.test(head)) {
      resolve(rest);
      return;
    }
    resolve(decodeChunks(rest));
  });
  socket.on("error", reject);
  return promise;
}

function decodeChunks(body: string): string {
  let rest = body;
  let out = "";
  while (rest.length > 0) {
    const line = rest.indexOf("\r\n");
    if (line < 0) break;
    const size = Number.parseInt(rest.slice(0, line), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += rest.slice(line + 2, line + 2 + size);
    rest = rest.slice(line + 2 + size + 2);
  }
  return out;
}

function raw(port: number, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    const chunks: Buffer[] = [];
    const finish = () => resolve({ status: Number(Buffer.concat(chunks).toString("utf8").split(" ")[1] ?? 0), body: Buffer.concat(chunks).toString("utf8") });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", finish);
    socket.setTimeout(2_000, () => {
      socket.destroy();
      finish();
    });
    socket.on("error", reject);
  });
}

function scripted(response: string): Promise<{ port: number; text: () => string }> {
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      socket.end(response);
    });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      closers.push(() => new Promise((done) => server.close(() => done())));
      resolve({ port: (server.address() as AddressInfo).port, text: () => Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function closingServer(): Promise<{ port: number }> {
  const server = net.createServer((socket) => socket.end());
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      closers.push(() => new Promise((done) => server.close(() => done())));
      resolve({ port: (server.address() as AddressInfo).port });
    });
  });
}

async function socketPipe(port: number): Promise<BytePipe> {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  let onData: (chunk: Buffer) => void = () => undefined;
  let onEnd: () => void = () => undefined;
  let onDrain: () => void = () => undefined;
  socket.on("data", (chunk) => onData(chunk));
  socket.on("end", () => onEnd());
  socket.on("drain", () => onDrain());
  return {
    write(chunk) {
      return socket.write(chunk);
    },
    end() {
      socket.end();
    },
    destroy() {
      socket.destroy();
    },
    pause() {
      socket.pause();
    },
    resume() {
      socket.resume();
    },
    onData(cb) {
      onData = cb;
    },
    onEnd(cb) {
      onEnd = cb;
    },
    onDrain(cb) {
      onDrain = cb;
    },
    onError(cb) {
      socket.on("error", cb);
    },
  };
}

function openSocket(port: number, token: string | undefined): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/egress`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
    ws.once("error", reject);
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
