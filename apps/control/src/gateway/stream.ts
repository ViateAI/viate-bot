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
import { markRateWait, readModelRate, subscribeModelRate } from "../model-rate.js";
import { budgetFailure } from "../task-budget.js";
import { durationLimitText, elapsedActiveMs, pauseActive, resolveTaskMaxDurationSec, resolveTaskMaxSteps, resumeActive, runLimitFailure, watchActiveLimit, type ActiveRun } from "../task-limits.js";
import { classifyFinish } from "./finish-reason.js";
import { createRateLimiter, systemRateClock, type RateClock } from "./rate-limit.js";
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
  /** Flushed running time. Waits and downtime stay out of this. */
  activeMs: number;
  /** Open running segment. Null while the task is waiting. */
  segmentStartedAt: number | null;
  /** 任务开始时的预算快照。0 表示不限制。缺省时用环境配置。 */
  tokenBudget?: number;
  lengthContinuations?: number;
  /** 摘要调用记用量和 token 预算，不占 VB_MAX_TASK_STEPS。 */
  skipStep?: boolean;
}

export interface GatewayDeps {
  db: AppDatabase;
  config: ControlConfig;
  tasks: Map<string, GatewayTask>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** 注入后，限流等待和这次调用的时间戳都走这只钟。 */
  clock?: RateClock;
  retryDelays?: number[];
}

const DEFAULT_DELAYS = [200, 800];

