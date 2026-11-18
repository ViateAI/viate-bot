import { createHash } from "node:crypto";

/** 具名动作。只留会真正改文件的批量删除。不按命令文本猜付款或发送。 */
export const RISK_CLASSES = ["bulk_delete"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** 默认要审批的执行类。用户每 bot 显式写进 alwaysAllow 才关掉，缺省为空。 */
export const EXEC_CLASSES = ["shell", "browser", "desktop", "fs_write", "mcp", "risky_tool"] as const;
export type ExecClass = (typeof EXEC_CLASSES)[number];
export type AlwaysAllow = RiskClass | ExecClass;

export const GATED_TOOLS: Record<string, RiskClass> = {
  bulk_delete_action: "bulk_delete",
};

/** 实现只读，参数不会进入解释器、点击或网络。不在表里的新工具默认审批。 */
export const READ_ONLY_TOOLS: Record<string, true> = {
  fs_read: true,
  fs_list: true,
  fs_search: true,
  browser_snapshot: true,
  browser_screenshot: true,
  desktop_screenshot: true,
  memory_search: true,
  search_apps: true,
};

/**
 * 只写控制面自己的记录，不调用机器、浏览器或外部网络。
 * propose_routine 只插入禁用草稿，request_secret 只等待用户。
 */
export const CONTROL_PLANE_TOOLS: Record<string, true> = {
  memory_save: true,
  memory_delete: true,
  propose_routine: true,
  request_secret: true,
};

const BROWSER_EFFECTS: Record<string, true> = {
  browser_open: true,
  browser_click: true,
  browser_type: true,
  browser_select: true,
  browser_scroll: true,
  browser_tabs: true,
  browser_wait: true,
};

const DESKTOP_EFFECTS: Record<string, true> = {
  desktop_mouse: true,
  desktop_key: true,
  desktop_type: true,
};

export interface BotRuntimeSettings {
  alwaysAllow: AlwaysAllow[];
  /** 旧字段。门禁忽略它，shell 默认就要审批。 */
  approveShell: boolean;
  /** 全部免审批。默认关。不能由 bot 修改。 */
  approveNone: boolean;
}

const ALWAYS: Record<string, true> = {
  bulk_delete: true,
  shell: true,
  browser: true,
  desktop: true,
  fs_write: true,
  mcp: true,
  risky_tool: true,
};

export type ApprovalCategory = AlwaysAllow | "app_install" | "bot_profile" | "rule_proposal";

/** app_install、bot_profile、rule_proposal 不是 alwaysAllow 的合法值。数组里即使有这些字符串也不跳过审批。 */
export function skipsApproval(category: ApprovalCategory | undefined, settings: BotRuntimeSettings): boolean {
  if (!category) return true;
  if (category === "app_install" || category === "bot_profile" || category === "rule_proposal") return false;
  return settings.alwaysAllow.includes(category);
}

export function approvalClass(name: string, risky?: ReadonlySet<string>): ApprovalCategory | undefined {
  if (name === "install_mcp") return "app_install";
  if (name === "update_bot_profile") return "bot_profile";
  if (name === "propose_approval_rule") return "rule_proposal";
  if (READ_ONLY_TOOLS[name] || CONTROL_PLANE_TOOLS[name]) return undefined;
  const named = GATED_TOOLS[name];
  if (named) return named;
  if (name === "shell_exec" || name === "fs_write") return name === "shell_exec" ? "shell" : "fs_write";
  if (BROWSER_EFFECTS[name]) return "browser";
  if (DESKTOP_EFFECTS[name]) return "desktop";
  if (risky?.has(name)) return "risky_tool";
  return "mcp";
}

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
    return { alwaysAllow: [], approveShell: false, approveNone: false };
  }
  if (!parsed || typeof parsed !== "object") return { alwaysAllow: [], approveShell: false, approveNone: false };
  const record = parsed as Record<string, unknown>;
  const alwaysAllow = Array.isArray(record.alwaysAllow)
    ? record.alwaysAllow.filter((item): item is AlwaysAllow => typeof item === "string" && ALWAYS[item] === true)
    : [];
  return { alwaysAllow, approveShell: record.approveShell === true, approveNone: record.approveNone === true };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
  return sorted;
}
