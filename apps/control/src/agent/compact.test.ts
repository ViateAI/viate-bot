import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Model, normalizeContext, type UserMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { applyCompaction, type CompactionHooks, estimateTextTokens, relayWithOverflowRetry, renderMessageForSummary, splitForSummary, type StoredSummary, summarySource } from "./compact.js";

const model: Model<"openai-completions"> = {
  id: "m", name: "m", api: "openai-completions", provider: "viate-bot", baseUrl: "http://127.0.0.1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4000, maxTokens: 100,
};

function answer(text: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 1,
  };
}

function user(text: string, timestamp: number): UserMessage {
  return { role: "user", content: text, timestamp };
}

function toolPair(id: string, text: string, timestamp: number): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "shell_exec", arguments: { cmd: "true" } }],
      api: "openai-completions",
      provider: "viate-bot",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "shell_exec",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: timestamp + 1,
    },
  ];
}

describe("splitForSummary", () => {
  it("keeps the latest user message and the tool group after it", () => {
    const early = toolPair("call-old", "甲".repeat(5600), 1);
    const latest = user("NEW-GOAL", 10);
    const kept = toolPair("call-new", "kept-result", 11);
    const messages = [user("OLD-GOAL", 1), ...early, latest, ...kept];
    const threshold = 2400;
    const split = splitForSummary(messages, 1200, threshold, false);
    expect(split.keep.some((message) => message.role === "user" && message.content === "NEW-GOAL")).toBe(true);
    expect(split.keep.some((message) => message.role === "toolResult" && message.toolCallId === "call-new")).toBe(true);
    expect(split.keep.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === "call-new"))).toBe(true);
    expect(split.evict.some((message) => message.role === "toolResult" && message.toolCallId === "call-old")).toBe(true);
    expect(split.evict.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === "call-old"))).toBe(true);
    expect(split.keep.some((message) => message.role === "toolResult" && message.toolCallId === "call-old")).toBe(false);
    expect(estimateTextTokens(split.keep)).toBeLessThan(threshold);
  });
});

describe("summary rendering", () => {
  it("replaces images and keeps secret placeholders in the incremental payload", () => {
    const previous = "摘要甲-固定";
    const evicted: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-old",
        toolName: "browser_screenshot",
        content: [
          { type: "text", text: "看到 {{secret:site_password}}" },
          { type: "image", data: "AAAAIMAGE", mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 2,
      },
    ];
    const source = summarySource(previous, evicted);
    expect(source).toContain("已有摘要：");
    expect(source).toContain("摘要甲-固定");
    expect(source).toContain("{{secret:site_password}}");
    expect(source).toContain("（一张图片，已省略）");
    expect(source).not.toContain("AAAAIMAGE");
    expect(renderMessageForSummary(evicted[0]!).includes("AAAAIMAGE")).toBe(false);
  });
});

describe("overflow relay", () => {
  it("forwards a normal text delta before the upstream response completes", async () => {
    const upstream = new AssistantMessageEventStream();
    const relay = relayWithOverflowRetry(() => upstream, 4000, async (messages) => messages);
    const output = await relay(model, normalizeContext({ messages: [user("hello", 1)] }));
    const iterator = output[Symbol.asyncIterator]();
    const partial = answer("first token");
    upstream.push({ type: "text_delta", contentIndex: 0, delta: "first token", partial });
    const first = iterator.next();
    try {
      // One event-loop turn, not a wall-clock timeout. Upstream stays open behind this assertion.
      const observed = await Promise.race([first, setImmediate().then(() => "buffered")]);
      expect(observed).toMatchObject({ done: false, value: { type: "text_delta", delta: "first token" } });
    } finally {
      upstream.push({ type: "done", reason: "stop", message: partial });
      await first;
      for await (const _event of output) { /* drain */ }
    }
  });

  it("retries overflow once and preserves the system prompt and tools", async () => {
    let calls = 0;
    let compactions = 0;
    const inner: StreamFn = (_model, context) => {
      calls += 1;
      expect(context.messages[0]).toMatchObject({ role: "system", content: "platform", toolsAdded: [{ name: "shell_exec" }] });
      const stream = new AssistantMessageEventStream();
      const error = { ...answer(""), stopReason: "error" as const, errorMessage: "Your input exceeds the context window of this model" };
      stream.push({ type: "error", reason: "error", error });
      return stream;
    };
    const relay = relayWithOverflowRetry(inner, 4000, async (messages) => { compactions += 1; return messages; });
    const output = await relay(model, normalizeContext({ messages: [{ role: "system", content: "platform", timestamp: 0, toolsAdded: [{ name: "shell_exec", description: "exec", parameters: { type: "object" } }] }, user("hello", 1)] }));
    const events = [];
    for await (const event of output) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect(calls).toBe(2);
    expect(compactions).toBe(1);
  });

  it("does not retry when cancellation arrives during forced compaction", async () => {
    const controller = new AbortController();
    let calls = 0;
    const relay = relayWithOverflowRetry(() => {
      calls += 1;
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: { ...answer(""), stopReason: "error", errorMessage: "Your input exceeds the context window of this model" } });
      return stream;
    }, 4000, async (messages, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return messages;
    });
    const output = await relay(model, normalizeContext({ messages: [user("hello", 1)] }), { signal: controller.signal });
    for await (const _event of output) { /* drain */ }
    expect(calls).toBe(1);
    expect((await output.result()).stopReason).toBe("aborted");
  });

  it.each(["stop", "length"] as const)("compacts and retries a %s response detected as overflow by usage", async (reason) => {
    let calls = 0;
    let compactions = 0;
    const relay = relayWithOverflowRetry(() => {
      calls += 1;
      const stream = new AssistantMessageEventStream();
      const message = answer(calls === 1 ? "" : "重试完成");
      if (calls === 1) {
        message.stopReason = reason;
        message.usage = { ...message.usage, input: 4001, output: 0, totalTokens: 4001 };
      }
      stream.push({ type: "done", reason: calls === 1 ? reason : "stop", message });
      return stream;
    }, 4000, async (messages) => { compactions += 1; return messages; });
    const output = await relay(model, normalizeContext({ messages: [user("hello", 1)] }));
    const events = [];
    for await (const event of output) events.push(event);
    expect(calls).toBe(2);
    expect(compactions).toBe(1);
    expect(events).toHaveLength(1);
    expect((await output.result()).content).toEqual([{ type: "text", text: "重试完成" }]);
  });

  it.each(["stop", "length"] as const)("keeps one assistant frame when a real Agent retries %s overflow after start", async (reason) => {
    let calls = 0;
    const laterAssistantCounts: number[] = [];
    const relay = relayWithOverflowRetry((_model, context) => {
      calls += 1;
      if (calls === 3) laterAssistantCounts.push(context.messages.filter((message) => message.role === "assistant").length);
      const stream = new AssistantMessageEventStream();
      const message = answer(calls === 1 ? "" : "重试完成");
      stream.push({ type: "start", partial: message });
      if (calls === 1) {
        message.stopReason = reason;
        message.usage = { ...message.usage, input: 4001, output: 0, totalTokens: 4001 };
      } else {
        stream.push({ type: "text_delta", contentIndex: 0, delta: "重试完成", partial: message });
      }
      stream.push({ type: "done", reason: calls === 1 ? reason : "stop", message });
      return stream;
    }, 4000, async (messages) => messages);
    const agent = new Agent({ initialState: { model }, streamFn: relay });
    agent.followUp(user("follow-up", 2));
    await agent.prompt("hello");
    const assistants = agent.state.messages.filter((message) => message.role === "assistant");
    expect(calls).toBe(3);
    expect(laterAssistantCounts).toEqual([1]);
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.content).toEqual([{ type: "text", text: "重试完成" }]);
  });
});

