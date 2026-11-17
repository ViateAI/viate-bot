import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj } from "@earendil-works/pi-schema";

const schema = obj({});

export function takeoverTool(binding: { request: (signal?: AbortSignal) => Promise<void> }): AgentTool {
  return {
    name: "request_takeover",
    label: "请求接管",
    description: "请求用户接管屏幕，等待用户交还后继续。",
    parameters: schema,
    execute: async (_id, _params, signal) => {
      await binding.request(signal);
      return { content: [{ type: "text", text: "用户已交还屏幕。" }], details: {} };
    },
  };
}