export function createGateway(deps: GatewayDeps): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  const fetchImpl = deps.fetch ?? fetch;
  const clock = deps.clock ?? systemRateClock();
  const now = deps.clock ? () => new Date(clock.now()) : (deps.now ?? (() => new Date()));
  const stamp = () => (deps.clock ? clock.now() : now().getTime());
  const delays = deps.retryDelays ?? DEFAULT_DELAYS;
  const limiter = createRateLimiter(clock);
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
      const limit = limitReason(deps, currentTask, stamp());
      if (limit) {
        pushError(target, current, limit);
        record(deps, currentTask, current.id, emptyUsage(), now(), 0, limit, "model.request");
        return;
      }
      if (deps.config.models.length > 0 && !deps.config.models.includes(current.id)) {
        pushError(target, current, `模型不在白名单内: ${current.id}`);
        record(deps, currentTask, current.id, emptyUsage(), now(), 0, `模型不在白名单内: ${current.id}`, "model.request");
        return;
      }
      const unsubscribe = subscribeModelRate(() => limiter.poke());
      pauseTaskClock(currentTask, stamp());
      markRateWait(currentTask.taskId, true);
      persistUsage(deps, currentTask);
      const slot = await limiter.acquire({
        userKey: `user:${currentTask.userId}`,
        botKey: `bot:${currentTask.botId}`,
        limits: () => readModelRate(deps.db, {
          userPerMin: deps.config.modelRateUserPerMin,
          botPerMin: deps.config.modelRateBotPerMin,
        }),
        deadline: Number.POSITIVE_INFINITY,
        ...(signal ? { signal } : {}),
      }).finally(() => {
        unsubscribe();
        markRateWait(currentTask.taskId, false);
        resumeTaskClock(currentTask, stamp());
      });
      if (!slot.ok) {
        if (slot.reason === "aborted" || signal?.aborted) {
          pushAborted(target, current);
          return;
        }
        const expired = limitReason(deps, currentTask, stamp()) ?? durationLimitText(elapsedActiveMs(readRun(currentTask), stamp()));
        pushError(target, current, expired);
        record(deps, currentTask, current.id, emptyUsage(), now(), 0, expired, "model.request");
        return;
      }
      const afterWait = limitReason(deps, currentTask, stamp());
      if (afterWait) {
        pushError(target, current, afterWait);
        record(deps, currentTask, current.id, emptyUsage(), now(), 0, afterWait, "model.request");
        return;
      }
      const platform = settingsRepository(deps.db).platformPrompt().text;
      const systemPrompt = withPlatformPrompt(platform, system);
      const cap = current.maxTokens > 0 ? current.maxTokens : deps.config.modelMaxTokens;
      const maxTokens = Math.min(options?.maxTokens ?? cap, cap);
      if (currentTask.skipStep !== true) currentTask.modelCalls += 1;
      const started = now();
      let attempts = 0;
      let lastError = "模型请求失败";
      let networkTimedOut = false;
      while (attempts <= delays.length) {
        if (signal?.aborted) {
          pushAborted(target, current);
          return;
        }
        const beforeAttempt = durationFailure(deps, currentTask, stamp());
        if (beforeAttempt) {
          pushError(target, current, beforeAttempt);
          record(deps, currentTask, current.id, emptyUsage(), started, attempts, beforeAttempt, "model.request");
          return;
        }
        attempts += 1;
        let emitted = false;
        const bound = bindRequestSignal(deps, currentTask, signal, stamp);
        try {
          const response = await fetchImpl(endpoint(deps.config, current), {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(requestBody(deps.config, current, systemPrompt, messages, tools, maxTokens)),
            signal: bound.signal,
          });
          const overdue = durationFailure(deps, currentTask, stamp());
          if (overdue) {
            void response.body?.cancel();
            pushError(target, current, overdue);
            record(deps, currentTask, current.id, emptyUsage(), started, attempts, overdue, "model.request");
            return;
          }
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
          let blocked: string | undefined;
          const usage = await readModelStream(response, current, target, () => {
            emitted = true;
          }, () => {
            blocked = durationFailure(deps, currentTask, stamp());
            return blocked;
          });
          addUsage(currentTask, usage);
          record(deps, currentTask, current.id, usage, started, attempts, blocked ?? null, "model.request");
          return;
        } catch (error) {
          if (signal?.aborted) {
            pushAborted(target, current);
            return;
          }
          if (bound.durationHit()) {
            const overdue = durationFailure(deps, currentTask, stamp()) ?? durationLimitText(elapsedActiveMs(readRun(currentTask), stamp()));
            pushError(target, current, overdue);
            record(deps, currentTask, current.id, emptyUsage(), started, attempts, overdue, "model.request");
            return;
          }
          networkTimedOut = bound.networkTimedOut();
          if (!networkTimedOut) {
            const overdue = durationFailure(deps, currentTask, stamp());
            if (overdue) {
              pushError(target, current, overdue);
              record(deps, currentTask, current.id, emptyUsage(), started, attempts, overdue, "model.request");
              return;
            }
          }
          lastError = redactSecret(error instanceof Error ? error.message : "网络错误", secret);
          if (emitted || attempts > delays.length) break;
          await sleep(delays[attempts - 1] ?? 0, signal);
        } finally {
          bound.stop();
        }
      }
      const overdue = !signal?.aborted && !networkTimedOut ? durationFailure(deps, currentTask, stamp()) : undefined;
      if (signal?.aborted) pushAborted(target, current);
      else {
        pushError(target, current, overdue ?? lastError);
        record(deps, currentTask, current.id, emptyUsage(), started, attempts, overdue ?? lastError, "model.request");
      }
    }
  };
}

function limitReason(deps: GatewayDeps, task: GatewayTask, nowMs: number): string | undefined {
  const budget = budgetFailure(task, task.tokenBudget === undefined ? deps.config.taskTokenBudget : undefined);
  if (budget) return budget;
  return runLimitFailure({
    modelCalls: task.modelCalls,
    activeMs: task.activeMs,
    segmentStartedAt: task.segmentStartedAt,
    nowMs,
    maxSteps: resolveTaskMaxSteps(deps.db, task.userId, deps.config.maxTaskSteps),
    maxDurationSec: resolveTaskMaxDurationSec(deps.db, task.userId, deps.config.maxTaskDurationSec),
  });
}

function readRun(task: GatewayTask): ActiveRun {
  return { activeMs: task.activeMs, segmentStartedAt: task.segmentStartedAt };
}

function writeRun(task: GatewayTask, run: ActiveRun): void {
  task.activeMs = run.activeMs;
  task.segmentStartedAt = run.segmentStartedAt;
}

