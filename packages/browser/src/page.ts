export const SNAPSHOT_LIMIT = 12_000;
export const WAIT_LIMIT_MS = 30_000;
const TYPE_LIMIT = 100_000;

export type CdpSend = <T>(method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<T>;

export interface AxNode {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
}

const INTERACTIVE = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
]);

const NAMED = new Set(["heading", "statictext", "labeltext", "paragraph", "image"]);

export interface SnapshotTree {
  text: string;
  refs: Map<string, number>;
}

/** 只留下可交互节点和有名字的文本。ref 由调用方发号，不在这里复用。 */
export function formatAxTree(nodes: AxNode[], nextRef: () => string): SnapshotTree {
  const refs = new Map<string, number>();
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value ?? "";
    const name = typeof node.name?.value === "string" ? node.name.value.trim() : "";
    const interactive = INTERACTIVE.has(role);
    if (!interactive && !(NAMED.has(role) && name.length > 0)) continue;
    const value = node.value?.value;
    const shown = typeof value === "string" && value.length > 0 ? ` value=${JSON.stringify(value)}` : "";
    const label = name.length > 0 ? ` ${JSON.stringify(name)}` : "";
    const backend = node.backendDOMNodeId;
    if (typeof backend === "number") {
      const ref = nextRef();
      refs.set(ref, backend);
      lines.push(`[${ref}] ${role}${label}${shown}`);
    } else {
      lines.push(`[-] ${role}${label}${shown}`);
    }
  }
  const full = lines.join("\n");
  if (full.length <= SNAPSHOT_LIMIT) return { text: full, refs };
  return {
    text: `${full.slice(0, SNAPSHOT_LIMIT)}\n…[无障碍树已截断，共 ${full.length} 字符。请滚动后再 snapshot]…`,
    refs,
  };
}

export async function readAxTree(send: CdpSend, sessionId: string, nextRef: () => string): Promise<SnapshotTree> {
  await send("Accessibility.enable", {}, sessionId).catch(() => undefined);
  const tree = await send<{ nodes?: AxNode[] }>("Accessibility.getFullAXTree", {}, sessionId);
  return formatAxTree(tree.nodes ?? [], nextRef);
}

export async function clickNode(send: CdpSend, sessionId: string, backendNodeId: number): Promise<{ x: number; y: number }> {
  await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId);
  await send("DOM.getDocument", { depth: 0, pierce: true }, sessionId).catch(() => undefined);
  const box = await send<{ model?: { content?: number[] } }>("DOM.getBoxModel", { backendNodeId }, sessionId);
  const quad = box.model?.content;
  if (!quad || quad.length < 8) throw new Error("元素没有可点击的区域");
  const point = quadCenter(quad);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
  return point;
}

export async function typeInto(
  send: CdpSend,
  sessionId: string,
  backendNodeId: number,
  text: string,
  options: { clear?: boolean; submit?: boolean },
): Promise<string> {
  if (text.length > TYPE_LIMIT) throw new Error("输入内容太长");
  await send("DOM.focus", { backendNodeId }, sessionId);
  const field = await readField(send, sessionId, backendNodeId);
  if (!field) throw new Error("这个元素不能输入");
  if (options.clear) {
    await press(send, sessionId, "a", "KeyA", 2);
    await press(send, sessionId, "Backspace", "Backspace", 0);
    const cleared = await readField(send, sessionId, backendNodeId);
    if (cleared && cleared.text.length > 0) await setValue(send, sessionId, backendNodeId, "");
  }
  if (text.length > 0) {
    await send("Input.insertText", { text }, sessionId);
    let value = await readField(send, sessionId, backendNodeId);
    if (value && !value.text.includes(text)) {
      await send("Input.insertText", { text }, sessionId);
      value = await readField(send, sessionId, backendNodeId);
    }
    if (!value || !value.text.includes(text)) throw new Error("输入后读回的值与写入不一致");
  }
  if (options.submit) await submitEnter(send, sessionId);
  return (await readField(send, sessionId, backendNodeId))?.text ?? "";
}

