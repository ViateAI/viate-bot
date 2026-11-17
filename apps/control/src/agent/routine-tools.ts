import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";

const schema = obj({ cron: str({ description: "五字段 cron 表达式" }), timezone: str({ description: "IANA 时区，例如 Asia/Shanghai" }), prompt: str({ description: "每次执行的任务" }) });

export function routineTools(binding: { propose: (input: { cron: string; timezone: string; prompt: string }) => string }): AgentTool[] {
  const propose: AgentTool<typeof schema> = {
    name: "propose_routine",
    label: "建议定时任务",
    description: "创建定时任务草稿；用户确认后才会运行。",
    parameters: schema,
    execute: async (_toolCallId, params) => {
      const id = binding.propose(params);
      return { content: [{ type: "text", text: `已创建草稿 ${id}，等待用户确认` }], details: { id } };
    },
  };
  return [propose];
}
