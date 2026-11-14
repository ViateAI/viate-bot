import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { compactMessages, estimateTokens } from "./prompt.js";

describe("compactMessages", () => {
  it("drops the oldest group but keeps a tool call with its result", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "很早", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "shell_exec", arguments: { cmd: "true" } }],
        api: "openai-completions",
        provider: "viate-bot",
        model: "m",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "shell_exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "现在", timestamp: 4 },
    ];
    const budget = estimateTokens(messages.slice(1)) + 5;
    const compacted = compactMessages(messages, budget);
    expect(compacted.some((message) => message.role === "user" && message.content === "很早")).toBe(false);
    const assistant = compacted.findIndex((message) => message.role === "assistant");
    expect(compacted[assistant + 1]?.role).toBe("toolResult");
    expect(compacted[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(compacted[0])).toContain("已省略");
  });

  it("leaves a short transcript unchanged", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "短", timestamp: 1 }];
    expect(compactMessages(messages, 1000)).toBe(messages);
  });
});
