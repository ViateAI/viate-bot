import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { BrowserClient } from "./client.js";
import { UserBrowserLock } from "./lock.js";

interface Call {
  id: number;
  method: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

const closers: Array<() => Promise<void>> = [];
let heldMarker: { socket: WebSocket; id: number; sessionId: string } | undefined;

afterEach(async () => {
  heldMarker = undefined;
  for (const close of closers.splice(0)) await close();
});

describe("browser client", () => {
  it("keeps two bots on their own targets and matches parallel responses", async () => {
    const calls: Call[] = [];
    const inputs = new Map<string, string>();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let seq = 0;
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Call;
        calls.push(message);
        const sessionId = message.sessionId;
        const params = message.params ?? {};
        void answer(socket, message, sessionId, params, () => {
          seq += 1;
          return seq;
        }, inputs);
      });
    });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
    const port = (wss.address() as AddressInfo).port;
    const client = await BrowserClient.connect(`ws://127.0.0.1:${port}/devtools/browser/test`);
    closers.push(async () => {
      await client.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });

    const [first, second] = await Promise.all([
      client.openWindow("bot-a", "http://a.example"),
      client.openWindow("bot-b", "http://b.example"),
    ]);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.targetId).not.toBe(second.targetId);
    expect(first.windowId).not.toBe(second.windowId);

    await Promise.all([client.insertText("bot-a", "AAA"), client.insertText("bot-b", "BBB")]);
    expect(inputs.get(first.sessionId)).toBe("AAA");
    expect(inputs.get(second.sessionId)).toBe("BBB");

    const [left, right] = await Promise.all([
      client.evaluate<string>("bot-a", "marker"),
      client.evaluate<string>("bot-b", "marker"),
    ]);
    expect(left).toBe(`from:${first.sessionId}`);
    expect(right).toBe(`from:${second.sessionId}`);

    await client.activate("bot-a");
    const activated = calls.find((call) => call.method === "Target.activateTarget");
    expect(activated?.params).toMatchObject({ targetId: first.targetId });
    expect(calls.some((call) => call.method === "Page.bringToFront" && call.sessionId === first.sessionId)).toBe(true);
    await client.dispatchKeyEvent("bot-a", { type: "keyDown", key: "X", text: "X" });
    const key = calls.find((call) => call.method === "Input.dispatchKeyEvent");
    expect(key?.sessionId).toBe(first.sessionId);
    expect(key?.params).toMatchObject({ type: "keyDown", text: "X" });

    await expect(client.setDownloadBehavior("missing", "/tmp/nope")).rejects.toThrow(/没有窗口/);
    expect(calls.some((call) => call.method === "Browser.setDownloadBehavior")).toBe(false);
    await client.setDownloadBehavior("bot-a", "/home/bot/Downloads/bot-a");
    const download = calls.find((call) => call.method === "Browser.setDownloadBehavior");
    expect(download?.sessionId).toBeUndefined();
    expect(download?.params).toMatchObject({ behavior: "allow", downloadPath: "/home/bot/Downloads/bot-a" });

    const png = await client.screenshot("bot-b");
    expect(png.equals(Buffer.from("png"))).toBe(true);
    await expect(client.evaluate("bot-b", "throw")).rejects.toThrow("boom");
    await expect(client.openWindow("bot-a", "http://again")).rejects.toThrow(/已经有窗口/);

    await client.closeWindow("bot-a");
    expect(client.getWindow("bot-a")).toBeUndefined();
    await expect(client.insertText("bot-a", "nope")).rejects.toThrow(/没有窗口/);
    expect(client.getWindow("bot-b")?.targetId).toBe(second.targetId);
  });

  it("does not interleave two bots while the user lock is held", async () => {
    const { url, close } = await fakeCdp();
    closers.push(close);
    const client = await BrowserClient.connect(url, { lock: new UserBrowserLock() });
    await Promise.all([client.openWindow("bot-a", "http://a.example"), client.openWindow("bot-b", "http://b.example")]);
    const order: string[] = [];
    await Promise.all([
      client.use(async () => {
        order.push("a-start");
        await client.insertText("bot-a", "SLOW-A");
        order.push("a-end");
      }),
      client.use(async () => {
        order.push("b-start");
        await client.insertText("bot-b", "SLOW-B");
        order.push("b-end");
      }),
    ]);
    expect(["a-start,a-end,b-start,b-end", "b-start,b-end,a-start,a-end"]).toContain(order.join(","));
    await client.close();
  });

  it("closes the target when setup fails before the window is recorded", async () => {
    const live = new Set<string>();
    const { url, close } = await scriptedCdp((message, socket, nextId) => replyOpen(message, socket, nextId, live, true));
    closers.push(close);
    const client = await BrowserClient.connect(url);
    await expect(client.openWindow("failed-bot", "about:blank")).rejects.toThrow("target crashed");
    expect(client.getWindow("failed-bot")).toBeUndefined();
    expect([...live]).toEqual([]);
    await client.close();
  });

  it("does not create a second target when the same bot opens twice", async () => {
    const live = new Set<string>();
    const { url, close } = await scriptedCdp((message, socket, nextId) => replyOpen(message, socket, nextId, live, false));
    closers.push(close);
    const client = await BrowserClient.connect(url);
    const settled = await Promise.allSettled([
      client.openWindow("same-bot", "about:blank"),
      client.openWindow("same-bot", "about:blank"),
    ]);
    const fulfilled = settled.filter((item) => item.status === "fulfilled");
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0];
    if (!failure || failure.status !== "rejected") throw new Error("缺少拒绝结果");
    expect(failure.reason).toBeInstanceOf(Error);
    expect((failure.reason as Error).message).toMatch(/已经有窗口/);
    expect(live.size).toBe(1);
    const only = [...live][0];
    expect(client.getWindow("same-bot")?.targetId).toBe(only);
    await client.close();
  });

  it("terminates the socket when the handshake times out", async () => {
    // 握手超时由真实 socket 和平台时钟触发，假定时器推不走这条连接。
    const sockets = new Set<Socket>();
    const server = createServer();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", () => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    closers.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    const closed = new Promise<void>((resolve) => {
      server.on("connection", (socket) => socket.on("close", () => resolve()));
    });
    await expect(
      BrowserClient.connect(`ws://127.0.0.1:${port}/devtools/browser/stuck`, { connectTimeoutMs: 30 }),
    ).rejects.toThrow("CDP 连接超时");
    await closed;
    expect(sockets.size).toBe(0);
  });

  it("drops a stuck wss handshake without replacing the timeout", async () => {
    // TLS 握手超时同样由真实 socket 和平台时钟触发。
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    closers.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    const closed = new Promise<void>((resolve) => {
      server.on("connection", (socket) => socket.on("close", () => resolve()));
    });
    await expect(
      BrowserClient.connect(`wss://127.0.0.1:${port}/devtools/browser/stuck`, { connectTimeoutMs: 50 }),
    ).rejects.toThrow("CDP 连接超时");
    await closed;
    expect(sockets.size).toBe(0);
  });
});

