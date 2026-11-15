import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  normalizeContext,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { compactMessages, estimateTokens, groupMessages } from "./prompt.js";
import { assistantText } from "./view.js";
import { maskSecrets } from "./text.js";

export const SUMMARY_PROMPT = [
  "你是对话压缩器。请把对话压成一份可继续执行任务的中文摘要，不要调用工具。",
  "必须保留：用户的原始目标和之后追加或修改的指令；已完成的步骤和关键结果（URL、编号、ID、文件路径、表单状态、命令输出要点）；尚未完成的事项；失败和放弃过的尝试；对用户做过的承诺。",
  "已有的 {{secret:NAME}} 占位符必须原样保留，不要写出密钥的值。",
  "只输出摘要正文。",
].join("\n");

export const SUMMARY_LABEL = "以下是较早对话的摘要";
export const COMPACT_STEP_LABEL = "已压缩较早的上下文";
const IMAGE_NOTE = "（一张图片，已省略）";
const TRIGGER_RATIO = 0.6;
const KEEP_RATIO = 0.3;
const FORCE_KEEP_RATIO = 0.15;

export interface StoredSummary {
  text: string;
  untilMessageId: string;
}

export interface CompactionHooks {
  contextTokens: number;
  summaryMaxTokens: number;
  sessionId: string;
  model: Model<Api>;
  stream: StreamFn;
  secrets: () => Array<{ name: string; value: string }>;
  readSummary: () => StoredSummary | undefined;
  saveSummary: (text: string, untilMessageId: string) => void;
  idOf: (message: AgentMessage) => string | undefined;
  canSummarize: (messageIds: string[], untilMessageId: string) => boolean;
  onCompacted: () => void;
  beginSummary: () => void;
  endSummary: () => void;
}

interface Split {
  evict: AgentMessage[];
  keep: AgentMessage[];
}

/** 按正文估算。助手消息上的 usage 描述的是当时的整段前缀，不能拿来量一段后缀。 */
export function estimateTextTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      total += estimateMessageTokens(message);
    }
  }
  return total;
}

export function summarySource(previous: string | null, evicted: AgentMessage[]): string {
  const rendered = evicted.map(renderMessageForSummary).filter((line) => line.length > 0).join("\n\n");
  if (previous && previous.trim().length > 0) {
    return `已有摘要：\n${previous.trim()}\n\n新挤出的消息：\n${rendered}`;
  }
  return `需要摘要的消息：\n${rendered}`;
}

export function renderMessageForSummary(message: AgentMessage): string {
  if (message.role === "user") return `用户：${renderContent(message.content)}`;
  if (message.role === "toolResult") return `工具 ${message.toolName}：${renderContent(message.content)}`;
  if (message.role !== "assistant") return "";
  const lines = message.content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "toolCall") return `调用 ${block.name} id=${block.id} 参数=${JSON.stringify(block.arguments)}`;
    return "";
  });
  return `助手：${lines.filter((line) => line.length > 0).join("\n")}`;
}

/**
 * 保留约 keepTarget 个正文字符对应的 token。
 * 最近一条用户消息及其后内容能放进扣除系统提示和摘要后的预算时，整段保留。
 * 强制压缩时至少挤出最早的一组，避免溢出重试仍送出同样的正文。
 */
export function splitForSummary(messages: AgentMessage[], keepTarget: number, threshold: number, force: boolean): Split {
  const groups = groupMessages(messages);
  if (groups.length <= 1) return { evict: [], keep: messages };
  let start = groups.length;
  let tokens = 0;
  while (start > 0) {
    const group = groups[start - 1];
    if (!group) break;
    const next = tokens + estimateTextTokens(group);
    // 已经有一段原文时，不再吃进会明显超过目标的一组。
    if (tokens > 0 && next > keepTarget) break;
    start -= 1;
    tokens = next;
    if (tokens >= keepTarget) break;
  }
  if (force && start === 0) start = 1;
  const userIndex = latestUserGroup(groups);
  if (!force && userIndex >= 0 && userIndex < start && estimateTextTokens(groups.slice(userIndex).flat()) <= threshold) {
    start = userIndex;
  }
  if (start <= 0) return { evict: [], keep: messages };
  return { evict: groups.slice(0, start).flat(), keep: groups.slice(start).flat() };
}

