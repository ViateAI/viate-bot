import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { ControlConfig } from "../config.js";
import { emitOps, opsMinutes } from "../ops/rollup.js";
import type { AppDatabase } from "../db/index.js";
import { settingsRepository } from "../db/settings.js";
import { usageRepository } from "../db/usage.js";
import { ulid } from "../id.js";
import { withPlatformPrompt } from "../agent/prompt.js";
import { hourBucket, redactSecret } from "../agent/text.js";
import { readError } from "../machines/client.js";

export interface GatewayTask {
  taskId: string;
  botId: string;
  userId: string;
  secret: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelCalls: number;
  startedAt: number;
  /** 摘要调用记用量和 token 预算，不占 VB_MAX_TASK_STEPS。 */
  skipStep?: boolean;
}

export interface GatewayDeps {
  db: AppDatabase;
  config: ControlConfig;
  tasks: Map<string, GatewayTask>;
  fetch?: typeof fetch;
  now?: () => Date;
  retryDelays?: number[];
}

const DEFAULT_DELAYS = [200, 800];

export function createGateway(deps: GatewayDeps): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const delays = deps.retryDelays ?? DEFAULT_DELAYS;
  const limiter = createLimiter(() => now().getTime());
  return (model, context, options) => {
    const stream = new ModelEventStream();
    const task = deps.tasks.get(options?.sessionId ?? "");
    const parts = requestParts(context);
    void run(stream, model, parts.system, parts.messages, parts.tools, options?.signal, task).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "模型请求失败";
      pushError(stream, model, redactSecret(message, task?.secret ?? ""));
    });
    return stream as unknown as AssistantMessageEventStream;

    async function run(
      target: ModelEventStream,
      current: Model<Api>,
      system: string | undefined,
      messages: ConversationMessage[],
      tools: ToolDeclaration[] | undefined,
      signal: AbortSignal | undefined,
      currentTask: GatewayTask | undefined,
    ): Promise<void> {
      if (!currentTask) {
        pushError(target, current, "模型网关没有这个任务的凭据");
        return;
      }
      const secret = currentTask.secret;
      const limit = limitReason(deps.config, currentTask, now().getTime());
      if (limit) {
        pushStop(target, current, limit);
        record(deps, currentTask, current.id, emptyUsage(), now(), 0, null, "model.skipped");
        return;
      }
      if (deps.config.models.length > 0 && !deps.config.models.includes(current.id)) {
        pushError(target, current, `模型不在白名单内: ${current.id}`);
        record(deps, currentTask, current.id, emptyUsage(), now(), 0, `模型不在白名单内: ${current.id}`, "model.request");
        return;
      }
      if (
        !limiter.allow(`user:${currentTask.userId}`, deps.config.modelRateUserPerMin) ||
        !limiter.allow(`bot:${currentTask.botId}`, deps.config.modelRateBotPerMin)
      ) {
        pushError(target, current, "请求过于频繁");
        record(deps, currentTask, current.id, emptyUsage(), now(), 0, "请求过于频繁", "model.request");
        return;
      }
      const platform = settingsRepository(deps.db).platformPrompt().text;
      const systemPrompt = withPlatformPrompt(platform, system);
      const maxTokens = Math.min(options?.maxTokens ?? deps.config.modelMaxTokens, deps.config.modelMaxTokens);
      if (currentTask.skipStep !== true) currentTask.modelCalls += 1;
      const started = now();
      let attempts = 0;
      let lastError = "模型请求失败";
      while (attempts <= delays.length) {
        if (signal?.aborted) {
          pushAborted(target, current);
          return;
        }
        attempts += 1;
        let emitted = false;
        try {
          const response = await fetchImpl(endpoint(deps.config, current), {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(requestBody(deps.config, current, systemPrompt, messages, tools, maxTokens)),
            signal: combineSignal(signal),
          });
          if (response.status >= 500) {
            lastError = redactSecret(await readError(response), secret);
            if (attempts <= delays.length) {
              await sleep(delays[attempts - 1] ?? 0, signal);
              continue;
            }
            break;
          }
          if (response.status >= 400) {
            lastError = redactSecret(await readError(response), secret);
            pushError(target, current, lastError);
            record(deps, currentTask, current.id, emptyUsage(), started, attempts, lastError, "model.request");
            return;
          }
          const usage = await readModelStream(response, current, target, () => {
            emitted = true;
          });
          addUsage(currentTask, usage);
          record(deps, currentTask, current.id, usage, started, attempts, null, "model.request");
          return;
        } catch (error) {
          if (signal?.aborted) {
            pushAborted(target, current);
            return;
          }
          lastError = redactSecret(error instanceof Error ? error.message : "网络错误", secret);
          if (emitted || attempts > delays.length) break;
          await sleep(delays[attempts - 1] ?? 0, signal);
        }
      }
      pushError(target, current, lastError);
      record(deps, currentTask, current.id, emptyUsage(), started, attempts, lastError, "model.request");
    }
  };
}

