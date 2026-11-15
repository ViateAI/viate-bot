import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";
import { MemoryRejected, type MemoryRecord } from "../db/memories.js";
import { maskSecrets } from "./text.js";

const saveSchema = obj({
  content: str({ description: "要记住的内容，最多 2000 个字符。不要写入密钥原文。" }),
});

const searchSchema = obj({
  query: str({ description: "检索词。少于 3 个字符时按子串匹配。" }),
});

const deleteSchema = obj({
  id: str({ description: "要删除的记忆 id" }),
});

export interface MemoryToolBinding {
  knownSecrets: () => Array<{ name: string; value: string }>;
  save: (content: string) => MemoryRecord;
  search: (query: string) => MemoryRecord[];
  remove: (id: string) => boolean | undefined;
}

/**
 * 工具在创建 Agent 时绑定到这一个 bot。
 * 参数里没有 bot id，模型不能把记忆写到别的 bot。
 */
export function memoryTools(binding: MemoryToolBinding): AgentTool[] {
  const save: AgentTool<typeof saveSchema> = {
    name: "memory_save",
    label: "保存记忆",
    description: "把一条记忆存到当前 bot。每个 bot 最多 200 条，超出时先 memory_delete。内容最长 2000 字符。",
    parameters: saveSchema,
    execute: async (_toolCallId, params) => {
      const content = maskSecrets(params.content, binding.knownSecrets());
      try {
        const saved = binding.save(content);
        return {
          content: [{ type: "text", text: `已保存记忆 ${saved.id}` }],
          details: { id: saved.id },
        };
      } catch (error) {
        const message = error instanceof MemoryRejected ? error.message : "保存记忆失败";
        throw new Error(message);
      }
    },
  };

  const search: AgentTool<typeof searchSchema> = {
    name: "memory_search",
    label: "检索记忆",
    description: "在当前 bot 的记忆里检索，最多返回 5 条。",
    parameters: searchSchema,
    execute: async (_toolCallId, params) => {
      const found = binding.search(params.query).slice(0, 5);
      const text = found.length > 0 ? found.map((item) => `- ${item.id}: ${item.content}`).join("\n") : "（没有匹配的记忆）";
      return { content: [{ type: "text", text }], details: { count: found.length } };
    },
  };

  const remove: AgentTool<typeof deleteSchema> = {
    name: "memory_delete",
    label: "删除记忆",
    description: "按 id 删除当前 bot 的一条记忆。",
    parameters: deleteSchema,
    execute: async (_toolCallId, params) => {
      const removed = binding.remove(params.id);
      if (removed !== true) throw new Error("找不到这条记忆");
      return { content: [{ type: "text", text: `已删除记忆 ${params.id}` }], details: { id: params.id } };
    },
  };

  return [save, search, remove];
}