/** 不抛出。摘要失败时退回丢弃最早的消息组。 */
export async function applyCompaction(
  messages: AgentMessage[],
  hooks: CompactionHooks,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<AgentMessage[]> {
  try {
    return await compact(messages, hooks, options?.force === true, options?.signal);
  } catch (error) {
    console.error("上下文摘要失败，退回丢弃最早的消息", error instanceof Error ? error.message : "unknown");
    return dropOldest(messages, hooks.contextTokens);
  }
}

export function relayWithOverflowRetry(
  inner: StreamFn,
  contextWindow: number,
  compact: (messages: AgentMessage[], signal: AbortSignal | undefined) => Promise<AgentMessage[]>,
): StreamFn {
  return (model, context, options) => {
    const output = new AssistantMessageEventStream();
    void (async () => {
      try {
        const first = await inner(model, context, options);
        let overflow = false;
        let started = false;
        for await (const event of first) {
          const terminal = event.type === "error" ? event.error : event.type === "done" ? event.message : undefined;
          if (terminal && !options?.signal?.aborted && isContextOverflow(terminal, contextWindow)) {
            overflow = true;
          } else {
            if (event.type === "start") started = true;
            output.push(event);
          }
        }
        const result = await first.result();
        overflow ||= !options?.signal?.aborted && isContextOverflow(result, contextWindow);
        if (!overflow) {
          output.end(result);
          return;
        }
        const next = await compact(context.messages as AgentMessage[], options?.signal);
        if (options?.signal?.aborted) throw new Error("请求已取消");
        const second = await inner(model, normalizeContext({ messages: next as Message[] }), options);
        for await (const event of second) {
          // Pi 每个 start 都追加一条上下文；重试复用已经开始的那条。
          if (event.type === "start" && started) continue;
          output.push(event);
        }
        output.end(await second.result());
      } catch (error) {
        const text = error instanceof Error ? error.message : "模型请求失败";
        const aborted = options?.signal?.aborted === true;
        output.push({ type: "error", reason: aborted ? "aborted" : "error", error: failedAssistant(model, text, aborted) });
      }
    })();
    return output;
  };
}

async function compact(messages: AgentMessage[], hooks: CompactionHooks, force: boolean, signal: AbortSignal | undefined): Promise<AgentMessage[]> {
  const systems = messages.filter((message) => message.role === "system");
  const conversational = messages.filter((message) => message.role !== "system");
  const opened = openTail(conversational, hooks);
  const previous = opened.previous;
  const open = opened.messages;
  const projected = previous ? [summaryUser(previous, open), ...open] : open;
  const requestThreshold = Math.floor(hooks.contextTokens * TRIGGER_RATIO);
  const threshold = Math.max(1, requestThreshold - estimateTextTokens(systems));
  const request = [...systems, ...projected];
  const over = Math.max(estimateTokens(request), estimateTextTokens(request)) > requestThreshold;
  if (!force && !over) {
    if (!previous) return messages;
    return [...systems, ...projected];
  }
  // 小窗口时摘要不能独占剩余预算，至少给原文留一半。
  const summaryBudget = Math.min(hooks.summaryMaxTokens, hooks.model.maxTokens, Math.max(1, Math.floor(threshold / 2)));
  const tailBudget = Math.max(1, threshold - summaryBudget - estimateTextTokens([summaryUser("")]));
  const keepRatio = force ? FORCE_KEEP_RATIO : KEEP_RATIO;
  const keepTarget = Math.max(1, Math.floor(Math.min(tailBudget, hooks.contextTokens * keepRatio, estimateTextTokens(open) * keepRatio / TRIGGER_RATIO)));
  const split = splitForSummary(open, keepTarget, tailBudget, force);
  const bounded = boundEvict(split.evict, hooks);
  if (!bounded) {
    if (over) return [...systems, ...compactMessages(projected, Math.max(threshold, 1))];
    return previous ? [...systems, ...projected] : messages;
  }
  try {
    const raw = await summarize(previous, bounded.evict, hooks, summaryBudget, signal);
    const text = maskSecrets(raw, hooks.secrets()).trim();
    if (!text) throw new Error("空摘要");
    hooks.saveSummary(text, bounded.untilId);
    hooks.onCompacted();
    const keep = [...split.evict.slice(bounded.evict.length), ...split.keep];
    return [...systems, summaryUser(text, keep), ...keep];
  } catch (error) {
    console.error("上下文摘要失败，退回丢弃最早的消息", error instanceof Error ? error.message : "unknown");
    return [...systems, ...compactMessages(projected, Math.max(threshold, 1))];
  }
}

function openTail(messages: AgentMessage[], hooks: CompactionHooks): { previous: string | null; messages: AgentMessage[] } {
  const peeled = peelSummary(messages);
  if (peeled.previous !== null) return { previous: peeled.previous, messages: peeled.rest };
  const stored = hooks.readSummary();
  if (!stored) return { previous: null, messages };
  const index = messages.findIndex((message) => hooks.idOf(message) === stored.untilMessageId);
  if (index < 0) return { previous: null, messages };
  return { previous: stored.text, messages: messages.slice(index + 1) };
}

function peelSummary(messages: AgentMessage[]): { previous: string | null; rest: AgentMessage[] } {
  const first = messages[0];
  const prefix = `${SUMMARY_LABEL}：\n`;
  if (first?.role === "user" && typeof first.content === "string" && first.content.startsWith(prefix)) {
    return { previous: first.content.slice(prefix.length), rest: messages.slice(1) };
  }
  return { previous: null, rest: messages };
}

async function summarize(
  previous: string | null,
  evicted: AgentMessage[],
  hooks: CompactionHooks,
  maxTokens: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const payload = maskSecrets(summarySource(previous, evicted), hooks.secrets());
  hooks.beginSummary();
  try {
    const stream = await hooks.stream(
      hooks.model,
      normalizeContext({
        messages: [
          { role: "system", content: SUMMARY_PROMPT, timestamp: Date.now() },
          { role: "user", content: payload, timestamp: Date.now() },
        ],
      }),
      { sessionId: hooks.sessionId, maxTokens, ...(signal ? { signal } : {}) },
    );
    for await (const _event of stream) { /* 摘要不推送，只取最终正文。 */ }
    const message = await stream.result();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? "摘要失败");
    }
    const text = assistantText(message).trim();
    if (!text || text.startsWith("已达到")) throw new Error(text || "空摘要");
    return text;
  } finally {
    hooks.endSummary();
  }
}

