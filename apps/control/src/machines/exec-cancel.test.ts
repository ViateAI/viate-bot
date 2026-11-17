import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachinedClient } from "./client.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("exec cancellation barrier", () => {
  it("bounds a stalled cancellation acknowledgement and preserves remote_unconfirmed", async () => {
    vi.useFakeTimers();
    const cancel = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/exec/cancel")) {
        started.resolve();
        init?.signal?.addEventListener("abort", () => cancel.reject(new Error("timeout")), { once: true });
        return cancel.promise;
      }
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
      init?.signal?.addEventListener("abort", () => stream.error(new Error("aborted")), { once: true });
      return new Response(body, { headers: { "x-exec-id": "job-1" } });
    };
    const client = new MachinedClient({ host: "127.0.0.1", port: 9, token: "machine" }, request);
    const controller = new AbortController();
    let outcome = "pending";
    const pending = client.exec({ cmd: "sleep", signal: controller.signal }).catch((error: Error) => { outcome = error.message; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await started.promise;
      await vi.advanceTimersByTimeAsync(5000);
      expect(outcome).toBe("remote_unconfirmed");
    } finally {
      cancel.reject(new Error("cleanup"));
      await pending;
      vi.useRealTimers();
    }
  });

  it("does not accept an HTTP 200 cancellation without a stopped acknowledgement", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const ready = Promise.withResolvers<void>();
    const request: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/exec/cancel")) return new Response(JSON.stringify({ stopped: false }));
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
      init?.signal?.addEventListener("abort", () => stream.error(new Error("aborted")), { once: true });
      ready.resolve();
      return new Response(body, { headers: { "x-exec-id": "job-1" } });
    };
    const client = new MachinedClient({ host: "127.0.0.1", port: 9, token: "machine" }, request);
    const controller = new AbortController();
    const pending = client.exec({ cmd: "sleep", signal: controller.signal });
    await ready.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("remote_unconfirmed");
  });

  it("treats a truncated exec stream as remote_unconfirmed without a caller abort", async () => {
    const request: typeof fetch = async () => new Response("data: {\"type\":\"stdout\",\"data\":\"started\"}\n\n", {
      headers: { "content-type": "text/event-stream", "x-exec-id": "job-1" },
    });
    const client = new MachinedClient({ host: "127.0.0.1", port: 9, token: "machine" }, request);
    await expect(client.exec({ cmd: "touch later" })).rejects.toThrow("remote_unconfirmed");
  });

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
