import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { approvalRuleRepository, ruleExpiry } from "../db/approval-rules.js";
import type { AppDatabase } from "../db/index.js";
import { userScope } from "../scope.js";
import { parseRuleMatch } from "./rules.js";

const schema = obj({
  category: str({ description: "browser、shell、fs_write 或 mcp" }),
  match: obj({
    origin: opt(str({ description: "浏览器规则的协议和主机" })),
    pathPrefix: opt(str({ description: "浏览器路径前缀，或 fs_write 的 /home/bot 路径前缀" })),
    prefix: opt(str({ description: "shell 命令前缀" })),
    app: opt(str({ description: "MCP 应用名" })),
    tool: opt(str({ description: "MCP 工具名。省略表示该应用的全部工具" })),
  }),
  expiresAt: opt(str({ description: "可选过期时间，ISO 8601。不填则永久有效" })),
});

export interface ProposeRuleDeps {
  db: AppDatabase;
  userId: string;
  botId: string;
}

export function proposalError(args: unknown): string | undefined {
  const record = asRecord(args);
  if (typeof record.category !== "string") return "规则类别无效";
  const parsed = parseRuleMatch(record.category, record.match);
  if ("error" in parsed) return parsed.error;
  if (record.expiresAt !== undefined && typeof record.expiresAt !== "string") return "过期时间无效";
  if (typeof record.expiresAt === "string") {
    try {
      ruleExpiry(new Date(), { expiresAt: record.expiresAt });
    } catch (error) {
      return error instanceof Error ? error.message : "过期时间无效";
    }
  }
  return undefined;
}

export function proposalSummary(args: unknown): string {
  const record = asRecord(args);
  return JSON.stringify({
    kind: "approval_rule",
    category: record.category ?? "",
    match: record.match ?? {},
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
  });
}

export function proposeApprovalRuleTool(deps: ProposeRuleDeps): AgentTool<typeof schema> {
  return {
    name: "propose_approval_rule",
    label: "提议自动审批规则",
    description: "提议一条自动审批规则。每次都要用户批准，全部免审批、始终允许和其他规则都不能跳过这次批准。不能修改或删除已有规则。不填过期时间则永久有效。",
    parameters: schema,
    execute: async (_id, params) => {
      const id = applyProposedRule(deps, params);
      return { content: [{ type: "text", text: `规则已生效：${id}` }], details: { ruleId: id } };
    },
  };
}

export function applyProposedRule(deps: ProposeRuleDeps, params: {
  category: string;
  match: { origin?: string; pathPrefix?: string; prefix?: string; app?: string; tool?: string };
  expiresAt?: string;
}): string {
  const problem = proposalError(params);
  if (problem) throw new Error(problem);
  const parsed = parseRuleMatch(params.category, params.match);
  if ("error" in parsed) throw new Error(parsed.error);
  const expiresAt = ruleExpiry(new Date(), params.expiresAt ? { expiresAt: params.expiresAt } : {});
  const rule = approvalRuleRepository(deps.db).create(userScope(deps.userId), deps.botId, parsed.category, parsed.match, expiresAt, new Date());
  if (!rule) throw new Error("找不到 bot");
  return rule.id;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
