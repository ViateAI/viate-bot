import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, map, obj, str, unknown } from "@earendil-works/pi-schema";
import { canonicalJson } from "../m2/risk.js";

const actionSchema = map(unknown());
const deleteSchema = obj({ paths: arr(str({ description: "要删除的路径" })) });

export interface ConfinedDeleteClient {
  delete(path: string, signal?: AbortSignal): Promise<unknown>;
}

export function approvalTools(client: ConfinedDeleteClient): AgentTool[] {
  const action = (name: string, label: string): AgentTool<typeof actionSchema> => ({
    name, label, description: `${label}：仅记录审批结果，不执行外部操作。`, parameters: actionSchema,
    execute: async (_id, args) => ({ content: [{ type: "text", text: canonicalJson(args) }], details: args }),
  });
  const remove: AgentTool<typeof deleteSchema> = {
    name: "bulk_delete_action", label: "批量删除", description: "审批后删除指定路径。", parameters: deleteSchema,
    execute: async (_id, args, signal) => {
      for (const path of args.paths) await client.delete(path, signal);
      return { content: [{ type: "text", text: canonicalJson(args) }], details: args };
    },
  };
  return [action("payment_action", "支付"), action("send_action", "发送"), remove];
}
