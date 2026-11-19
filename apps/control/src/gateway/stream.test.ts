import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { eventRepository } from "../db/events.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { DEFAULT_PLATFORM_PROMPT } from "../db/settings.js";
import { saveModelRate } from "../model-rate.js";
import { taskRateWaiting } from "../model-rate.js";
import { saveGlobalTaskMaxSteps } from "../task-limits.js";
import { manualRateClock } from "./rate-limit.js";
import { buildModel, createGateway, type GatewayTask } from "./stream.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "vb-gw-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return db;
}

function task(secret = "super-secret-key"): GatewayTask {
  return {
    taskId: "task-1",
    botId: "bot-1",
    userId: "user-1",
    secret,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelCalls: 0,
    startedAt: Date.now(),
    activeMs: 0,
    segmentStartedAt: Date.now(),
  };
}

function sse(lines: string[], status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

function textSse(text: string, prompt = 1, completion = 1, cached = 0): Response {
  return sse([
    JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } },
    }),
    "[DONE]",
  ]);
}

async function finish(stream: AssistantMessageEventStream | Promise<AssistantMessageEventStream>): Promise<AssistantMessage> {
  const resolved = await stream;
  for await (const _event of resolved) {
    // 把流读完，result() 才会在 done/error 上完成。
  }
  return resolved.result();
}