export async function selectOption(send: CdpSend, sessionId: string, backendNodeId: number, value: string): Promise<string> {
  const resolved = await send<{ object?: { objectId?: string } }>("DOM.resolveNode", { backendNodeId }, sessionId);
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("找不到下拉框");
  const chosen = await send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    "Runtime.callFunctionOn",
    {
      objectId,
      returnByValue: true,
      functionDeclaration: `function(value) {
        if (!this || this.tagName !== "SELECT") throw new Error("不是下拉框");
        const option = [...this.options].find((item) => item.value === value || item.label === value || item.text === value);
        if (!option) throw new Error("没有这个选项");
        this.value = option.value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return this.value;
      }`,
      arguments: [{ value }],
    },
    sessionId,
  );
  if (chosen.exceptionDetails) {
    throw new Error(chosen.exceptionDetails.exception?.description || chosen.exceptionDetails.text || "选择失败");
  }
  return typeof chosen.result?.value === "string" ? chosen.result.value : value;
}

export async function scrollPage(
  send: CdpSend,
  sessionId: string,
  deltaX: number,
  deltaY: number,
  point?: { x: number; y: number },
): Promise<void> {
  await send(
    "Input.dispatchMouseEvent",
    { type: "mouseWheel", x: point?.x ?? 200, y: point?.y ?? 200, deltaX, deltaY },
    sessionId,
  );
}

export async function waitForPage(
  send: CdpSend,
  sessionId: string,
  options: { text?: string; selector?: string; ms?: number; timeoutMs?: number },
): Promise<string> {
  const cap = Math.min(Math.max(options.timeoutMs ?? 10_000, 0), WAIT_LIMIT_MS);
  if (options.text === undefined && options.selector === undefined) {
    const pause = Math.min(Math.max(options.ms ?? 0, 0), cap);
    await delay(pause);
    return `已等待 ${pause} 毫秒`;
  }
  const deadline = Date.now() + cap;
  let last = "还没出现";
  while (Date.now() <= deadline) {
    try {
      const found = await send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const text = ${JSON.stringify(options.text ?? "")};
            const selector = ${JSON.stringify(options.selector ?? "")};
            const body = document.body ? document.body.innerText : "";
            const hasText = text.length === 0 || body.includes(text);
            let hasSelector = true;
            if (selector.length > 0) {
              try { hasSelector = Boolean(document.querySelector(selector)); }
              catch (error) { return "选择器无效"; }
            }
            return hasText && hasSelector ? "ok" : "pending";
          })()`,
          returnByValue: true,
        },
        sessionId,
      );
      const value = found.result?.value;
      if (value === "ok") return "已出现";
      if (typeof value === "string" && value !== "pending") last = value;
    } catch (error) {
      last = error instanceof Error ? error.message : "页面还没准备好";
    }
    if (Date.now() >= deadline) break;
    await delay(100);
  }
  throw new Error(`等待超时：${last}`);
}

export async function captureJpeg(
  send: CdpSend,
  sessionId: string,
): Promise<{ data: Buffer; width: number; height: number }> {
  const metrics = await send<LayoutMetrics>("Page.getLayoutMetrics", {}, sessionId).catch(() => ({} as LayoutMetrics));
  const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? { clientWidth: 1280, clientHeight: 800 };
  const width = Math.max(1, Math.min(1280, Math.floor(viewport.clientWidth || 1280)));
  const height = Math.max(1, Math.min(800, Math.floor(viewport.clientHeight || 800)));
  const shot = async (quality: number) => {
    const result = await send<{ data?: string }>(
      "Page.captureScreenshot",
      { format: "jpeg", quality, clip: { x: 0, y: 0, width, height, scale: 1 } },
      sessionId,
    );
    return Buffer.from(result.data ?? "", "base64");
  };
  let data = await shot(60);
  if (data.length > 1_500_000) data = await shot(30);
  return { data, width, height };
}

/** DOM.getBoxModel 的 quad 已经是视口坐标，不能再减滚动偏移。 */
export function quadCenter(quad: number[]): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  const points = quad.length / 2;
  for (let index = 0; index < quad.length; index += 2) {
    sx += quad[index] ?? 0;
    sy += quad[index + 1] ?? 0;
  }
  return { x: sx / points, y: sy / points };
}

interface LayoutMetrics {
  cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
  cssLayoutViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
}

async function readField(send: CdpSend, sessionId: string, backendNodeId: number): Promise<{ text: string } | undefined> {
  const resolved = await send<{ object?: { objectId?: string } }>("DOM.resolveNode", { backendNodeId }, sessionId);
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("找不到输入框");
  const evaluated = await send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>(
    "Runtime.callFunctionOn",
    {
      objectId,
      returnByValue: true,
      functionDeclaration: `function() {
        if (!this) return null;
        if (this.isContentEditable) return String(this.innerText ?? "");
        const tag = this.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return String(this.value ?? "");
        return null;
      }`,
    },
    sessionId,
  );
  if (evaluated.exceptionDetails?.text) throw new Error(evaluated.exceptionDetails.text);
  return typeof evaluated.result?.value === "string" ? { text: evaluated.result.value } : undefined;
}

async function setValue(send: CdpSend, sessionId: string, backendNodeId: number, value: string): Promise<void> {
  const resolved = await send<{ object?: { objectId?: string } }>("DOM.resolveNode", { backendNodeId }, sessionId);
  const objectId = resolved.object?.objectId;
  if (!objectId) return;
  await send(
    "Runtime.callFunctionOn",
    {
      objectId,
      returnByValue: true,
      arguments: [{ value }],
      functionDeclaration: `function(value) {
        if (this.isContentEditable) this.textContent = value;
        else this.value = value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        if (!this.isContentEditable) this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
    },
    sessionId,
  );
}

