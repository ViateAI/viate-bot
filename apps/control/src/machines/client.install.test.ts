import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { MachinedClient } from "./client.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("machine install request", () => {
  it("rejects an aborted response without leaking the machine token", async () => {
    const address = await listen((response) => {
      response.writeHead(200, { "content-length": 100 });
      response.write('{"routines":[');
      setImmediate(() => response.destroy());
    });
    const client = new MachinedClient({ host: "127.0.0.1", port: address.port, token: "private-machine-token" });
    await expect(client.installApp({ name: "demo", version: "1", sha256: "aa", archive: Buffer.from("archive") })).rejects.toThrow("安装响应已断开");
  });

  it("redacts a token echoed by an error response", async () => {
    const address = await listen((response) => { response.statusCode = 500; response.end('{"error":"private-machine-token"}'); });
    const client = new MachinedClient({ host: "127.0.0.1", port: address.port, token: "private-machine-token" });
    await expect(client.installApp({ name: "demo", version: "1", sha256: "aa", archive: Buffer.from("archive") })).rejects.toThrow("••••");
  });

  it("never sends a pre-aborted installation request", async () => {
    let received = false;
    const address = await listen((response) => { received = true; response.end('{}'); });
    const controller = new AbortController();
    controller.abort();
    const client = new MachinedClient({ host: "127.0.0.1", port: address.port, token: "machine" });
    await expect(client.installApp({ name: "demo", version: "1", sha256: "aa", archive: Buffer.from("archive") }, controller.signal)).rejects.toThrow("安装请求已取消");
    expect(received).toBe(false);
  });

  it("bounds the installation response body", async () => {
    const address = await listen((response) => response.end("x".repeat(1024 * 1024 + 1)));
    const client = new MachinedClient({ host: "127.0.0.1", port: address.port, token: "private-machine-token" });
    await expect(client.installApp({ name: "demo", version: "1", sha256: "aa", archive: Buffer.from("archive") })).rejects.toThrow("安装响应过大");
  });

  it("removes the abort listener when a request finishes", async () => {
    const address = await listen((response) => response.end('{"routines":[]}'));
    const controller = new AbortController();
    const client = new MachinedClient({ host: "127.0.0.1", port: address.port, token: "machine" });
    await client.installApp({ name: "demo", version: "1", sha256: "aa", archive: Buffer.from("archive") }, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("cuts off a slow install at its own deadline and accepts one inside that deadline", async () => {
    const address = await listen((response) => {
      setTimeout(() => {
        if (response.writableEnded) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ routines: [] }));
      }, 200);
    });
    const endpoint = { host: "127.0.0.1", port: address.port, token: "machine" };
    const archive = Buffer.from("archive");
    const rushed = new MachinedClient(endpoint, fetch, 50);
    await expect(rushed.installApp({ name: "demo", version: "1", sha256: "aa", archive })).rejects.toThrow(/安装请求超时/);
    const patient = new MachinedClient(endpoint, fetch, 1_000);
    await expect(patient.installApp({ name: "demo", version: "1", sha256: "aa", archive })).resolves.toEqual([]);
  });
});

function listen(respond: (response: ServerResponse) => void): Promise<AddressInfo> {
  const { promise, resolve } = Promise.withResolvers<AddressInfo>();
  const server = createServer((_request, response) => {
    respond(response);
  });
  const { promise: closed, resolve: done } = Promise.withResolvers<void>();
  closers.push(() => {
    server.close(() => done());
    return closed;
  });
  server.listen(0, "127.0.0.1", () => {
    resolve(server.address() as AddressInfo);
  });
  return promise;
}