describe("model gateway", () => {
  it.each(["steps", "duration"])("does not synthesize a successful conclusion after reaching %s limit", async (limit) => {
    const db = database();
    try {
      const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1" });
      const current = task();
      if (limit === "steps") current.modelCalls = config.maxTaskSteps;
      else {
        current.activeMs = (config.maxTaskDurationSec + 1) * 1000;
        current.segmentStartedAt = null;
      }
      const gateway = createGateway({ db, config, tasks: new Map([["task-1", current]]), fetch: async () => { throw new Error("must not call upstream"); } });
      const message = await finish(gateway(buildModel(config, "gpt-test"), { messages: [] }, { sessionId: "task-1" }));
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toContain(limit === "steps" ? "步数上限" : "时长上限");
    } finally { db.$client.close(); }
  });

  it("rejects a stream that closes without a finish reason instead of inventing normal stop", async () => {
    const db = database();
    try {
      const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1" });
      const gateway = createGateway({ db, config, tasks: new Map([["task-1", task()]]), fetch: async () => sse([JSON.stringify({ choices: [{ delta: { content: "unfinished" }, finish_reason: null }] }), "[DONE]"]) });
      const message = await finish(gateway(buildModel(config, "gpt-test"), { messages: [] }, { sessionId: "task-1" }));
      expect(message.stopReason).toBe("error");
    } finally { db.$client.close(); }
  });

  it("rejects a model outside the whitelist without calling upstream", async () => {
    const db = database();
    let calls = 0;
    const tasks = new Map([["task-1", task()]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MODELS: "gpt-test" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        return textSse("no");
      },
    });
    const message = await finish(
      gateway(buildModel(config, "other"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }),
    );
    expect(calls).toBe(0);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("白名单");
    db.$client.close();
  });

  it("stores a 4xx on the task stream and does not retry, with the key redacted", async () => {
    const db = database();
    const secret = "super-secret-key";
    let calls = 0;
    const tasks = new Map([["task-1", task(secret)]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MODELS: "" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: `quota ${secret}` } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const message = await finish(
      gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1", apiKey: "not-the-key" }),
    );
    expect(calls).toBe(1);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("[redacted]");
    expect(message.errorMessage).not.toContain(secret);
    const attrs = eventRepository(db).listByBot("bot-1").map((event) => event.attrsJson).join("\n");
    expect(attrs).not.toContain(secret);
    expect(attrs).toContain("[redacted]");
    db.$client.close();
  });

  it("retries a 5xx twice and then accepts the third response", async () => {
    const db = database();
    let calls = 0;
    const tasks = new Map([["task-1", task()]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        if (calls < 3) return new Response("no", { status: 503 });
        return textSse("好了");
      },
    });
    const message = await finish(
      gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }),
    );
    expect(calls).toBe(3);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "好了" }]);
    db.$client.close();
  });

  it("retries a network error twice", async () => {
    const db = database();
    let calls = 0;
    const tasks = new Map([["task-1", task()]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        if (calls < 3) throw new Error("socket hang up");
        return textSse("回来了");
      },
    });
    const message = await finish(
      gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }),
    );
    expect(calls).toBe(3);
    expect(message.content).toEqual([{ type: "text", text: "回来了" }]);
    db.$client.close();
  });

  it("prepends the platform prompt once and sends the bearer token from the task, not the request", async () => {
    const db = database();
    const seen: Array<{ auth: string; body: { messages?: Array<{ role: string; content: string }> } }> = [];
    const tasks = new Map([["task-1", task("super-secret-key")]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1/" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async (input, init) => {
        seen.push({
          auth: String((init?.headers as Record<string, string>).authorization),
          body: JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> },
        });
        expect(String(input)).toBe("http://model.test/v1/chat/completions");
        return textSse("ok");
      },
    });
    const model = buildModel(config, "gpt-test");
    await finish(
      gateway(model, { systemPrompt: "bot 指令", messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1", apiKey: "ignore-me" }),
    );
    await finish(
      gateway(
        model,
        { systemPrompt: `${DEFAULT_PLATFORM_PROMPT}\n\nbot 指令`, messages: [{ role: "user", content: "hi", timestamp: 1 }] },
        { sessionId: "task-1" },
      ),
    );
    expect(seen[0]?.auth).toBe("Bearer super-secret-key");
    expect(seen[0]?.body.messages?.[0]?.content.startsWith(DEFAULT_PLATFORM_PROMPT)).toBe(true);
    expect(seen[0]?.body.messages?.[0]?.content).toContain("bot 指令");
    const duplicated = seen[1]?.body.messages?.[0]?.content ?? "";
    expect(duplicated.indexOf(DEFAULT_PLATFORM_PROMPT)).toBe(duplicated.lastIndexOf(DEFAULT_PLATFORM_PROMPT));
    db.$client.close();
  });

  it("stops on the per-task token budget without another upstream call", async () => {
    const db = database();
    let calls = 0;
    const current = task();
    const tasks = new Map([["task-1", current]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_TASK_TOKEN_BUDGET: "10" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        return textSse("一次", 6, 6);
      },
    });
    const model = buildModel(config, "gpt-test");
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
    const first = await finish(gateway(model, context, { sessionId: "task-1" }));
    const second = await finish(gateway(model, context, { sessionId: "task-1" }));
    expect(first.stopReason).toBe("stop");
    expect(calls).toBe(1);
    expect(second.stopReason).toBe("error");
    expect(second.errorMessage).toBe("已达到单任务 token 预算（已用 12 / 上限 10）");
    db.$client.close();
  });

  it("does not charge cached prompt tokens against the task budget", async () => {
    const db = database();
    const current = task();
    current.tokenBudget = 10;
    const tasks = new Map([["task-1", current]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_TASK_TOKEN_BUDGET: "10" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async () => textSse("ok", 20, 3, 16),
    });
    const message = await finish(gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }));
    expect(message.stopReason).toBe("stop");
    expect(current.inputTokens).toBe(20);
    expect(current.cacheReadTokens).toBe(16);
    expect(current.tokensUsed).toBe(7);
    db.$client.close();
  });

  it("waits out a full window and then completes the call", async () => {
    const db = database();
    const clock = manualRateClock(1_000_000);
    let calls = 0;
    const current = task();
    current.startedAt = clock.now();
    const tasks = new Map([["task-1", current]]);
    const config = loadConfig({
      VB_MODEL_BASE_URL: "http://model.test/v1",
      VB_MODEL_RATE_USER: "1",
      VB_MODEL_RATE_BOT: "10",
      VB_MAX_TASK_DURATION_SEC: "600",
    });
    const gateway = createGateway({
      db,
      config,
      tasks,
      clock,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        return textSse("ok");
      },
    });
    const model = buildModel(config, "gpt-test");
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
    const first = await finish(gateway(model, context, { sessionId: "task-1" }));
    expect(first.stopReason).toBe("stop");
    expect(calls).toBe(1);
    const second = finish(gateway(model, context, { sessionId: "task-1" }));
    await clock.untilSleeping();
    expect(taskRateWaiting("task-1")).toBe(true);
    expect(calls).toBe(1);
    expect(current.modelCalls).toBe(1);
    clock.advance(60_000);
    const resumed = await second;
    expect(resumed.stopReason).toBe("stop");
    expect(calls).toBe(2);
    expect(taskRateWaiting("task-1")).toBe(false);
    db.$client.close();
  });

  it("does not call the model when the wait is aborted", async () => {
    const db = database();
    const clock = manualRateClock(1_000_000);
    let calls = 0;
    const current = task();
    current.startedAt = clock.now();
    const tasks = new Map([["task-1", current]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MODEL_RATE_USER: "1", VB_MODEL_RATE_BOT: "1" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      clock,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        return textSse("ok");
      },
    });
    const model = buildModel(config, "gpt-test");
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
    await finish(gateway(model, context, { sessionId: "task-1" }));
    const controller = new AbortController();
    const waiting = finish(gateway(model, context, { sessionId: "task-1", signal: controller.signal }));
    await clock.untilSleeping();
    controller.abort();
    const stopped = await waiting;
    expect(stopped.stopReason).toBe("aborted");
    expect(taskRateWaiting("task-1")).toBe(false);
    expect(calls).toBe(1);
    expect(current.modelCalls).toBe(1);
    db.$client.close();
  });

  it("does not count a rate-limit wait toward the task duration", async () => {
    const db = database();
    const clock = manualRateClock(1_000_000);
    let calls = 0;
    const current = task();
    current.startedAt = clock.now();
    current.activeMs = 0;
    current.segmentStartedAt = clock.now();
    const tasks = new Map([["task-1", current]]);
    const config = loadConfig({
      VB_MODEL_BASE_URL: "http://model.test/v1",
      VB_MODEL_RATE_USER: "1",
      VB_MODEL_RATE_BOT: "1",
      VB_MAX_TASK_DURATION_SEC: "30",
    });
    const gateway = createGateway({
      db,
      config,
      tasks,
      clock,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        return textSse("ok");
      },
    });
    const model = buildModel(config, "gpt-test");
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
    await finish(gateway(model, context, { sessionId: "task-1" }));
    const waiting = finish(gateway(model, context, { sessionId: "task-1" }));
    await clock.untilSleeping();
    clock.advance(30_000);
    expect(taskRateWaiting("task-1")).toBe(true);
    clock.advance(30_000);
    const resumed = await waiting;
    expect(resumed.stopReason).toBe("stop");
    expect(taskRateWaiting("task-1")).toBe(false);
    expect(calls).toBe(2);
    expect(current.modelCalls).toBe(2);
    expect(current.activeMs).toBeLessThan(30_000);
    db.$client.close();
  });

  it("applies a global step cap to the next call and lets 0 mean unlimited", async () => {
    const db = database();
    db.$client.exec("insert into users (id,email,name,status,created_at) values ('user-1','u@x','u','active','now')");
    let calls = 0;
    const current = task();
    const tasks = new Map([["task-1", current]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MAX_TASK_STEPS: "200" });
    saveGlobalTaskMaxSteps(db, 1);
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        return textSse("ok");
      },
    });
    const model = buildModel(config, "gpt-test");
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
    const first = await finish(gateway(model, context, { sessionId: "task-1" }));
    const second = await finish(gateway(model, context, { sessionId: "task-1" }));
    expect(first.stopReason).toBe("stop");
    expect(second.stopReason).toBe("error");
    expect(second.errorMessage).toBe("已用 1 步，达到步数上限。回复“继续”可以接着做。");
    expect(calls).toBe(1);
    saveGlobalTaskMaxSteps(db, 0);
    const third = await finish(gateway(model, context, { sessionId: "task-1" }));
    expect(third.stopReason).toBe("stop");
    expect(calls).toBe(2);
    db.$client.close();
  });

  it("applies a model rate change to a call that is already waiting", async () => {
    const db = database();
    const clock = manualRateClock(1_000_000);
    let calls = 0;
    const current = task();
    current.startedAt = clock.now();
    const tasks = new Map([["task-1", current]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MODEL_RATE_USER: "1", VB_MODEL_RATE_BOT: "1" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      clock,
      retryDelays: [0, 0],
      fetch: async () => {
        calls += 1;
        return textSse("ok");
      },
    });
    const model = buildModel(config, "gpt-test");
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
    await finish(gateway(model, context, { sessionId: "task-1" }));
    const waiting = finish(gateway(model, context, { sessionId: "task-1" }));
    await clock.untilSleeping();
    expect(calls).toBe(1);
    saveModelRate(db, { userPerMin: 0, botPerMin: 0 });
    const resumed = await waiting;
    expect(resumed.stopReason).toBe("stop");
    expect(calls).toBe(2);
    expect(clock.now()).toBe(1_000_000);
    db.$client.close();
  });

  it("posts to the responses API when that protocol is configured", async () => {
    const db = database();
    let url = "";
    let body = "";
    const tasks = new Map([["task-1", task()]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MODEL_API: "openai-responses" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async (input, init) => {
        url = String(input);
        body = String(init?.body);
        return sse([
          JSON.stringify({ type: "response.output_text.delta", delta: "响应" }),
          JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
        ]);
      },
    });
    const message = await finish(
      gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }),
    );
    expect(url).toBe("http://model.test/v1/responses");
    expect(body).toContain("\"instructions\"");
    expect(body).toContain("max_output_tokens");
    expect(message.content).toEqual([{ type: "text", text: "响应" }]);
    db.$client.close();
  });

  it("omits an aborted assistant turn that has no text and no tool call", async () => {
    const db = database();
    let body = "";
    const tasks = new Map([["task-1", task()]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1" });
    const gateway = createGateway({
      db,
      config,
      tasks,
      retryDelays: [0, 0],
      fetch: async (_input, init) => {
        body = String(init?.body);
        return textSse("继续");
      },
    });
    const usage = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const called: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "shell_exec", arguments: { cmd: "true" } }],
      api: "openai-completions", provider: "viate-bot", model: "gpt-test",
      usage, stopReason: "toolUse", timestamp: 1,
    };
    const aborted: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: "openai-completions", provider: "viate-bot", model: "gpt-test",
      usage, stopReason: "aborted", timestamp: 3, errorMessage: "已停止",
    };
    await finish(gateway(buildModel(config, "gpt-test"), {
      messages: [
        called,
        { role: "toolResult", toolCallId: "call-1", toolName: "shell_exec", content: [{ type: "text", text: "Operation aborted" }], isError: true, timestamp: 2 },
        aborted,
        { role: "user", content: "继续", timestamp: 4 },
      ],
    }, { sessionId: "task-1" }));
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || !("messages" in parsed) || !Array.isArray(parsed.messages)) {
      throw new Error("请求里没有 messages");
    }
    const messages = parsed.messages.flatMap((item) => {
      if (!item || typeof item !== "object" || !("role" in item) || !("content" in item)) return [];
      const role = item.role;
      const content = item.content;
      if (typeof role !== "string" || (content !== null && typeof content !== "string")) return [];
      const toolCalls = "tool_calls" in item && Array.isArray(item.tool_calls) ? item.tool_calls : undefined;
      return [{ role, content, tool_calls: toolCalls }];
    });
    expect(messages.filter((item) => item.role === "assistant")).toEqual([
      expect.objectContaining({ content: null, tool_calls: [expect.objectContaining({ id: "call-1" })] }),
    ]);
    expect(messages.some((item) => item.role === "assistant" && item.content === null && item.tool_calls === undefined)).toBe(false);
    expect(messages.some((item) => item.role === "user" && item.content === "继续")).toBe(true);
    db.$client.close();
  });

  it("rejects a final reply that crosses the duration cap", async () => {
    const db = database();
    let nowMs = 1_000_000;
    const current = task();
    current.startedAt = nowMs;
    current.segmentStartedAt = nowMs;
    current.activeMs = 0;
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MAX_TASK_DURATION_SEC: "30" });
    const gateway = createGateway({
      db,
      config,
      tasks: new Map([["task-1", current]]),
      now: () => new Date(nowMs),
      fetch: async () => {
        nowMs += 40_000;
        return textSse("最终回复");
      },
    });
    const message = await finish(gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }));
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("达到时长上限");
    expect(message.errorMessage).not.toContain("已停止");
    db.$client.close();
  });

  it("aborts a hanging model request when the remaining active time is gone", async () => {
    const db = database();
    let nowMs = 2_000_000;
    let aborted = false;
    const current = task();
    current.startedAt = nowMs;
    current.segmentStartedAt = nowMs;
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MAX_TASK_DURATION_SEC: "30" });
    const gateway = createGateway({
      db,
      config,
      tasks: new Map([["task-1", current]]),
      now: () => new Date(nowMs),
      retryDelays: [0, 0],
      fetch: async (_input, init) => {
        nowMs += 40_000;
        await new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const fail = () => {
            aborted = true;
            reject(new Error("aborted"));
          };
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        });
        return textSse("太晚");
      },
    });
    const message = await finish(gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }));
    expect(aborted).toBe(true);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("达到时长上限");
    db.$client.close();
  });

  it("keeps a user stop distinct from the duration cap", async () => {
    const db = database();
    const controller = new AbortController();
    const current = task();
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MAX_TASK_DURATION_SEC: "30" });
    const gateway = createGateway({
      db,
      config,
      tasks: new Map([["task-1", current]]),
      retryDelays: [0, 0],
      fetch: async (_input, init) => {
        controller.abort();
        await new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const fail = () => reject(new Error("aborted"));
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        });
        return textSse("不该成功");
      },
    });
    const message = await finish(gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1", signal: controller.signal }));
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBe("已停止");
    db.$client.close();
  });

  it("does not apply a duration cap when the limit is 0", async () => {
    const db = database();
    let nowMs = 3_000_000;
    const current = task();
    current.startedAt = nowMs;
    current.segmentStartedAt = nowMs;
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MAX_TASK_DURATION_SEC: "0" });
    const gateway = createGateway({
      db,
      config,
      tasks: new Map([["task-1", current]]),
      now: () => new Date(nowMs),
      fetch: async () => {
        nowMs += 200_000;
        return textSse("不受限");
      },
    });
    const message = await finish(gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }));
    expect(message.stopReason).toBe("stop");
    expect(message.errorMessage).toBeUndefined();
    db.$client.close();
  });

  it("aborts a hung request at 120s without recording the duration cap", async () => {
    vi.useFakeTimers();
    const timeout = fakeNetworkTimeout();
    let failHang: (error: Error) => void = () => {};
    let hung = false;
    const db = database();
    try {
      let fetches = 0;
      const nowMs = 5_000_000;
      const current = task();
      current.startedAt = nowMs;
      current.segmentStartedAt = nowMs;
      current.activeMs = 0;
      const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MAX_TASK_DURATION_SEC: "3600" });
      const gateway = createGateway({
        db,
        config,
        tasks: new Map([["task-1", current]]),
        now: () => new Date(nowMs),
        retryDelays: [0, 0],
        fetch: async (_input, init) => {
          fetches += 1;
          await new Promise((_resolve, reject) => {
            failHang = reject;
            const signal = init?.signal;
            const fail = () => {
              hung = true;
              const reason = signal?.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            };
            if (signal?.aborted) fail();
            else signal?.addEventListener("abort", fail, { once: true });
          });
          return textSse("太晚");
        },
      });
      const pending = finish(gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(timeout).toHaveBeenCalledWith(120_000);
      expect(hung).toBe(true);
      await vi.advanceTimersByTimeAsync(240_000);
      const message = await pending;
      expect(fetches).toBe(3);
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toBe("The operation was aborted due to timeout");
      expect(message.errorMessage).not.toContain("达到时长上限");
    } finally {
      if (!hung) failHang(new Error("hung request cancelled"));
      timeout.mockRestore();
      vi.useRealTimers();
      db.$client.close();
    }
  });

  it.each(["network", "duration"] as const)("keeps the first %s abort when transport rejection is delayed", async (first) => {
    vi.useFakeTimers();
    const timeout = fakeNetworkTimeout();
    const db = database();
    try {
      const current = task();
      current.activeMs = first === "network" ? 9_900 : 10_100;
      const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MAX_TASK_DURATION_SEC: "130" });
      const gateway = createGateway({
        db,
        config,
        tasks: new Map([["task-1", current]]),
        retryDelays: [],
        fetch: async (_input, init) => {
          const { promise, reject } = Promise.withResolvers<never>();
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            const reason = signal.reason;
            setTimeout(() => reject(reason), 200);
          }, { once: true });
          await promise;
          return textSse("太晚");
        },
      });
      const pending = finish(gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }));
      await vi.advanceTimersByTimeAsync(120_300);
      const message = await pending;
      expect(message.stopReason).toBe("error");
      if (first === "network") expect(message.errorMessage).toBe("The operation was aborted due to timeout");
      else expect(message.errorMessage).toContain("达到时长上限");
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
      db.$client.close();
    }
  });

  it.each(["success", "4xx", "5xx", "network-error"] as const)("clears active-limit timers after %s", async (outcome) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    const db = database();
    try {
      let fetches = 0;
      const config = loadConfig({
        VB_MODEL_BASE_URL: "http://model.test/v1",
        VB_MAX_TASK_DURATION_SEC: "3600",
        VB_MODEL_RATE_USER: "0",
        VB_MODEL_RATE_BOT: "0",
      });
      const gateway = createGateway({
        db,
        config,
        tasks: new Map([["task-1", task()]]),
        retryDelays: [0, 0],
        fetch: async () => {
          fetches += 1;
          if (outcome === "network-error") throw new Error("connection reset");
          if (outcome === "4xx") return new Response("bad request", { status: 400 });
          if (outcome === "5xx") return new Response("unavailable", { status: 503 });
          return textSse("完成");
        },
      });
      const message = await finish(gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }));
      expect(message.stopReason).toBe(outcome === "success" ? "stop" : "error");
      expect(fetches).toBe(outcome === "success" || outcome === "4xx" ? 1 : 3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      timeout.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
      db.$client.close();
    }
  });

  it("records a duration cap when remaining active time runs out before 120s", async () => {
    vi.useFakeTimers();
    const timeout = fakeNetworkTimeout();
    let failHang: (error: Error) => void = () => {};
    let hung = false;
    const db = database();
    try {
      let fetches = 0;
      let nowMs = 6_000_000;
      const current = task();
      current.startedAt = nowMs;
      current.segmentStartedAt = nowMs;
      current.activeMs = 3_590_000;
      const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MAX_TASK_DURATION_SEC: "3600" });
      const gateway = createGateway({
        db,
        config,
        tasks: new Map([["task-1", current]]),
        now: () => new Date(nowMs),
        retryDelays: [0, 0],
        fetch: async (_input, init) => {
          fetches += 1;
          nowMs += 10_000;
          await new Promise((_resolve, reject) => {
            failHang = reject;
            const signal = init?.signal;
            const fail = () => {
              hung = true;
              const reason = signal?.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            };
            if (signal?.aborted) fail();
            else signal?.addEventListener("abort", fail, { once: true });
          });
          return textSse("太晚");
        },
      });
      const pending = finish(gateway(buildModel(config, "gpt-test"), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "task-1" }));
      await vi.advanceTimersByTimeAsync(50);
      const message = await pending;
      expect(hung).toBe(true);
      expect(fetches).toBe(1);
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toContain("达到时长上限");
      expect(message.errorMessage).not.toContain("The operation was aborted due to timeout");
      expect(timeout).toHaveBeenCalledWith(120_000);
    } finally {
      if (!hung) failHang(new Error("hung request cancelled"));
      timeout.mockRestore();
      vi.useRealTimers();
      db.$client.close();
    }
  });
});

