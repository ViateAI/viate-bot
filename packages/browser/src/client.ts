import { AsyncLocalStorage } from "node:async_hooks";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import WebSocket, { type RawData } from "ws";
import { UserBrowserLock } from "./lock.js";

const CDP_TIMEOUT_MS = 30_000;

/**
 * 一个用户机器上的浏览器级 CDP 客户端。
 * 调用方传入 WebSocket 地址（machined 的 /browser/cdp 或本机 9222），本模块不读 machined 的进程状态。
 * 每个 bot 只操作自己 openWindow 记录的 target。
 */
export class BrowserClient {
  private readonly windows = new Map<string, BotWindow>();
  private readonly opening = new Set<string>();
  private readonly owner = new AsyncLocalStorage<true>();

  private constructor(
    private readonly cdp: CdpConnection,
    private readonly lock?: UserBrowserLock,
  ) {}

  static async connect(webSocketUrl: string, options?: BrowserConnectOptions): Promise<BrowserClient> {
    const cdp = await CdpConnection.open(webSocketUrl, options?.headers, options?.connectTimeoutMs ?? 10_000);
    const lock = options?.lock;
    return lock ? new BrowserClient(cdp, lock) : new BrowserClient(cdp);
  }

  /**
   * 有锁时，整段 action 结束前不让别的 bot 插进来。
   * 已经在锁里时直接执行，避免 insertText 这类方法再次抢锁。
   */
  async use<T>(action: () => Promise<T>): Promise<T> {
    if (!this.lock || this.owner.getStore()) return action();
    return this.lock.run(() => this.owner.run(true, action));
  }

  getWindow(botId: string): BotWindow | undefined {
    const window = this.windows.get(botId);
    return window ? { ...window } : undefined;
  }

  async openWindow(botId: string, url: string): Promise<BotWindow> {
    return this.use(() => this.openWindowNow(botId, url));
  }

