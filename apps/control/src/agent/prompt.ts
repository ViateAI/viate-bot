import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

const OMISSION = "（较早的对话已省略，以留在模型上下文的 60% 以内。）";

/** 平台提示词必须在最前面。已经带上时不重复拼接。 */
export function withPlatformPrompt(platform: string, system: string | undefined): string {
  const prefix = platform.trim();
  const rest = (system ?? "").trim();
  if (rest === prefix || rest.startsWith(`${prefix}\n`)) return rest;
  return rest.length > 0 ? `${prefix}\n\n${rest}` : prefix;
}

/**
 * 记忆和已启用 Skill 是第 6 步和 M2 的空位，这里不注入。
 * 机器状态和时间放在 bot instructions 后面。
 */
export function buildSystemPrompt(platform: string, instructions: string, status: string): string {
  return [platform.trim(), instructions.trim(), status.trim()].filter((part) => part.length > 0).join("\n\n");
}

export function statusBlock(now: Date, machine: string, secretNames: string[] = []): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const names = secretNames.length > 0 ? secretNames.join("、") : "（无）";
  return `当前时间：${now.toISOString()}（${zone}）\n机器状态：${machine}\n已保存的密钥（只有名字，用 {{secret:NAME}} 引用）：${names}`;
}

export function estimateTokens(messages: AgentMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * 超过预算时丢掉最早的一组消息，而不是做摘要。
 * 带工具调用的 assistant 和紧跟的 toolResult 当作一组，避免拆开。
 */
export function compactMessages(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
  if (budgetTokens <= 0 || estimateTokens(messages) <= budgetTokens) return messages;
  const groups = groupMessages(messages);
  while (groups.length > 1 && estimateTokens(groups.flat()) > budgetTokens) groups.shift();
  const kept = groups.flat();
  if (kept.length === messages.length) return messages;
  const note: UserMessage = { role: "user", content: OMISSION, timestamp: 0 };
  return [note, ...kept];
}

function groupMessages(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message) break;
    if (message.role === "assistant" && hasToolCall(message)) {
      const ids = new Set(toolCallIds(message));
      const group: AgentMessage[] = [message];
      index += 1;
      while (index < messages.length) {
        const next = messages[index];
        if (!next || next.role !== "toolResult" || !ids.has(next.toolCallId)) break;
        group.push(next);
        index += 1;
      }
      groups.push(group);
      continue;
    }
    groups.push([message]);
    index += 1;
  }
  return groups;
}

function hasToolCall(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "toolCall");
}

function toolCallIds(message: AssistantMessage): string[] {
  return message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
}

export function isToolResult(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}