export function pauseTaskClock(task: GatewayTask, nowMs: number): void {
  writeRun(task, pauseActive(readRun(task), nowMs));
}

export function resumeTaskClock(task: GatewayTask, nowMs: number): void {
  writeRun(task, resumeActive(readRun(task), nowMs));
}

/** True when the caller should persist the updated active time. */
export function holdTaskClock(task: GatewayTask, waiting: boolean, nowMs: number): boolean {
  if (waiting) {
    if (task.segmentStartedAt === null) return false;
    pauseTaskClock(task, nowMs);
    return true;
  }
  if (task.segmentStartedAt !== null) return false;
  resumeTaskClock(task, nowMs);
  return true;
}

function checkpointRun(task: GatewayTask, nowMs: number): void {
  writeRun(task, pauseActive(readRun(task), nowMs));
  task.segmentStartedAt = nowMs;
}

function persistUsage(deps: GatewayDeps, task: GatewayTask): void {
  try {
    deps.db.$client.prepare("update tasks set usage_json=? where id=?").run(taskUsageJson(task), task.taskId);
  } catch (caught) {
    console.error("模型记录写入失败", caught instanceof Error ? caught.message : "unknown");
  }
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
      const text = textContent(message.content);
      const images = vision ? imageParts(message.content) : [];
      if (images.length === 0) out.push({ role: "user", content: text });
      else out.push({ role: "user", content: [{ type: "text", text: text || "附件" }, ...images] });
    } else if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const calls = message.content.filter((block) => block.type === "toolCall");
      // 中断留下的空回复没有正文，也没有工具调用。content 写成 null 后，网关会拒掉之后每一次请求。
      if (text.length === 0 && calls.length === 0) continue;
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
  if (message.role === "user") {
    const text = textContent(message.content);
    const images = model.input.includes("image") ? imageParts(message.content) : [];
    if (images.length === 0) return { role: "user", content: text };
    return {
      role: "user",
      content: [
        { type: "input_text", text: text || "附件" },
        ...images.map((image) => ({ type: "input_image", detail: "auto", image_url: image.image_url.url })),
      ],
    };
  }
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

function imageParts(content: string | Array<{ type: string; data?: string; mimeType?: string }>): Array<{ type: "image_url"; image_url: { url: string } }> {
  const parts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  if (typeof content === "string") return parts;
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
  rejectIf?: () => string | undefined,
): Promise<Usage> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    const json = (await response.json()) as Record<string, unknown>;
    return emitCompletion(model, stream, json, onEmit, rejectIf);
  }
  if (!response.body) throw new Error("模型响应没有正文");
  const partial = blank(model);
  let started = false;
  let textIndex = -1;
  const calls = new Map<number, ToolDraft>();
  let finish = "missing";
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
      }, (next) => {
        finish = next;
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
  finishPartial(partial, calls, finish, usage, textIndex, stream, rejectIf);
  return usage;
}

