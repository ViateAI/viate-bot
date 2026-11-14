import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { BrowserClient } from "./client.js";
import { UserBrowserLock } from "./lock.js";
import { typeInto, type CdpSend } from "./page.js";

interface Call {
  id: number;
  method: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("page tools", () => {
  it("snapshots refs, clicks the center, types with readback, and rejects a stale ref", async () => {
    const typed: string[] = [];
    const clicks: Array<{ type?: string; x?: number; y?: number }> = [];
    const enters: Array<{ type?: string; key?: string }> = [];
    const { url, close } = await fakeCdp({
      onInsert: (text) => typed.push(text),
      onMouse: (params) => clicks.push(params),
      onKey: (params) => enters.push(params),
    });
    closers.push(close);
    const client = await BrowserClient.connect(url);
    closers.push(() => client.close());
    await client.open("bot", "http://login.test");

    const first = await client.snapshot("bot");
    expect(first).toContain("url: http://login.test");
    expect(first).toContain('[e1] textbox "用户名"');
    const point = await client.click("bot", "e1");
    expect(point).toEqual({ x: 50, y: 20 });
    const pressed = clicks.find((event) => event.type === "mousePressed");
    expect(pressed).toMatchObject({ type: "mousePressed", x: 50, y: 20, button: "left", clickCount: 1 });

    const value = await client.typeText("bot", "e1", "hello");
    expect(value).toBe("hello");
    expect(typed).toEqual(["hello"]);
    expect(await client.select("bot", "e1", "sms")).toBe("sms");
    await client.scroll("bot", 0, 120);
    expect(clicks.some((event) => event.type === "mouseWheel" && event.y === 200)).toBe(true);
    await client.scroll("bot", 0, 80, "e1");
    expect(clicks).toContainEqual(expect.objectContaining({ type: "mouseWheel", x: 50, y: 20 }));
    expect(await client.waitFor("bot", { text: "欢迎", timeoutMs: 500 })).toBe("已出现");

    const second = await client.snapshot("bot");
    expect(second).toContain('[e2] textbox "用户名"');
    expect(second).toContain('statictext "hello"');
    await expect(client.click("bot", "e1")).rejects.toThrow("ref e1 已过期或未知，请重新调用 browser_snapshot");
    await client.typeText("bot", "e2", "go", { submit: true });
    const enterDowns = enters.filter((event) => event.type === "keyDown" && event.key === "Enter");
    expect(enterDowns).toHaveLength(2);

    const tabs = await client.listTabs("bot");
    expect(tabs.map((tab) => tab.url)).toEqual(["http://login.test", "http://login.test/next"]);
    expect(await client.switchTab("bot", 1)).toBe("http://login.test/next");
    await client.closeTab("bot", 0);
    expect((await client.listTabs("bot")).map((tab) => tab.url)).toEqual(["http://login.test/next"]);
    await client.open("bot", "http://login.test/next");
    await expect(client.click("bot", "e2")).rejects.toThrow(/已过期或未知/);
  });

  it("types into a contenteditable once and clears it without using value", async () => {
    const element = textElement("abc");
    const inserts: string[] = [];
    const typed = await typeInto(scriptedSend(element, inserts), "s", 1, "hello", {});
    expect(inserts).toEqual(["hello"]);
    expect(typed).toBe("helloabc");

    const again = textElement("abc");
    inserts.length = 0;
    const cleared = await typeInto(scriptedSend(again, inserts), "s", 1, "hello", { clear: true });
    expect(inserts).toEqual(["hello"]);
    expect(cleared).toBe("hello");

    const plain = { isContentEditable: false, tagName: "DIV", dispatchEvent() {} };
    inserts.length = 0;
    await expect(typeInto(scriptedSend(plain, inserts), "s", 1, "hello", {})).rejects.toThrow("这个元素不能输入");
    expect(inserts).toEqual([]);
  });

  it("does not put the typed text into a readback mismatch error", async () => {
    const { url, close } = await fakeCdp({ readback: "mismatch" });
    closers.push(close);
    const client = await BrowserClient.connect(url);
    closers.push(() => client.close());
    await client.open("bot", "http://login.test");
    await client.snapshot("bot");
    await expect(client.typeText("bot", "e1", "pw-secret-value")).rejects.toThrow("输入后读回的值与写入不一致");
  });

  it("serializes two bots on one lock and lets two users overlap", async () => {
    let inflight = 0;
    let max = 0;
    const { url, close } = await fakeCdp({
      onTree: async () => {
        inflight += 1;
        max = Math.max(max, inflight);
        await delay(40);
        inflight -= 1;
      },
    });
    closers.push(close);
    const shared = await BrowserClient.connect(url, { lock: new UserBrowserLock() });
    closers.push(() => shared.close());
    await Promise.all([shared.open("bot-a", "http://a.test"), shared.open("bot-b", "http://b.test")]);
    await Promise.all([shared.snapshot("bot-a"), shared.snapshot("bot-b")]);
    expect(max).toBe(1);

    let pending = 0;
    let release = () => {};
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const overlap = await fakeCdp({
      onTree: () => {
        pending += 1;
        if (pending >= 2) release();
        return both;
      },
    });
    closers.push(overlap.close);
    const left = await BrowserClient.connect(overlap.url, { lock: new UserBrowserLock() });
    const right = await BrowserClient.connect(overlap.url, { lock: new UserBrowserLock() });
    closers.push(() => left.close());
    closers.push(() => right.close());
    await left.open("bot-a", "http://a.test");
    await right.open("bot-b", "http://b.test");
    await Promise.all([left.snapshot("bot-a"), right.snapshot("bot-b")]);
    expect(pending).toBe(2);
  });
});

async function fakeCdp(hooks: {
  onInsert?: (text: string) => void;
  onMouse?: (params: { type?: string; x?: number; y?: number }) => void;
  onKey?: (params: { type?: string; key?: string }) => void;
  onTree?: () => Promise<void> | void;
  readback?: "mismatch";
} = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let seq = 0;
  const values = new Map<string, string>();
  const closed = new Set<string>();
  let enterCount = 0;
  let droppedEnter = false;
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Call;
      void reply(socket, message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });

  async function reply(socket: WebSocket, message: Call): Promise<void> {
    const params = message.params ?? {};
    const sessionId = message.sessionId ?? "";
    let result: unknown = {};
    if (message.method === "Target.createTarget") {
      seq += 1;
      result = { targetId: `t${seq}` };
    } else if (message.method === "Target.attachToTarget") {
      result = { sessionId: `s-${String(params.targetId)}` };
    } else if (message.method === "Browser.getWindowForTarget") {
      result = { windowId: 1 };
    } else if (message.method === "Target.getTargets") {
      result = {
        targetInfos: [
          { targetId: "t1", type: "page", url: "http://login.test", title: "登录" },
          { targetId: "t2", type: "page", url: "http://login.test/next", title: "下一步" },
        ].filter((target) => !closed.has(target.targetId)),
      };
    } else if (message.method === "Runtime.evaluate") {
      const expression = String(params.expression ?? "");
      if (expression === "document.readyState") result = { result: { type: "string", value: "complete" } };
      else if (expression === "document.hasFocus()") result = { result: { type: "boolean", value: true } };
      else if (expression === "location.href") result = { result: { type: "string", value: "http://login.test" } };
      else if (expression.includes("__vbEnter")) result = { result: { value: { count: enterCount, href: "http://login.test" } } };
      else if (expression.includes("欢迎") || expression.includes("pending")) result = { result: { value: "ok" } };
      else result = { result: { type: "string", value: "" } };
    } else if (message.method === "Accessibility.getFullAXTree") {
      await hooks.onTree?.();
      const typed = values.get(sessionId) ?? "";
      const nodes: Array<Record<string, unknown>> = [
        { role: { value: "textbox" }, name: { value: "用户名" }, backendDOMNodeId: 7 },
        { role: { value: "InlineTextBox" }, name: { value: "忽略" }, backendDOMNodeId: 8 },
      ];
      if (typed) nodes.push({ role: { value: "statictext" }, name: { value: typed }, value: { value: typed }, backendDOMNodeId: 9 });
      result = { nodes };
    } else if (message.method === "DOM.getBoxModel") {
      result = { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } };
    } else if (message.method === "Page.getLayoutMetrics") {
      result = { cssVisualViewport: { pageX: 10, pageY: 4, clientWidth: 800, clientHeight: 600 } };
    } else if (message.method === "Input.dispatchMouseEvent") {
      hooks.onMouse?.(params as { type?: string; x?: number; y?: number });
    } else if (message.method === "Input.insertText") {
      const text = String(params.text ?? "");
      hooks.onInsert?.(text);
      values.set(sessionId, `${values.get(sessionId) ?? ""}${text}`);
    } else if (message.method === "Input.dispatchKeyEvent") {
      const key = params as { type?: string; key?: string };
      hooks.onKey?.(key);
      if (key.type === "keyDown" && key.key === "Enter") {
        if (!droppedEnter) droppedEnter = true;
        else enterCount += 1;
      }
    } else if (message.method === "DOM.resolveNode") {
      result = { object: { objectId: sessionId || "obj" } };
    } else if (message.method === "Runtime.callFunctionOn") {
      const declaration = String(params.functionDeclaration ?? "");
      if (declaration.includes("SELECT")) result = { result: { value: "sms" } };
      else if (hooks.readback === "mismatch") result = { result: { value: "" } };
      else result = { result: { value: values.get(sessionId) ?? "" } };
    } else if (message.method === "Page.captureScreenshot") {
      result = { data: Buffer.from("jpeg").toString("base64") };
    } else if (message.method === "Target.closeTarget") {
      closed.add(String(params.targetId));
      result = { success: true };
    }
    socket.send(JSON.stringify({ id: message.id, result }));
  }

  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/test`,
    close: async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textElement(initial: string): { isContentEditable: boolean; tagName: string; innerText: string; textContent: string; dispatchEvent: () => void } {
  let text = initial;
  return {
    isContentEditable: true,
    tagName: "DIV",
    get innerText() {
      return text;
    },
    set innerText(value: string) {
      text = value;
    },
    get textContent() {
      return text;
    },
    set textContent(value: string) {
      text = value;
    },
    dispatchEvent() {},
  };
}

function scriptedSend(element: object, inserts: string[]): CdpSend {
  return (async (method, params) => {
    if (method === "DOM.focus" || method === "Input.dispatchKeyEvent") return {};
    if (method === "DOM.resolveNode") return { object: { objectId: "el" } };
    if (method === "Input.insertText") {
      const text = String(params?.text ?? "");
      inserts.push(text);
      const editable = element as { innerText: string };
      editable.innerText = `${text}${editable.innerText}`;
      return {};
    }
    if (method === "Runtime.callFunctionOn") {
      const declaration = String(params?.functionDeclaration ?? "");
      const fn = new Function(`return (${declaration})`)() as (this: object, ...args: unknown[]) => unknown;
      const args = Array.isArray(params?.arguments) ? params.arguments.map((item) => (item as { value?: unknown }).value) : [];
      try {
        return { result: { value: fn.apply(element, args) } };
      } catch (error) {
        return { exceptionDetails: { text: error instanceof Error ? error.message : "fail" } };
      }
    }
    return {};
  }) as CdpSend;
}