async function submitEnter(send: CdpSend, sessionId: string): Promise<void> {
  const before = await enterProbe(send, sessionId);
  await pressEnter(send, sessionId);
  const after = await enterProbe(send, sessionId);
  if (enterLanded(before, after)) return;
  await pressEnter(send, sessionId);
  const retried = await enterProbe(send, sessionId);
  if (!enterLanded(after, retried)) throw new Error("回车没有生效");
}

function enterLanded(before: EnterProbe, after: EnterProbe): boolean {
  if (before.href !== after.href) return true;
  return after.count > before.count;
}

interface EnterProbe {
  count: number;
  href: string;
}

async function enterProbe(send: CdpSend, sessionId: string): Promise<EnterProbe> {
  try {
    const result = await send<{ result?: { value?: { count?: unknown; href?: unknown } } }>(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const root = window;
          if (typeof root.__vbEnter !== "number") {
            root.__vbEnter = 0;
            document.addEventListener("keydown", (event) => { if (event.key === "Enter") root.__vbEnter += 1; }, true);
          }
          return { count: root.__vbEnter, href: location.href };
        })()`,
        returnByValue: true,
      },
      sessionId,
    );
    const value = result.result?.value;
    return {
      count: typeof value?.count === "number" ? value.count : 0,
      href: typeof value?.href === "string" ? value.href : "",
    };
  } catch {
    return { count: 0, href: "" };
  }
}

async function pressEnter(send: CdpSend, sessionId: string): Promise<void> {
  await send(
    "Input.dispatchKeyEvent",
    { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    sessionId,
  );
  await send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    sessionId,
  );
}

async function press(send: CdpSend, sessionId: string, key: string, code: string, modifiers: number): Promise<void> {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode: key === "Backspace" ? 8 : 65 }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: key === "Backspace" ? 8 : 65 }, sessionId);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
