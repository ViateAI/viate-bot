import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { BoundBrowser } from "./browser-session.js";
import { annotatePage, annotateTabList, CHALLENGE_PROBE } from "./challenge.js";

const openSchema = obj({
  url: str({ description: "要在这个 bot 自己的窗口里打开的地址" }),
});

const emptySchema = obj({});

const refSchema = obj({
  ref: str({ description: "browser_snapshot 给出的 ref，例如 e1。过期后要重新 snapshot" }),
});

const typeSchema = obj({
  ref: str({ description: "要点击输入的元素 ref" }),
  text: str({ description: "要输入的文本，可以写 {{secret:NAME}}" }),
  clear: opt(bool({ description: "输入前先清空。缺省不清空" })),
  submit: opt(bool({ description: "输入后按回车。缺省不按" })),
});

const selectSchema = obj({
  ref: str({ description: "select 元素的 ref" }),
  value: str({ description: "选项的 value 或可见文字" }),
});

const scrollSchema = obj({
  ref: opt(str({ description: "先把这个元素滚进视口。缺省滚窗口" })),
  deltaX: opt(num({ description: "水平滚动量，缺省 0" })),
  deltaY: opt(num({ description: "垂直滚动量，正数向下，缺省 400" })),
});

const waitSchema = obj({
  text: opt(str({ description: "等到页面文字里出现这段" })),
  selector: opt(str({ description: "等到这个 CSS 选择器匹配到元素" })),
  ms: opt(num({ description: "固定等待的毫秒数，最多 30000" })),
  timeoutMs: opt(num({ description: "等待上限，最多 30000，缺省 10000" })),
});

const tabsSchema = obj({
  action: str({ description: "list、switch 或 close" }),
  index: opt(num({ description: "switch 和 close 使用 list 给出的序号" })),
});

const OWN_WINDOW = "只能操作这个 bot 自己窗口里的标签页，不能选择别的窗口或机器。";

