import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { eventRepository } from "../db/events.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { DEFAULT_PLATFORM_PROMPT } from "../db/settings.js";
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

function textSse(text: string, prompt = 1, completion = 1): Response {
  return sse([
    JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: prompt, completion_tokens: completion },
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
    expect(second.stopReason).toBe("stop");
    expect(second.content[0]).toMatchObject({ type: "text" });
    expect((second.content[0] as { text: string }).text).toContain("token 预算");
    db.$client.close();
  });

  it("rate limits the second call for a user", async () => {
    const db = database();
    let calls = 0;
    const tasks = new Map([["task-1", task()]]);
    const config = loadConfig({ VB_MODEL_BASE_URL: "http://model.test/v1", VB_MODEL_RATE_USER: "1", VB_MODEL_RATE_BOT: "10" });
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
    await finish(gateway(model, context, { sessionId: "task-1" }));
    const limited = await finish(gateway(model, context, { sessionId: "task-1" }));
    expect(calls).toBe(1);
    expect(limited.stopReason).toBe("error");
    expect(limited.errorMessage).toContain("频繁");
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
});
