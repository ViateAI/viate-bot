import type { AgentTool } from "@earendil-works/pi-agent-core";
import { num, obj, str } from "@earendil-works/pi-schema";
import type { DisplayInput, DisplayScreenshotResponse } from "@viate-bot/protocol";

const mouseSchema = obj({ x: num(), y: num(), button: num(), action: str() });
const keySchema = obj({ key: str(), action: str() });
const textSchema = obj({ text: str() });
const screenshotSchema = obj({});

export interface DesktopToolBinding {
  isActive: () => boolean;
  input: (input: DisplayInput, signal?: AbortSignal) => Promise<void>;
  screenshot: (signal?: AbortSignal) => Promise<DisplayScreenshotResponse>;
}

export function desktopTools(binding: DesktopToolBinding): AgentTool[] {
  const send = async (input: DisplayInput, signal?: AbortSignal) => {
    if (binding.isActive()) throw new Error("用户正在接管屏幕");
    await binding.input(input, signal);
    return { content: [{ type: "text" as const, text: "完成" }], details: {} };
  };
  const mouse: AgentTool<typeof mouseSchema> = {
    name: "desktop_mouse", label: "控制鼠标", description: "操作当前屏幕的鼠标。", parameters: mouseSchema,
    execute: async (_id, params, signal) => {
      if (![0, 1, 2].includes(params.button) || !["move", "down", "up"].includes(params.action)) throw new Error("鼠标参数无效");
      return send({ type: "mouse", x: params.x, y: params.y, button: params.button as 0 | 1 | 2, action: params.action as "move" | "down" | "up" }, signal);
    },
  };
  const key: AgentTool<typeof keySchema> = {
    name: "desktop_key", label: "控制键盘", description: "按下或释放按键。", parameters: keySchema,
    execute: async (_id, params, signal) => {
      if (!["down", "up"].includes(params.action)) throw new Error("按键动作无效");
      return send({ type: "key", key: params.key, down: params.action === "down" }, signal);
    },
  };
  const text: AgentTool<typeof textSchema> = {
    name: "desktop_type", label: "输入文字", description: "在当前屏幕输入文字。", parameters: textSchema,
    execute: async (_id, params, signal) => send({ type: "text", text: params.text }, signal),
  };
  const screenshot: AgentTool<typeof screenshotSchema> = {
    name: "desktop_screenshot", label: "查看屏幕", description: "读取当前屏幕截图。", parameters: screenshotSchema,
    execute: async (_id, _params, signal) => {
      const image = await binding.screenshot(signal);
      return { content: [{ type: "image", data: image.pngBase64, mimeType: image.mime }], details: { width: image.width, height: image.height } };
    },
  };
  return [mouse, key, text, screenshot];
}