describe("compaction budgets", () => {
  function harness(messages: AgentMessage[], summaryText = "压缩后的目标和执行状态") {
    let stored: StoredSummary | undefined;
    let calls = 0;
    const hooks: CompactionHooks = {
      contextTokens: 10000, summaryMaxTokens: 500, sessionId: "task", model: { ...model, contextWindow: 10000, maxTokens: 1000 },
      stream: () => {
        calls += 1;
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: answer(summaryText) });
        return stream;
      },
      secrets: () => [], readSummary: () => stored,
      saveSummary: (text, untilMessageId) => { stored = { text, untilMessageId }; },
      idOf: (message) => { const index = messages.indexOf(message); return index < 0 ? undefined : `id-${index}`; },
      canSummarize: () => true,
      onCompacted: () => {}, beginSummary: () => {}, endSummary: () => {},
    };
    return { hooks, calls: () => calls };
  }

  it("counts system prompt and tool declarations before deciding whether to compact", async () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "平台".repeat(1750), timestamp: 0, toolsAdded: [{ name: "shell_exec", description: "工具".repeat(1750), parameters: { type: "object" } }] },
      user("旧记录".repeat(4900), 1), user("新的目标", 2),
    ];
    const { hooks, calls } = harness(messages);
    const compacted = await applyCompaction(messages, hooks);
    expect(calls()).toBe(1);
    expect(compacted[0]).toBe(messages[0]);
    expect(compacted).toContain(messages[2]);
    expect(estimateTextTokens(compacted)).toBeLessThan(6000);
  });

  it("reserves space for the summary instead of pinning a near-threshold user tail and summarizing every turn", async () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "S".repeat(2450), timestamp: 0 },
      user("旧用户", 1), ...toolPair("old", "旧".repeat(7000), 2),
      user("当前目标", 4), ...toolPair("middle", "中".repeat(10850), 5), ...toolPair("last", "末".repeat(7000), 7),
    ];
    const { hooks, calls } = harness(messages, "摘".repeat(1750));
    // This near-threshold tail fits without the new summary but not with it.
    const compacted = await applyCompaction(messages, hooks);
    expect(estimateTextTokens(compacted)).toBeLessThanOrEqual(6000);
    await applyCompaction(messages, hooks);
    expect(calls()).toBe(1);
    expect(compacted.some((message) => message.role === "toolResult" && message.toolCallId === "last")).toBe(true);
  });

  it("does not reuse pre-summary assistant usage when summary and response timestamps collide", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const oldAnswer = answer("旧回复");
      oldAnswer.timestamp = 1000;
      oldAnswer.usage = { ...oldAnswer.usage, input: 7000, totalTokens: 7000 };
      const messages = [user("旧".repeat(30000), 1), oldAnswer, user("当前目标", 1000)];
      const { hooks, calls } = harness(messages);
      const compacted = await applyCompaction(messages, hooks);
      expect(compacted).toContain(oldAnswer);
      await applyCompaction(messages, hooks);
      expect(calls()).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});
