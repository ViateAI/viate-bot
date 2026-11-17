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