async function scriptedCdp(
  onCall: (message: Call, socket: WebSocket, nextId: () => number) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let seq = 0;
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Call;
      onCall(message, socket, () => {
        seq += 1;
        return seq;
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/test`,
    close: async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function replyOpen(
  message: Call,
  socket: WebSocket,
  nextId: () => number,
  live: Set<string>,
  failPage: boolean,
): void {
  const params = message.params ?? {};
  if (message.method === "Target.createTarget") {
    const targetId = `t${nextId()}`;
    live.add(targetId);
    socket.send(JSON.stringify({ id: message.id, result: { targetId } }));
    return;
  }
  if (message.method === "Target.attachToTarget") {
    socket.send(JSON.stringify({ id: message.id, result: { sessionId: `s-${String(params.targetId)}` } }));
    return;
  }
  if (message.method === "Browser.getWindowForTarget") {
    const digits = String(params.targetId).replace(/\D/g, "");
    socket.send(JSON.stringify({ id: message.id, result: { windowId: Number(digits) || 1 } }));
    return;
  }
  if (message.method === "Page.enable" && failPage) {
    socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "target crashed" } }));
    return;
  }
  if (message.method === "Runtime.evaluate") {
    socket.send(JSON.stringify({ id: message.id, result: { result: { type: "string", value: "complete" } } }));
    return;
  }
  if (message.method === "Target.closeTarget") {
    live.delete(String(params.targetId));
    socket.send(JSON.stringify({ id: message.id, result: { success: true } }));
    return;
  }
  socket.send(JSON.stringify({ id: message.id, result: {} }));
}

async function fakeCdp(): Promise<{ url: string; close: () => Promise<void> }> {
  const inputs = new Map<string, string>();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let seq = 0;
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Call;
      void answer(socket, message, message.sessionId, message.params ?? {}, () => {
        seq += 1;
        return seq;
      }, inputs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/test`,
    close: async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function replyMarkerOutOfOrder(socket: WebSocket, id: number, sessionId: string): void {
  const send = (target: WebSocket, replyId: number, replySession: string) => {
    target.send(
      JSON.stringify({
        id: replyId,
        result: { result: { type: "string", value: `from:${replySession}` } },
      }),
    );
  };
  const held = heldMarker;
  if (!held) {
    heldMarker = { socket, id, sessionId };
    return;
  }
  send(socket, id, sessionId);
  send(held.socket, held.id, held.sessionId);
  heldMarker = undefined;
}

async function answer(
  socket: WebSocket,
  message: Call,
  sessionId: string | undefined,
  params: Record<string, unknown>,
  nextId: () => number,
  inputs: Map<string, string>,
): Promise<void> {
  if (message.method === "Runtime.evaluate" && params.expression === "throw") {
    socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "boom" } }));
    return;
  }
  if (message.method === "Runtime.evaluate" && params.expression === "marker") {
    replyMarkerOutOfOrder(socket, message.id, sessionId ?? "");
    return;
  }
  let result: unknown = {};
  if (message.method === "Target.createTarget") {
    const id = nextId();
    result = { targetId: `t${id}` };
  } else if (message.method === "Target.attachToTarget") {
    result = { sessionId: `s-${String(params.targetId)}` };
  } else if (message.method === "Browser.getWindowForTarget") {
    result = { windowId: Number(String(params.targetId).replace("t", "")) };
  } else if (message.method === "Runtime.evaluate") {
    const expression = String(params.expression ?? "");
    const value =
      expression === "document.readyState" ? "complete" : expression === "document.hasFocus()" ? true : `from:${sessionId ?? ""}`;
    result = { result: { type: "string", value } };
  } else if (message.method === "Input.insertText") {
    const key = sessionId ?? "";
    inputs.set(key, `${inputs.get(key) ?? ""}${String(params.text ?? "")}`);
  } else if (message.method === "Page.captureScreenshot") {
    result = { data: Buffer.from("png").toString("base64") };
  } else if (message.method === "Target.closeTarget") {
    result = { success: true };
  }
  socket.send(JSON.stringify({ id: message.id, result }));
}
