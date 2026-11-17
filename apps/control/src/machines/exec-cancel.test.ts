import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MachinedClient } from "./client.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("exec cancellation barrier", () => {
  it("does not settle an aborted exec until the machine acknowledges the stop", async () => {
    let execResponse: ServerResponse | undefined;
    let releaseCancel = () => {};
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let cancelStarted = false;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        if (req.url === "/exec/cancel") {
          cancelStarted = true;
          void cancelGate.then(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ stopped: true }));
            execResponse?.end(`data: ${JSON.stringify({ type: "exit", code: null, signal: "SIGKILL", timedOut: false })}\n\n`);
          });
          return;
        }
        execResponse = res;
        res.writeHead(200, { "content-type": "text/event-stream", "x-exec-id": "job-1" });
        res.flushHeaders();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const client = new MachinedClient({ host: "127.0.0.1", port, token: "machine" });
    const signal = new AbortController();
    let settled = false;
    const pending = client.exec({ cmd: "sleep", signal: signal.signal }).finally(() => {
      settled = true;
    });
    const opened = Date.now();
    while (!execResponse) {
      if (Date.now() - opened > 1000) throw new Error("exec 没有开始");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    signal.abort();
    const started = Date.now();
    while (!cancelStarted) {
      if (Date.now() - started > 1000) throw new Error("没有请求取消");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    releaseCancel();
    await expect(pending).rejects.toThrow(/exec 已取消/);
    expect(settled).toBe(true);
  });

  it("does not treat a 500 cancel as a confirmed stop", async () => {
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (req.url === "/exec/cancel") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "x-exec-id": "job-1" });
        res.flushHeaders();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const client = new MachinedClient({ host: "127.0.0.1", port, token: "machine" });
    const signal = new AbortController();
    const pending = client.exec({ cmd: "sleep", signal: signal.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    signal.abort();
    await expect(pending).rejects.toThrow(/remote_unconfirmed/);
  });
});