function limitReason(config: ControlConfig, task: GatewayTask, nowMs: number): string | undefined {
  if (task.tokensUsed >= config.taskTokenBudget) return "已达到单任务 token 预算，这次先停下来。回复后可以继续。";
  if (task.modelCalls >= config.maxTaskSteps) return "已达到步数上限，这次先停下来。回复后可以继续。";
  if (nowMs - task.startedAt >= config.maxTaskDurationSec * 1000) return "已达到时长上限，这次先停下来。回复后可以继续。";
  return undefined;
}

type ConversationMessage = UserMessage | AssistantMessage | ToolResultMessage;
type ToolDeclaration = { name: string; description: string; parameters: unknown };

/**
 * 1.5.2 的 streamFn 收到的是 TranscriptContext：提示词和工具在 system 消息里。
 * 测试和旧的 Context 仍可能把 systemPrompt / tools 放在字段上。两边都认，对话消息里不再重复发送 system。
 */
function requestParts(context: Context): { system: string; messages: ConversationMessage[]; tools: ToolDeclaration[] } {
  const transcript = getCurrentSystemPrompt(context.messages);
  const system = context.systemPrompt && context.systemPrompt.length > 0 ? context.systemPrompt : transcript;
  const declared = getCurrentTools(context.messages);
  const tools = context.tools && context.tools.length > 0 ? context.tools : declared;
  const messages = context.messages.filter((message): message is ConversationMessage => message.role !== "system");
  return { system, messages, tools };
}

function endpoint(config: ControlConfig, model: Model<Api>): string {
  const path = config.modelApi === "openai-responses" ? "responses" : "chat/completions";
  const base = model.baseUrl || config.modelBaseUrl;
  const trimmed = base.endsWith("/") ? base : `${base}/`;
  return new URL(path, trimmed).toString();
}

function requestBody(
  config: ControlConfig,
  model: Model<Api>,
  systemPrompt: string,
  messages: ConversationMessage[],
  tools: ToolDeclaration[] | undefined,
  maxTokens: number,
): unknown {
  if (config.modelApi === "openai-responses") {
    return {
      model: model.id,
      instructions: systemPrompt,
      input: messages.map((message) => toResponsesItem(message, model)),
      stream: true,
      max_output_tokens: maxTokens,
      ...(tools && tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }
        : {}),
    };
  }
  return {
    model: model.id,
    messages: toChatMessages(systemPrompt, messages, model),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    ...(tools && tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
  };
}

function toChatMessages(system: string, messages: ConversationMessage[], model: Model<Api>): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  const vision = model.input.includes("image");
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: textContent(message.content) });
    } else if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const calls = message.content.filter((block) => block.type === "toolCall");
      const item: Record<string, unknown> = { role: "assistant", content: text.length > 0 ? text : null };
      if (calls.length > 0) {
        item.tool_calls = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }));
      }
      out.push(item);
    } else {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: textContent(message.content) });
      const images = vision ? imageParts(message.content) : [];
      if (images.length > 0) {
        out.push({
          role: "user",
          content: [{ type: "text", text: "工具返回的图片：" }, ...images],
        });
      }
    }
  }
  return out;
}

function toResponsesItem(message: ConversationMessage, model: Model<Api>): unknown {
  if (message.role === "user") return { role: "user", content: textContent(message.content) };
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    };
  }
  const images = model.input.includes("image") ? imageParts(message.content) : [];
  if (images.length === 0) return { role: "user", content: textContent(message.content) };
  return {
    role: "user",
    content: [
      { type: "input_text", text: textContent(message.content) || "截图" },
      ...images.map((image) => ({ type: "input_image", detail: "auto", image_url: image.image_url.url })),
    ],
  };
}

function imageParts(content: ToolResultMessage["content"]): Array<{ type: "image_url"; image_url: { url: string } }> {
  const parts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  for (const block of content) {
    if (block.type !== "image") continue;
    parts.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
  }
  return parts;
}

function textContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("");
}

interface ToolDraft {
  id: string;
  name: string;
  arguments: string;
}