function consumeResponses(
  json: Record<string, unknown>,
  partial: AssistantMessage,
  stream: ModelEventStream,
  _calls: Map<number, ToolDraft>,
  setUsage: (usage: Usage) => void,
  setFinish: (finish: string) => void,
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
  if (json.type === "response.completed" || json.type === "response.incomplete") {
    const response = json.response as {
      status?: string;
      incomplete_details?: { reason?: string };
      usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    } | undefined;
    if (json.type === "response.incomplete" || response?.status === "incomplete" || response?.incomplete_details?.reason === "max_output_tokens") {
      setFinish("length");
    } else {
      setFinish("stop");
    }
    const input = response?.usage?.input_tokens ?? 0;
    const output = response?.usage?.output_tokens ?? 0;
    const cacheRead = response?.usage?.input_tokens_details?.cached_tokens ?? 0;
    setUsage({
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  }
}

function emitCompletion(
  model: Model<Api>,
  stream: ModelEventStream,
  json: Record<string, unknown>,
  onEmit: () => void,
  rejectIf?: () => string | undefined,
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
  const incomplete = json.incomplete_details as { reason?: string } | undefined;
  const finish = json.status === "incomplete" || incomplete?.reason === "max_output_tokens"
    ? "length"
    : typeof choice?.finish_reason === "string"
      ? choice.finish_reason
      : json.status === "completed" ? "stop" : "missing";
  finishPartial(partial, calls, finish, usage, partial.content.length > 0 ? 0 : -1, stream, rejectIf);
  return usage;
}

function finishPartial(
  partial: AssistantMessage,
  calls: Map<number, ToolDraft>,
  finish: string,
  usage: Usage,
  textIndex: number,
  stream: ModelEventStream,
  rejectIf?: () => string | undefined,
): void {
  const blocked = rejectIf?.();
  if (blocked) {
    partial.content = [{ type: "text", text: blocked }];
    partial.usage = usage;
    partial.stopReason = "error";
    partial.errorMessage = blocked;
    stream.push({ type: "error", reason: "error", error: snapshot(partial) });
    return;
  }
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
  const classified = classifyFinish(finish, ordered.length > 0);
  partial.stopReason = classified.stopReason;
  if (classified.stopReason === "error") {
    partial.errorMessage = classified.errorMessage ?? "模型没有正常结束";
    stream.push({ type: "error", reason: "error", error: snapshot(partial) });
    return;
  }
  const reason = classified.stopReason === "length" || classified.stopReason === "toolUse" ? classified.stopReason : "stop";
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
  // prompt_tokens / input_tokens 已包含缓存。预算只计未命中缓存的输入和输出。
  task.tokensUsed += Math.max(0, usage.input + usage.output - usage.cacheRead - usage.cacheWrite);
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
  checkpointRun(task, deps.clock ? deps.clock.now() : now.getTime());
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
    persistUsage(deps, task);
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

/** Persist usage and limits, never credentials or transcript content. */
export function taskUsageJson(task: GatewayTask): string {
  return JSON.stringify({
    inputTokens: task.inputTokens,
    outputTokens: task.outputTokens,
    cacheReadTokens: task.cacheReadTokens,
    cacheWriteTokens: task.cacheWriteTokens,
    totalTokens: task.tokensUsed,
    tokenBudget: task.tokenBudget,
    modelCalls: task.modelCalls,
    activeMs: task.activeMs,
    lengthContinuations: task.lengthContinuations ?? 0,
  });
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

/** Duration cap only. Step checks stay at the start of the call so the allowed call is not rejected mid-flight. */
function durationFailure(deps: GatewayDeps, task: GatewayTask, nowMs: number): string | undefined {
  const maxSec = resolveTaskMaxDurationSec(deps.db, task.userId, deps.config.maxTaskDurationSec);
  if (maxSec <= 0) return undefined;
  const elapsed = elapsedActiveMs(readRun(task), nowMs);
  if (elapsed >= maxSec * 1000) return durationLimitText(elapsed);
  return undefined;
}

/** 120 秒网络超时始终生效。有时长上限时再叠加剩余时长，谁先到按谁。 */
function bindRequestSignal(
  deps: GatewayDeps,
  task: GatewayTask,
  user: AbortSignal | undefined,
  nowMs: () => number,
): { signal: AbortSignal; stop: () => void; durationHit: () => boolean; networkTimedOut: () => boolean } {
  const maxSec = resolveTaskMaxDurationSec(deps.db, task.userId, deps.config.maxTaskDurationSec);
  const timeout = AbortSignal.timeout(120_000);
  const parts: AbortSignal[] = [timeout];
  let stop = () => {};
  let duration: AbortSignal | undefined;
  if (maxSec > 0) {
    const controller = new AbortController();
    duration = controller.signal;
    stop = watchActiveLimit(() => readRun(task), nowMs, maxSec, () => {
      controller.abort();
    });
    parts.push(controller.signal);
  }
  if (user) parts.push(user);
  const signal = AbortSignal.any(parts);
  return {
    signal,
    stop,
    durationHit: () => duration?.aborted === true && signal.reason === duration.reason,
    networkTimedOut: () => timeout.aborted && signal.reason === timeout.reason,
  };
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