  private async openWindowNow(botId: string, url: string): Promise<BotWindow> {
    if (this.windows.has(botId) || this.opening.has(botId)) throw new Error(`bot ${botId} 已经有窗口`);
    this.opening.add(botId);
    let targetId: string | undefined;
    try {
      const created = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url, newWindow: true });
      targetId = created.targetId;
      const attached = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const win = await this.cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId });
      await this.cdp.send("Page.enable", {}, attached.sessionId);
      await this.cdp.send("Runtime.enable", {}, attached.sessionId);
      const record: BotWindow = {
        botId,
        targetId,
        windowId: win.windowId,
        sessionId: attached.sessionId,
      };
      this.windows.set(botId, record);
      await this.waitUntilReady(record.sessionId);
      return { ...record };
    } catch (error) {
      this.windows.delete(botId);
      if (targetId !== undefined) {
        await this.cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.opening.delete(botId);
    }
  }

  async closeWindow(botId: string): Promise<void> {
    return this.use(async () => {
      const window = this.requireWindow(botId);
      try {
        await this.cdp.send("Target.closeTarget", { targetId: window.targetId });
      } finally {
        this.windows.delete(botId);
      }
    });
  }

  async navigate(botId: string, url: string): Promise<void> {
    return this.use(async () => {
      const window = this.requireWindow(botId);
      const result = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url }, window.sessionId);
      if (result.errorText) throw new Error(result.errorText);
      await this.waitUntilReady(window.sessionId);
    });
  }

  async evaluate<T = unknown>(botId: string, expression: string): Promise<T> {
    return this.use(async () => {
      const window = this.requireWindow(botId);
      return this.evaluateOnSession<T>(window.sessionId, expression);
    });
  }

  async insertText(botId: string, text: string): Promise<void> {
    return this.use(async () => {
      const window = this.requireWindow(botId);
      await this.cdp.send("Input.insertText", { text }, window.sessionId);
    });
  }

  async activate(botId: string): Promise<void> {
    return this.use(async () => {
      await this.activateWindow(this.requireWindow(botId));
    });
  }

  async dispatchKeyEvent(botId: string, event: KeyEvent): Promise<void> {
    return this.use(async () => {
      const window = this.requireWindow(botId);
      const params: Record<string, string | number> = { type: event.type };
      if (event.key !== undefined) params.key = event.key;
      if (event.text !== undefined) params.text = event.text;
      if (event.code !== undefined) params.code = event.code;
      if (event.unmodifiedText !== undefined) params.unmodifiedText = event.unmodifiedText;
      if (event.windowsVirtualKeyCode !== undefined) params.windowsVirtualKeyCode = event.windowsVirtualKeyCode;
      await this.cdp.send("Input.dispatchKeyEvent", params, window.sessionId);
    });
  }

  async screenshot(botId: string): Promise<Buffer> {
    return this.use(async () => {
      const window = this.requireWindow(botId);
      const result = await this.cdp.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
        window.sessionId,
      );
      return Buffer.from(result.data, "base64");
    });
  }

  /**
   * CDP 的 Browser.setDownloadBehavior 作用在浏览器上下文上，不是单个 target。
   * 设置目录、触发下载、等文件落地必须放在同一次 use() 里，否则另一个 bot 会改掉目录。
   */
  async setDownloadBehavior(botId: string, downloadPath: string): Promise<void> {
    return this.use(async () => {
      this.requireWindow(botId);
      await this.cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath,
        eventsEnabled: true,
      });
    });
  }

  async close(): Promise<void> {
    this.windows.clear();
    await this.cdp.close();
  }

  private requireWindow(botId: string): BotWindow {
    const window = this.windows.get(botId);
    if (!window) throw new Error(`bot ${botId} 没有窗口`);
    return window;
  }

  private async evaluateOnSession<T>(sessionId: string, expression: string): Promise<T> {
    const result = await this.cdp.send<EvaluateResult>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description;
      throw new Error(description || result.exceptionDetails.text || "脚本执行失败");
    }
    return result.result.value as T;
  }

  private async activateWindow(window: BotWindow): Promise<void> {
    await this.cdp.send("Target.activateTarget", { targetId: window.targetId });
    await this.cdp.send("Page.bringToFront", {}, window.sessionId);
    const deadline = Date.now() + 2_000;
    let last = "窗口没有获得焦点";
    while (Date.now() < deadline) {
      try {
        const focused = await this.evaluateOnSession<boolean>(window.sessionId, "document.hasFocus()");
        if (focused === true) return;
        last = "document.hasFocus() 仍是 false";
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await delay(20);
    }
    throw new Error(last);
  }

  private async waitUntilReady(sessionId: string): Promise<void> {
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    let last = "页面未就绪";
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluateOnSession<string>(sessionId, "document.readyState");
        if (state === "complete" || state === "interactive") return;
        last = `readyState=${state}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await delay(50);
    }
    throw new Error(last);
  }
}

export interface BotWindow {
  botId: string;
  targetId: string;
  windowId: number;
  sessionId: string;
}

export interface BrowserConnectOptions {
  headers?: Record<string, string>;
  /** 传入后，use() 和各操作方法会按用户串行。 */
  lock?: UserBrowserLock;
  /** WebSocket 握手超时。缺省 10 秒。 */
  connectTimeoutMs?: number;
}

export interface KeyEvent {
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  key?: string;
  text?: string;
  code?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
}

interface EvaluateResult {
  result: { type?: string; value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => this.failAll(new Error("CDP 连接已关闭")));
    ws.on("error", (error: Error) => this.failAll(error));
  }

  static async open(url: string, headers?: Record<string, string>, timeoutMs = 10_000): Promise<CdpConnection> {
    const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
    const connection = new CdpConnection(ws);
    if (ws.readyState === WebSocket.OPEN) return connection;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("CDP 连接超时"));
        }, timeoutMs);
        timer.unref();
        const cleanup = () => {
          clearTimeout(timer);
          ws.off("open", onOpen);
          ws.off("error", onError);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        ws.once("open", onOpen);
        ws.once("error", onError);
      });
    } catch (error) {
      // terminate() 在明文升级请求已经写出后只半关闭连接，对端仍留着 socket。先发 RST。
      // 清理自己的异常不能盖住原来的超时或握手错误，terminate 也必须执行。
      try {
        resetHandshake(ws);
      } catch {
        // resetAndDestroy 对 TLS socket 会抛 ERR_INVALID_HANDLE_TYPE。
      }
      try {
        ws.terminate();
      } catch {
        // 连接已经销毁时 terminate 可能抛出。
      }
      throw error;
    }
    return connection;
  }

  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId !== undefined) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, CDP_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.ws.send(JSON.stringify(message));
    });
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }

  private onMessage(raw: RawData): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(rawText(raw)) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "CDP 调用失败"));
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function resetHandshake(ws: WebSocket): void {
  const socket = (ws as WebSocket & { _req?: { socket?: Socket | null } })._req?.socket;
  if (!socket || socket.destroyed) return;
  socket.on("error", () => undefined);
  if (socket instanceof TLSSocket) {
    socket.destroy();
    return;
  }
  try {
    socket.resetAndDestroy();
  } catch {
    socket.destroy();
  }
}

function rawText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
