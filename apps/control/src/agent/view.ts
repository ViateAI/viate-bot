import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { MessageRecord, StepRecord, TaskRecord } from "../db/chat.js";

export interface MessageView {
  id: string;
  role: string;
  text: string;
  taskId: string | null;
  createdAt: string;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
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
  const transcript: AgentMessage[] = [];
  for (const row of rows) {
    const pi = parseContent(row.contentJson).pi;
    if (pi) transcript.push(pi);
  }
  return transcript;
}

export function withoutImages(message: ToolResultMessage): ToolResultMessage {
  return { ...message, content: message.content.filter((block) => block.type !== "image") };
}

export function storedContent(message: UserMessage | AssistantMessage | ToolResultMessage, text: string): string {
  return JSON.stringify({ pi: message, text });
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function parseContent(json: string): { pi?: UserMessage | AssistantMessage | ToolResultMessage; text: string } {
  try {
    const value = JSON.parse(json) as { pi?: UserMessage | AssistantMessage | ToolResultMessage; text?: string };
    if (value.pi && (value.pi.role === "user" || value.pi.role === "assistant" || value.pi.role === "toolResult")) {
      return { pi: value.pi, text: value.text ?? textOf(value.pi) };
    }
  } catch {
    return { text: json };
  }
  return { text: json };
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
