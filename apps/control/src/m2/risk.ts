import { createHash } from "node:crypto";

/** 产品能按名字门控的动作类。不包含对任意 shell 语义的判断。 */
export const RISK_CLASSES = ["payment", "send", "bulk_delete"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** risky_tool：应用声明的工具名。shell：仅当该 bot 显式打开 approveShell 时生效。 */
export type AlwaysAllow = RiskClass | "risky_tool" | "shell";

export const GATED_TOOLS: Record<string, RiskClass> = {
  payment_action: "payment",
  send_action: "send",
  bulk_delete_action: "bulk_delete",
};

export interface BotRuntimeSettings {
  alwaysAllow: AlwaysAllow[];
  approveShell: boolean;
}

const ALWAYS = new Set<string>([...RISK_CLASSES, "risky_tool", "shell"]);

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function argsHash(tool: string, args: unknown): string {
  return createHash("sha256").update(`${tool}\n${canonicalJson(args)}`).digest("hex");
}

export function readBotSettings(settingsJson: string): BotRuntimeSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson) as unknown;
  } catch {
    return { alwaysAllow: [], approveShell: false };
  }
  if (!parsed || typeof parsed !== "object") return { alwaysAllow: [], approveShell: false };
  const record = parsed as Record<string, unknown>;
  const alwaysAllow = Array.isArray(record.alwaysAllow)
    ? record.alwaysAllow.filter((item): item is AlwaysAllow => typeof item === "string" && ALWAYS.has(item))
    : [];
  return { alwaysAllow, approveShell: record.approveShell === true };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
  return sorted;
}