async function readModelStream(
  response: Response,
  model: Model<Api>,
  stream: ModelEventStream,
  onEmit: () => void,
): Promise<Usage> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    const json = (await response.json()) as Record<string, unknown>;
    return emitCompletion(model, stream, json, onEmit);
  }
  if (!response.body) throw new Error("模型响应没有正文");
  const partial = blank(model);
  let started = false;
  let textIndex = -1;
  const calls = new Map<number, ToolDraft>();
  let finish = "stop";
  let usage = emptyUsage();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (json: Record<string, unknown>) => {
    if (!started) {
      started = true;
      onEmit();
      stream.push({ type: "start", partial: snapshot(partial) });
    }
    if (typeof json.type === "string" && json.type.startsWith("response.")) {
      consumeResponses(json, partial, stream, calls, (next) => {
        usage = next;
      }, () => {
        textIndex = textIndex < 0 ? partial.content.length : textIndex;
      });
      return;
    }
    const choice = firstChoice(json);
    if (json.usage && typeof json.usage === "object") usage = mapUsage(json.usage as UsageSource);
    if (!choice) return;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta as
      | { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
      | undefined;
    if (typeof delta?.content === "string" && delta.content.length > 0) {
      if (textIndex < 0) {
        partial.content.push({ type: "text", text: "" });
        textIndex = partial.content.length - 1;
        stream.push({ type: "text_start", contentIndex: textIndex, partial: snapshot(partial) });
      }
      const block = partial.content[textIndex];
      if (block && block.type === "text") block.text += delta.content;
      stream.push({ type: "text_delta", contentIndex: textIndex, delta: delta.content, partial: snapshot(partial) });
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = calls.get(index) ?? { id: call.id ?? `call_${index}`, name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      calls.set(index, current);
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const data = part
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        handle(JSON.parse(data) as Record<string, unknown>);
      }
    }
  } finally {
    reader.releaseLock();
  }
  finishPartial(partial, calls, finish, usage, textIndex, stream);
  return usage;
}

function consumeResponses(
  json: Record<string, unknown>,
  partial: AssistantMessage,
  stream: ModelEventStream,
  _calls: Map<number, ToolDraft>,
  setUsage: (usage: Usage) => void,
  ensureText: () => void,
): void {
  if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
    ensureText();
    let block = partial.content.find((item) => item.type === "text");
    if (!block) {
      const created = { type: "text" as const, text: "" };
      partial.content.push(created);
      block = created;
      stream.push({ type: "text_start", contentIndex: partial.content.length - 1, partial: snapshot(partial) });
    }
    if (block && block.type === "text") {
      block.text += json.delta;
      stream.push({
        type: "text_delta",
        contentIndex: partial.content.indexOf(block),
        delta: json.delta,
        partial: snapshot(partial),
      });
    }
  }
  if (json.type === "response.completed") {
    const response = json.response as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
    setUsage({
      input: response?.usage?.input_tokens ?? 0,
      output: response?.usage?.output_tokens ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: (response?.usage?.input_tokens ?? 0) + (response?.usage?.output_tokens ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  }
}

function emitCompletion(
  model: Model<Api>,
  stream: ModelEventStream,
  json: Record<string, unknown>,
  onEmit: () => void,
): Usage {
  const choice = firstChoice(json);
  const message = choice?.message as { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
  const partial = blank(model);
  const calls = new Map<number, ToolDraft>();
  if (typeof message?.content === "string" && message.content.length > 0) {
    partial.content.push({ type: "text", text: message.content });
  }
  for (const [index, call] of (message?.tool_calls ?? []).entries()) {
    calls.set(index, {
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "",
    });
  }
  const usage = json.usage && typeof json.usage === "object" ? mapUsage(json.usage as UsageSource) : emptyUsage();
  onEmit();
  stream.push({ type: "start", partial: snapshot(partial) });
  finishPartial(partial, calls, typeof choice?.finish_reason === "string" ? choice.finish_reason : "stop", usage, partial.content.length > 0 ? 0 : -1, stream);
  return usage;
}

function finishPartial(
  partial: AssistantMessage,
  calls: Map<number, ToolDraft>,
  finish: string,
  usage: Usage,
  textIndex: number,
  stream: ModelEventStream,
): void {
  if (textIndex >= 0) {
    const block = partial.content[textIndex];
    if (block && block.type === "text") {
      stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: snapshot(partial) });
    }
  }
  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, call] of ordered) {
    const toolCall: ToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: parseArgs(call.arguments) };
    partial.content.push(toolCall);
    const contentIndex = partial.content.length - 1;
    stream.push({ type: "toolcall_start", contentIndex, partial: snapshot(partial) });
    stream.push({ type: "toolcall_delta", contentIndex, delta: call.arguments, partial: snapshot(partial) });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: snapshot(partial) });
  }
  partial.usage = usage;
  partial.stopReason = ordered.length > 0 || finish === "tool_calls" ? "toolUse" : finish === "length" ? "length" : "stop";
  const reason = partial.stopReason === "length" || partial.stopReason === "toolUse" ? partial.stopReason : "stop";
  stream.push({ type: "done", reason, message: snapshot(partial) });
}

