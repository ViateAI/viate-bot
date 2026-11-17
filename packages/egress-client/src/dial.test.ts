import net from "node:net";
import { allowPrivatePredicate } from "@viate-bot/protocol";
import { describe, expect, it } from "vitest";
import { dialTarget } from "./dial.js";

const blocked = [
  "127.0.0.1",
  "2130706433",
  "0177.0.0.1",
  "127.1",
  "0x7f.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "10.0.0.1",
  "192.168.1.1",
  "100.64.0.1",
];

describe("client dial target checks", () => {
  it("settles a socket that closes before connecting", async () => {
    let settled = false;
    const result = dialTarget("8.8.8.8", 80, { connect() {
      const socket = new net.Socket();
      queueMicrotask(() => socket.destroy());
      return socket;
    } });
    void result.then(() => { settled = true; });
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ ok: false, code: "connect" });
  });

  it("allows fake-IP only with explicit opt-in, without allowing other private destinations", async () => {
    const blockedFake = await dialTarget("fake.example", 80, { resolve: async () => ["198.18.1.2"] });
    expect(blockedFake).toMatchObject({ ok: false, code: "blocked", message: expect.stringContaining("--allow-fake-ip") });
    for (const addresses of [["10.0.0.1"], ["192.168.1.1"], ["127.0.0.1"], ["::1"], ["198.18.1.2", "192.168.1.1"]]) {
      expect(await dialTarget("mixed.example", 80, { resolve: async () => addresses, allowFakeIp: true })).toMatchObject({ ok: false, code: "blocked" });
    }
    const server = net.createServer((socket) => socket.end());
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", resolve);
    await promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("没有监听端口");
    try {
      const result = await dialTarget("fake.example", 80, { allowFakeIp: true, resolve: async () => ["198.18.1.2"], connect: () => net.connect(address.port, "127.0.0.1") });
      expect(result).toMatchObject({ ok: true, address: "198.18.1.2" });
      if (result.ok) result.pipe.destroy();
    } finally { server.close(); }
  });

  it("refuses private literals and does not connect", async () => {
    for (const host of blocked) {
      let dialed = false;
      const result = await dialTarget(host, 80, {
        connect() {
          dialed = true;
          return net.connect(1, "127.0.0.1");
        },
      });
      expect(result.ok, host).toBe(false);
      expect(dialed, host).toBe(false);
    }
  });

  it("refuses a name that resolves to a private address", async () => {
    let dialed = false;
    const result = await dialTarget("home.example", 443, {
      resolve: async () => ["10.1.2.3"],
      connect() {
        dialed = true;
        return net.connect(1, "127.0.0.1");
      },
    });
    expect(result.ok).toBe(false);
    expect(dialed).toBe(false);
  });

  it("dials the resolved public address, not the hostname", async () => {
    const server = net.createServer((socket) => socket.end());
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("没有监听端口");
    const port = bound.port;
    const seen: string[] = [];
    try {
      const result = await dialTarget("public.example", 443, {
        resolve: async () => ["8.8.8.8"],
        connect(address, target) {
          seen.push(`${address}:${target}`);
          return net.connect(port, "127.0.0.1");
        },
      });
      expect(result.ok).toBe(true);
      expect(seen).toEqual(["8.8.8.8:443"]);
    } finally {
      server.close();
    }
  });

  it("allows a private address only when the predicate is passed in", async () => {
    const implicit = await dialTarget("10.9.8.7", 80, { resolve: async () => ["10.9.8.7"] });
    expect(implicit.ok).toBe(false);
    const server = net.createServer((socket) => socket.end());
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("没有监听端口");
    const port = bound.port;
    const seen: string[] = [];
    try {
      const result = await dialTarget("10.9.8.7", 80, {
        allowPrivate: allowPrivatePredicate(["10.9.8.7"]),
        connect(address) {
          seen.push(address);
          return net.connect(port, "127.0.0.1");
        },
      });
      expect(result.ok).toBe(true);
      expect(seen).toEqual(["10.9.8.7"]);
    } finally {
      server.close();
    }
  });

  it("refuses ports other than 80 and 443", async () => {
    let dialed = false;
    const result = await dialTarget("8.8.8.8", 22, {
      connect() {
        dialed = true;
        return net.connect(1, "127.0.0.1");
      },
    });
    expect(result.ok).toBe(false);
    expect(dialed).toBe(false);
  });
});