function boundEvict(
  evict: AgentMessage[],
  hooks: CompactionHooks,
): { evict: AgentMessage[]; untilId: string } | undefined {
  const groups = groupMessages(evict);
  let length = evict.length;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const candidate = evict.slice(0, length);
    const ids: string[] = [];
    let untilId = "";
    for (const message of candidate) {
      const id = hooks.idOf(message);
      if (!id) break;
      ids.push(id);
      if (id > untilId) untilId = id;
    }
    // Pi 消费队列的顺序不同于入库顺序，不能越过未进入摘要的用户行。
    if (ids.length === candidate.length && hooks.canSummarize(ids, untilId)) return { evict: candidate, untilId };
    length -= groups[index]?.length ?? 0;
  }
  return undefined;
}

function summaryUser(text: string, replaced?: AgentMessage[]): UserMessage {
  let timestamp = Date.now();
  if (replaced) {
    for (const message of replaced) timestamp = Math.max(timestamp, message.timestamp + 1);
  }
  return { role: "user", content: `${SUMMARY_LABEL}：\n${text}`, timestamp };
}

function dropOldest(messages: AgentMessage[], contextTokens: number): AgentMessage[] {
  const systems = messages.filter((message) => message.role === "system");
  const conversational = messages.filter((message) => message.role !== "system");
  const threshold = Math.max(1, Math.floor(contextTokens * TRIGGER_RATIO));
  return [...systems, ...compactMessages(conversational, threshold)];
}

function latestUserGroup(groups: AgentMessage[][]): number {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group?.some((message) => message.role === "user" && !isSummary(message))) return index;
  }
  return -1;
}

function isSummary(message: AgentMessage): boolean {
  return message.role === "user" && typeof message.content === "string" && message.content.startsWith(`${SUMMARY_LABEL}：`);
}

function renderContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "image" ? IMAGE_NOTE : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

function failedAssistant(model: Model<Api>, text: string, aborted = false): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: text,
    timestamp: Date.now(),
  };
}