function firstChoice(json: Record<string, unknown>): { finish_reason?: unknown; delta?: unknown; message?: unknown } | undefined {
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  return choices[0] as { finish_reason?: unknown; delta?: unknown; message?: unknown };
}

interface UsageSource {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function mapUsage(source: UsageSource): Usage {
  const input = source.prompt_tokens ?? 0;
  const output = source.completion_tokens ?? 0;
  const cacheRead = source.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(task: GatewayTask, usage: Usage): void {
  task.inputTokens += usage.input;
  task.outputTokens += usage.output;
  task.cacheReadTokens += usage.cacheRead;
  task.cacheWriteTokens += usage.cacheWrite;
  task.tokensUsed += usage.input + usage.output;
}

function record(
  deps: GatewayDeps,
  task: GatewayTask,
  model: string,
  usage: Usage,
  started: Date,
  attempts: number,
  error: string | null,
  type: string,
): void {
  const now = deps.now?.() ?? new Date();
  const attrs = {
    taskId: task.taskId,
    model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    durationMs: Math.max(0, now.getTime() - started.getTime()),
    attempts,
    error,
  };
  try {
    emitOps(deps.db, opsMinutes, {
      id: ulid(now.getTime()),
      ts: now.toISOString(),
      userId: task.userId,
      botId: task.botId,
      type,
      attrs,
    });
    if (type === "model.request" && error === null) {
      usageRepository(deps.db).add({
        botId: task.botId,
        userId: task.userId,
        model,
        hour: hourBucket(now),
        requests: 1,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        costUsd: null,
        costSource: "local",
      });
    }
  } catch (caught) {
    console.error("模型记录写入失败", caught instanceof Error ? caught.message : "unknown");
  }
}

function blank(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function snapshot(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => ({ ...block })),
    usage: { ...message.usage, cost: { ...message.usage.cost } },
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function pushStop(stream: ModelEventStream, model: Model<Api>, text: string): void {
  const message = blank(model);
  message.content = [{ type: "text", text }];
  stream.push({ type: "start", partial: snapshot(message) });
  stream.push({ type: "done", reason: "stop", message: snapshot(message) });
}

function pushError(stream: ModelEventStream, model: Model<Api>, text: string): void {
  const message = blank(model);
  message.content = [{ type: "text", text }];
  message.stopReason = "error";
  message.errorMessage = text;
  stream.push({ type: "error", reason: "error", error: snapshot(message) });
}

function pushAborted(stream: ModelEventStream, model: Model<Api>): void {
  const message = blank(model);
  message.content = [{ type: "text", text: "" }];
  message.stopReason = "aborted";
  message.errorMessage = "已停止";
  stream.push({ type: "error", reason: "aborted", error: snapshot(message) });
}

function parseArgs(raw: string): JsonObject {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  } catch {
    return {};
  }
  return {};
}

function combineSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(120_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

class ModelEventStream implements AsyncIterable<AssistantMessageEvent> {
  private readonly queue: AssistantMessageEvent[] = [];
  private readonly waiting: Array<(value: IteratorResult<AssistantMessageEvent>) => void> = [];
  private finished = false;
  private readonly finalResult: Promise<AssistantMessage>;
  private resolveFinal: (message: AssistantMessage) => void = () => {};

  constructor() {
    this.finalResult = new Promise((resolve) => {
      this.resolveFinal = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.finished) return;
    if (event.type === "done" || event.type === "error") {
      this.finished = true;
      this.resolveFinal(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  result(): Promise<AssistantMessage> {
    return this.finalResult;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.finished) return;
      const waited = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
        this.waiting.push(resolve);
      });
      if (waited.done) return;
      yield waited.value;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createLimiter(now: () => number) {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string, limit: number): boolean {
      const windowStart = now() - 60_000;
      const recent = (hits.get(key) ?? []).filter((stamp) => stamp >= windowStart);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now());
      hits.set(key, recent);
      return true;
    },
  };
}

export function buildModel(config: ControlConfig, modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: config.modelApi,
    provider: "viate-bot",
    baseUrl: config.modelBaseUrl,
    reasoning: false,
    input: config.visionModels.includes(modelId) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.modelContextTokens,
    maxTokens: config.modelMaxTokens,
  };
}

export function attachTools(model: Model<Api>, tools: Array<{ name: string; description: string; parameters: unknown }>): Model<Api> {
  return Object.assign(model, { tools });
}
