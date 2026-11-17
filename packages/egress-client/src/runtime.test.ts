import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { encodeEgressFrame } from "@viate-bot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { bindDevice, localDay, startEgressClient, type EgressClientEvent } from "./client.js";
import type { TokenStore } from "./token.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function listen(): Promise<{ port: number; server: WebSocketServer }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("没有监听端口");
  closers.push(async () => {
    for (const socket of server.clients) socket.terminate();
    const closed = once(server, "close");
    server.close();
    await closed;
  });
  return { port: address.port, server };
}

function nextSocket(server: WebSocketServer): Promise<WebSocket> {
  const { promise, resolve } = Promise.withResolvers<WebSocket>();
  server.once("connection", resolve);
  return promise;
}
describe("egress client runtime", () => {
  it("pauses without reconnecting and resumes on request", async () => {
    const { port, server } = await listen();
    let connections = 0;
    server.on("connection", () => {
      connections += 1;
    });
    let mark: (phase: string) => void = () => undefined;
    const nextPhase = (want: string) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      mark = (phase) => {
        if (phase === want) resolve();
      };
      return promise;
    };
    const client = startEgressClient({ url: `ws://127.0.0.1:${port}/client/egress`, token: "t" });
    closers.push(() => client.close());
    client.subscribe((event) => {
      if (event.type !== "status") return;
      mark(event.phase);
    });
    const online = nextPhase("online");
    await online;
    client.pause();
    await nextPhase("paused");
    // 首次重连是 1 秒。要用真实时钟：假时钟驱不动已经建立的 WebSocket。
    const { promise: quiet, resolve: quietDone } = Promise.withResolvers<void>();
    setTimeout(quietDone, 1200);
    await quiet;
    expect(server.clients.size).toBe(0);
    expect(connections).toBe(1);
    expect(client.snapshot().phase).toBe("paused");
    const resumed = nextPhase("online");
    client.resume();
    await resumed;
    expect(client.snapshot().phase).toBe("online");
  });

  it("reports the fake-ip choice on the next connection", async () => {
    const { port, server } = await listen();
    const headers: string[] = [];
    server.on("connection", (socket, request) => {
      headers.push(String(request.headers["x-vb-allow-fake-ip"]));
    });
    const client = startEgressClient({ url: `ws://127.0.0.1:${port}/client/egress`, token: "t", allowFakeIp: false });
    closers.push(() => client.close());
    await nextSocket(server);
    const again = nextSocket(server);
    client.setAllowFakeIp(true);
    await again;
    expect(headers).toEqual(["false", "true"]);
    expect(client.snapshot().allowFakeIp).toBe(true);
  });

  it("counts transferred bytes, rolls the day, and emits only the failure category", async () => {
    const { port, server } = await listen();
    let echoed = false;
    const tcp = net.createServer((socket) => {
      socket.on("data", () => {
        if (echoed) return;
        echoed = true;
        socket.write(Buffer.from("down"));
      });
    });
    tcp.listen(0, "127.0.0.1");
    await once(tcp, "listening");
    const tcpAddress = tcp.address();
    if (!tcpAddress || typeof tcpAddress === "string") throw new Error("没有监听端口");
    closers.push(async () => {
      const closed = once(tcp, "close");
      tcp.close();
      await closed;
    });
    let now = new Date(2026, 10, 17, 12, 0, 0);
    const events: EgressClientEvent[] = [];
    const client = startEgressClient({
      url: `ws://127.0.0.1:${port}/client/egress`,
      token: "t",
      now: () => now,
      initialStats: { day: localDay(now), bytes: 5 },
      resolve: async () => ["1.1.1.1"],
      connect: () => net.connect(tcpAddress.port, "127.0.0.1"),
    });
    closers.push(() => client.close());
    const socket = await nextSocket(server);
    expect(client.snapshot().bytesToday).toBe(5);
    const { promise: opened, resolve: openedDone } = Promise.withResolvers<void>();
    const { promise: uploaded, resolve: uploadedDone } = Promise.withResolvers<void>();
    const { promise: rolled, resolve: rolledDone } = Promise.withResolvers<void>();
    const { promise: blocked, resolve: blockedDone } = Promise.withResolvers<void>();
    socket.on("message", (data) => {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (frame[0] === 2) openedDone();
    });
    client.subscribe((event) => {
      events.push(event);
      if (event.type === "stats" && event.bytesToday === 11) uploadedDone();
      if (event.type === "stats" && event.day === "2026-11-18" && event.bytesToday === 1) rolledDone();
      if (event.type === "dial") blockedDone();
    });
    socket.send(encodeEgressFrame({ type: "OPEN", streamId: 1, host: "example.com", port: 443 }));
    await opened;
    socket.send(encodeEgressFrame({ type: "DATA", streamId: 1, payload: Buffer.from("up") }));
    await uploaded;
    now = new Date(2026, 10, 18, 0, 1, 0);
    socket.send(encodeEgressFrame({ type: "DATA", streamId: 1, payload: Buffer.from("z") }));
    await rolled;
    socket.send(encodeEgressFrame({ type: "OPEN", streamId: 2, host: "10.9.8.7", port: 443 }));
    await blocked;
    const dial = events.find((event) => event.type === "dial");
    expect(dial).toEqual({ type: "dial", category: "blocked" });
    expect(JSON.stringify(events)).not.toContain("10.9.8.7");
    expect(JSON.stringify(events)).not.toContain("example.com");
  });

  it("stores the device token through the supplied store and refuses a failed write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-egress-store-"));
    dirs.push(dir);
    const tokenFile = join(dir, "token");
    let saved: string | null = null;
    const store: TokenStore = {
      read: () => saved,
      write(token) {
        saved = token;
      },
      clear() {
        saved = null;
      },
    };
    const bound = await bindDevice({
      baseUrl: "http://127.0.0.1:9",
      deviceName: "desk",
      tokenStore: store,
      fetchImpl: async () => Response.json({ token: "device-token", deviceId: "device-1" }),
      onUrl(url) {
        const link = new URL(url);
        const port = link.searchParams.get("redirect_port");
        const state = link.searchParams.get("state");
        void fetch(`http://127.0.0.1:${port}/callback?code=one&state=${state}`);
      },
    });
    expect(bound.deviceId).toBe("device-1");
    expect(saved).toBe("device-token");
    expect(() => statSync(tokenFile)).toThrow();

    const fileBound = await bindDevice({
      baseUrl: "http://127.0.0.1:9",
      deviceName: "cli",
      tokenFile,
      fetchImpl: async () => Response.json({ token: "file-token", deviceId: "device-2" }),
      onUrl(url) {
        const link = new URL(url);
        void fetch(`http://127.0.0.1:${link.searchParams.get("redirect_port")}/callback?code=two&state=${link.searchParams.get("state")}`);
      },
    });
    expect(fileBound.deviceId).toBe("device-2");
    expect(readFileSync(tokenFile, "utf8")).toBe("file-token");
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

    await expect(bindDevice({
      baseUrl: "http://127.0.0.1:9",
      deviceName: "desk",
      tokenFile: join(dir, "should-not-exist"),
      tokenStore: {
        read: () => null,
        write() {
          throw new Error("系统加密不可用，已拒绝保存设备令牌");
        },
        clear() {
          return undefined;
        },
      },
      fetchImpl: async () => Response.json({ token: "secret", deviceId: "device-3" }),
      onUrl(url) {
        const link = new URL(url);
        void fetch(`http://127.0.0.1:${link.searchParams.get("redirect_port")}/callback?code=three&state=${link.searchParams.get("state")}`);
      },
    })).rejects.toThrow(/系统加密不可用/);
    expect(() => statSync(join(dir, "should-not-exist"))).toThrow();
  });
});