/** 工具绑定到这一个用户的浏览器。截图是否注册由调用方按模型决定。 */
export function browserTools(bound: BoundBrowser): AgentTool[] {
  const open: AgentTool<typeof openSchema> = {
    name: "browser_open",
    label: "打开网页",
    description: `在这个 bot 自己的窗口里打开地址。${OWN_WINDOW}`,
    parameters: openSchema,
    execute: async (_id, params) => {
      const window = await bound.run((client) => client.open(bound.botId, params.url));
      const text = await withChallengeProbe(bound, `已打开 ${params.url}（窗口 ${window.windowId}）`);
      return { content: [{ type: "text", text }], details: { url: params.url } };
    },
  };

  const snapshot: AgentTool<typeof emptySchema> = {
    name: "browser_snapshot",
    label: "页面快照",
    description: `读取当前标签页的无障碍树。带 ref 的节点才能点击或输入。ref 在下一次 snapshot 或打开新地址后失效。${OWN_WINDOW}`,
    parameters: emptySchema,
    execute: async () => {
      const text = await bound.run(async (client) => {
        const snapshot = await client.snapshot(bound.botId);
        const probed = await client.evaluate(bound.botId, CHALLENGE_PROBE).catch(() => null);
        return annotatePage(snapshot, probed);
      });
      return { content: [{ type: "text", text }], details: {} };
    },
  };

  const click: AgentTool<typeof refSchema> = {
    name: "browser_click",
    label: "点击",
    description: `把元素滚进视口，再在它的中心点发送鼠标点击。${OWN_WINDOW}`,
    parameters: refSchema,
    execute: async (_id, params) => {
      const point = await bound.run((client) => client.click(bound.botId, params.ref));
      return { content: [{ type: "text", text: `已点击 ${params.ref}（${Math.round(point.x)}, ${Math.round(point.y)}）` }], details: point };
    },
  };

  const type: AgentTool<typeof typeSchema> = {
    name: "browser_type",
    label: "输入",
    description: `聚焦元素后输入文本，并读回确认。submit 为 true 时按回车。${OWN_WINDOW}`,
    parameters: typeSchema,
    execute: async (_id, params) => {
      await bound.run((client) =>
        client.typeText(bound.botId, params.ref, params.text, {
          ...(params.clear !== undefined ? { clear: params.clear } : {}),
          ...(params.submit !== undefined ? { submit: params.submit } : {}),
        }),
      );
      return { content: [{ type: "text", text: `已向 ${params.ref} 输入 ${params.text.length} 个字符` }], details: {} };
    },
  };

  const select: AgentTool<typeof selectSchema> = {
    name: "browser_select",
    label: "选择",
    description: `选择下拉框里的一项。${OWN_WINDOW}`,
    parameters: selectSchema,
    execute: async (_id, params) => {
      const chosen = await bound.run((client) => client.select(bound.botId, params.ref, params.value));
      return { content: [{ type: "text", text: `已选择 ${chosen}` }], details: { value: chosen } };
    },
  };

  const scroll: AgentTool<typeof scrollSchema> = {
    name: "browser_scroll",
    label: "滚动",
    description: `滚动当前页面。${OWN_WINDOW}`,
    parameters: scrollSchema,
    execute: async (_id, params) => {
      const deltaX = params.deltaX ?? 0;
      const deltaY = params.deltaY ?? 400;
      await bound.run((client) => client.scroll(bound.botId, deltaX, deltaY, params.ref));
      return { content: [{ type: "text", text: `已滚动 ${deltaX}, ${deltaY}` }], details: { deltaX, deltaY } };
    },
  };

  const wait: AgentTool<typeof waitSchema> = {
    name: "browser_wait",
    label: "等待",
    description: "等待文字、选择器或固定毫秒。上限 30 秒。",
    parameters: waitSchema,
    execute: async (_id, params) => {
      if (params.text === undefined && params.selector === undefined && params.ms === undefined) {
        throw new Error("需要 text、selector 或 ms");
      }
      const text = await bound.run((client) =>
        client.waitFor(bound.botId, {
          ...(params.text !== undefined ? { text: params.text } : {}),
          ...(params.selector !== undefined ? { selector: params.selector } : {}),
          ...(params.ms !== undefined ? { ms: params.ms } : {}),
          ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        }),
      );
      return { content: [{ type: "text", text }], details: {} };
    },
  };

  const tabs: AgentTool<typeof tabsSchema> = {
    name: "browser_tabs",
    label: "标签页",
    description: `列出、切换或关闭这个 bot 窗口里的标签页。${OWN_WINDOW}`,
    parameters: tabsSchema,
    execute: async (_id, params) => {
      if (params.action === "list") {
        const rows = await bound.run((client) => client.listTabs(bound.botId));
        const text = rows.map((row) => `${row.index}${row.active ? " *" : ""}\t${row.title}\t${row.url}`).join("\n");
        return { content: [{ type: "text", text: text ? annotateTabList(text) : "（没有标签页）" }], details: { count: rows.length } };
      }
      if (params.action === "switch") {
        if (params.index === undefined) throw new Error("switch 需要 index");
        const url = await bound.run((client) => client.switchTab(bound.botId, params.index ?? 0));
        const text = await withChallengeProbe(bound, `已切换到 ${url}`);
        return { content: [{ type: "text", text }], details: { url } };
      }
      if (params.action === "close") {
        if (params.index === undefined) throw new Error("close 需要 index");
        await bound.run((client) => client.closeTab(bound.botId, params.index ?? 0));
        return { content: [{ type: "text", text: `已关闭标签页 ${params.index}` }], details: {} };
      }
      throw new Error("action 只能是 list、switch 或 close");
    },
  };

  return [open, snapshot, click, type, select, scroll, wait, tabs];
}

/** 导航结果带上页面地址。探测失败时仍按结果里的地址提示，不改变工具是否执行。 */
async function withChallengeProbe(bound: BoundBrowser, text: string): Promise<string> {
  try {
    const probed = await bound.run((client) => client.evaluate(bound.botId, CHALLENGE_PROBE));
    return annotatePage(text, probed);
  } catch {
    return annotatePage(text, null);
  }
}

export function browserScreenshotTool(bound: BoundBrowser): AgentTool<typeof emptySchema> {
  return {
    name: "browser_screenshot",
    label: "截图",
    description: `截取当前标签页，返回一张压缩过的 JPEG。${OWN_WINDOW}`,
    parameters: emptySchema,
    execute: async () => {
      const shot = await bound.run((client) => client.screenshotJpeg(bound.botId));
      return {
        content: [
          { type: "text", text: `截图 ${shot.width}x${shot.height}，${shot.data.length} 字节` },
          { type: "image", data: shot.data.toString("base64"), mimeType: "image/jpeg" },
        ],
        details: { width: shot.width, height: shot.height, bytes: shot.data.length },
      };
    },
  };
}
