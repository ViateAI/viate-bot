import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { MessageRecord, StepRecord, TaskRecord } from "../db/chat.js";
import type { AttachmentRef } from "../uploads/store.js";

export interface MessageView {
  id: string;
  role: string;
  text: string;
  taskId: string | null;
  createdAt: string;
  attachments?: AttachmentRef[];
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  notice?: { kind: string; noticeId: string; peerBotId?: string; peerName?: string; peerConversationId?: string; shown?: boolean };
}

export interface TaskView {
  id: string;
  botId: string;
  conversationId: string | null;
  state: string;
  error: string | null;
  stepCount: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface StepView {
  id: string;
  taskId: string;
  seq: number;
  kind: string;
  status: string;
  request: unknown;
  response: unknown;
  startedAt: string;
  endedAt: string | null;
}

export function messageView(row: MessageRecord): MessageView {
  const parsed = parseContent(row.contentJson);
  const view: MessageView = {
    id: row.id,
    role: row.role,
    text: parsed.text,
    taskId: row.taskId,
    createdAt: row.createdAt,
  };
  if (parsed.attachments) view.attachments = parsed.attachments;
  if (parsed.notice) view.notice = parsed.notice;
  const pi = parsed.pi;
  if (pi?.role === "assistant") {
    const toolCalls = pi.content
      .filter((block) => block.type === "toolCall")
      .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }));
    if (toolCalls.length > 0) view.toolCalls = toolCalls;
  } else if (pi?.role === "toolResult") {
    view.toolCallId = pi.toolCallId;
    view.toolName = pi.toolName;
    view.isError = pi.isError;
  }
  return view;
}

export function taskView(row: TaskRecord): TaskView {
  return {
    id: row.id,
    botId: row.botId,
    conversationId: row.conversationId,
    state: row.state,
    error: row.error,
    stepCount: row.stepCount,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export function stepView(row: StepRecord): StepView {
  return {
    id: row.id,
    taskId: row.taskId,
    seq: row.seq,
    kind: row.kind,
    status: row.status,
    request: parseJson(row.requestJson),
    response: row.responseJson ? parseJson(row.responseJson) : null,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export function loadTranscript(rows: MessageRecord[]): AgentMessage[] {
  return loadTranscriptEntries(rows).map((entry) => entry.message);
}

export function loadTranscriptEntries(rows: MessageRecord[]): Array<{ id: string; message: AgentMessage; attachments: AttachmentRef[]; notice?: { kind: string; noticeId: string } }> {
  const entries: Array<{ id: string; message: AgentMessage; attachments: AttachmentRef[]; notice?: { kind: string; noticeId: string } }> = [];
  let toolResultsAt = 0;
  const pendingCalls = new Set<string>();
  for (const row of rows) {
    const parsed = parseContent(row.contentJson);
    const pi = parsed.pi;
    if (!pi) continue;
    const entry = {
      id: row.id,
      message: pi,
      attachments: parsed.attachments ?? [],
      ...(parsed.notice ? { notice: parsed.notice } : {}),
    };
    if (pi.role === "toolResult" && pendingCalls.delete(pi.toolCallId)) {
      // 用户可能在工具运行时先入库；模型要求结果紧跟调用，用户指令留在整组之后。
      entries.splice(toolResultsAt, 0, entry);
      toolResultsAt += 1;
    } else {
      entries.push(entry);
      if (pi.role === "assistant") {
        pendingCalls.clear();
        for (const block of pi.content) {
          if (block.type === "toolCall") pendingCalls.add(block.id);
        }
        toolResultsAt = entries.length;
      }
    }
  }
  return entries;
}

export function withoutImages(message: ToolResultMessage): ToolResultMessage {
  return { ...message, content: message.content.filter((block) => block.type !== "image") };
}

export function storedContent(
  message: UserMessage | AssistantMessage | ToolResultMessage,
  text: string,
  attachments: AttachmentRef[] = [],
  notice?: { kind: string; noticeId: string },
): string {
  const payload: {
    pi: UserMessage | AssistantMessage | ToolResultMessage;
    text: string;
    attachments?: AttachmentRef[];
    notice?: { kind: string; noticeId: string };
  } = {
    pi: message,
    text,
  };
  if (attachments.length > 0) payload.attachments = attachments;
  if (notice) payload.notice = notice;
  return JSON.stringify(payload);
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function parseContent(json: string): {
  pi?: UserMessage | AssistantMessage | ToolResultMessage;
  text: string;
  attachments?: AttachmentRef[];
  notice?: { kind: string; noticeId: string };
} {
  try {
    const value = JSON.parse(json) as {
      pi?: UserMessage | AssistantMessage | ToolResultMessage;
      text?: string;
      attachments?: unknown;
      notice?: unknown;
      delivery?: unknown;
    };
    const attachments = attachmentRefs(value.attachments);
    const notice = noticeMark(value.notice);
    if (value.pi && (value.pi.role === "user" || value.pi.role === "assistant" || value.pi.role === "toolResult")) {
      return {
        pi: value.pi,
        text: value.text ?? textOf(value.pi),
        ...(attachments ? { attachments } : {}),
        ...(notice ? { notice } : {}),
      };
    }
    if (value.delivery === "file") {
      return {
        text: typeof value.text === "string" ? value.text : "",
        ...(attachments ? { attachments } : {}),
        ...(notice ? { notice } : {}),
      };
    }
  } catch {
    return { text: json };
  }
  return { text: json };
}

function noticeMark(value: unknown): { kind: string; noticeId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || typeof record.noticeId !== "string") return undefined;
  if (record.kind.length === 0 || record.noticeId.length === 0) return undefined;
  return { kind: record.kind, noticeId: record.noticeId };
}

function attachmentRefs(value: unknown): AttachmentRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: AttachmentRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.size !== "number") continue;
    if (typeof record.mime !== "string") continue;
    refs.push({
      id: record.id,
      name: record.name,
      size: record.size,
      mime: record.mime,
      kind: record.kind === "image" ? "image" : "file",
      ...(typeof record.place === "string" && record.place.length > 0 ? { place: record.place } : {}),
    });
  }
  return refs.length > 0 ? refs : undefined;
}

function textOf(message: UserMessage | AssistantMessage | ToolResultMessage): string {
  if (message.role === "assistant") return assistantText(message);
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}