describe("user images", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");

  it("puts the user image in chat completions and responses requests", async () => {
    const db = database();
    const bodies: unknown[] = [];
    const tasks = new Map([["task-1", task()]]);
    const completions = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_VISION_MODELS: "gpt-test" });
    const responses = loadConfig({
      VB_MODEL_BASE_URL: "http://model.test/v1",
      VB_VISION_MODELS: "gpt-test",
      VB_MODEL_API: "openai-responses",
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input?: unknown };
      bodies.push(body);
      if (body.input) {
        return sse([
          JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
          JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } }),
        ]);
      }
      return textSse("ok");
    };
    const message = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "看一下\n附件：/home/bot/uploads/m1/dot.png（1 KB，image/png）" },
        { type: "image" as const, data: png, mimeType: "image/png" },
      ],
      timestamp: 1,
    };
    await finish(createGateway({ db, config: completions, tasks, retryDelays: [0, 0], fetch: fetchImpl })(
      buildModel(completions, "gpt-test"),
      { messages: [message] },
      { sessionId: "task-1" },
    ));
    await finish(createGateway({ db, config: responses, tasks, retryDelays: [0, 0], fetch: fetchImpl })(
      buildModel(responses, "gpt-test"),
      { messages: [message] },
      { sessionId: "task-1" },
    ));
    const chat = JSON.stringify(bodies[0]);
    const response = JSON.stringify(bodies[1]);
    expect(chat).toContain(`data:image/png;base64,${png}`);
    expect(chat).toContain("image_url");
    expect(response).toContain(`data:image/png;base64,${png}`);
    expect(response).toContain("input_image");
    const blind = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1" });
    await finish(createGateway({ db, config: blind, tasks, retryDelays: [0, 0], fetch: fetchImpl })(
      buildModel(blind, "gpt-test"),
      { messages: [message] },
      { sessionId: "task-1" },
    ));
    expect(JSON.stringify(bodies[2])).not.toContain(png);
    db.$client.close();
  });
});

/** AbortSignal.timeout uses Node's internal timer, which fake timers do not reach. */
function fakeNetworkTimeout() {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    }, Number(ms));
    timer.unref?.();
    return controller.signal;
  });
}
