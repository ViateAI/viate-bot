import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { compactMessages, estimateTokens, installedAppsBlock } from "./prompt.js";

describe("installedAppsBlock", () => {
  it("lists names, versions, and secret references without plaintext", () => {
    expect(installedAppsBlock([])).toBe("");
    const text = installedAppsBlock([
      { name: "tara", version: "1.2.0", config: { MCP_TOKEN: { secret: true, secretRef: "corp", prefix: "Bearer " }, REGION: "eu" } },
      { name: "empty", version: "0.1.0", config: {} },
    ]);
    expect(text).toContain("mcp_inspect");
    expect(text).toContain("mcp_call");
    expect(text).toContain("tara (1.2.0) [已配置密钥引用: MCP_TOKEN->corp；其他已配置: REGION]");
    expect(text).toContain("empty (0.1.0) [未配置]");
    expect(text).not.toContain("eu");
    expect(text).not.toContain("Bearer ");
  });
});

describe("compactMessages", () => {
  it("drops the oldest group but keeps a tool call with its result", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "很早的一段对话，应该被整组丢掉，不能只删半截。", timestamp: 1 },
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
    expect(compacted.some((message) => message.role === "user" && message.content === "很早的一段对话，应该被整组丢掉，不能只删半截。")).toBe(false);
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
