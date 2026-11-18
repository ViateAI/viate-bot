export const RULE_CATEGORIES = ["browser", "shell", "fs_write", "mcp"] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

const SHELL_META = /[;&|`><\n\r]|\$\(/;

export interface BrowserMatch {
  origin: string;
  pathPrefix?: string;
}
export interface ShellMatch {
  prefix: string[];
}
export interface FsMatch {
  pathPrefix: string;
}
export interface McpMatch {
  app: string;
  tool?: string;
}
export type RuleMatch = BrowserMatch | ShellMatch | FsMatch | McpMatch;

export interface StoredRule {
  id: string;
  category: RuleCategory;
  match: RuleMatch;
  expiresAt: string | null;
}

export function parseRuleMatch(category: string, match: unknown): { category: RuleCategory; match: RuleMatch } | { error: string } {
  if (!isCategory(category)) return { error: "不支持这类自动审批" };
  if (!match || typeof match !== "object") return { error: "匹配条件无效" };
  const record = match as Record<string, unknown>;
  if (category === "browser") {
    if (typeof record.origin !== "string") return { error: "需要协议和主机" };
    const origin = browserTarget(record.origin);
    if (!origin) return { error: "浏览器地址无效" };
    const pathPrefix = typeof record.pathPrefix === "string" ? record.pathPrefix : undefined;
    if (pathPrefix !== undefined && !validPathPrefix(pathPrefix)) return { error: "路径前缀无效" };
    return { category, match: { origin: origin.origin, ...(pathPrefix ? { pathPrefix } : {}) } };
  }
  if (category === "shell") {
    const tokens = typeof record.prefix === "string" ? shellTokens(record.prefix)
      : Array.isArray(record.prefix) && record.prefix.length > 0 && record.prefix.every((word) => typeof word === "string" && word.length > 0 && !SHELL_META.test(word))
        ? record.prefix as string[] : undefined;
    if (!tokens) return { error: "命令前缀无效，或包含 shell 元字符" };
    return { category, match: { prefix: tokens } };
  }
  if (category === "fs_write") {
    if (typeof record.pathPrefix !== "string") return { error: "需要路径前缀" };
    const pathPrefix = normalizeBotPath(record.pathPrefix);
    if (!pathPrefix) return { error: "路径必须在 /home/bot 下，且不能包含 .." };
    return { category, match: { pathPrefix } };
  }
  if (typeof record.app !== "string" || record.app.trim().length === 0) return { error: "需要应用名" };
  const tool = typeof record.tool === "string" && record.tool.trim().length > 0 ? record.tool.trim() : undefined;
  return { category, match: { app: record.app.trim(), ...(tool ? { tool } : {}) } };
}

export function ruleMatches(
  rule: StoredRule,
  input: { now: number; tool: string; args: unknown; browserUrl?: string | undefined; mcpApp?: string | undefined },
): boolean {
  if (rule.expiresAt && Date.parse(rule.expiresAt) <= input.now) return false;
  if (input.tool === "install_mcp" || input.tool === "update_bot_profile" || input.tool === "bulk_delete_action" || input.tool === "propose_approval_rule") return false;
  if (rule.category === "browser") {
    if (!input.tool.startsWith("browser_") || !input.browserUrl) return false;
    return browserMatches(input.browserUrl, rule.match as BrowserMatch);
  }
  if (rule.category === "shell") {
    if (input.tool !== "shell_exec") return false;
    const args = input.args as { env?: unknown; cwd?: unknown } | null;
    // Prefix-only rules cannot authorize a different interpreter environment or working tree.
    if (args?.env && (typeof args.env !== "object" || Object.keys(args.env).length > 0)) return false;
    if (args?.cwd !== undefined && args.cwd !== "/home/bot") return false;
    const cmd = stringField(input.args, "cmd");
    return cmd !== undefined && shellPrefixMatches(cmd, (rule.match as ShellMatch).prefix);
  }
  if (rule.category === "fs_write") {
    if (input.tool !== "fs_write") return false;
    const path = stringField(input.args, "path");
    return path !== undefined && pathPrefixMatches(path, (rule.match as FsMatch).pathPrefix);
  }
  if (input.tool === "shell_exec" || input.tool.startsWith("browser_") || input.tool.startsWith("desktop_") || input.tool.startsWith("fs_")) {
    return false;
  }
  const match = rule.match as McpMatch;
  if (!input.mcpApp || input.mcpApp !== match.app) return false;
  return match.tool === undefined || match.tool === input.tool;
}

export function browserTarget(raw: string): { origin: string; pathname: string } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const origin = url.port ? `${url.protocol}//${url.hostname}:${url.port}` : `${url.protocol}//${url.hostname}`;
  return { origin, pathname: url.pathname || "/" };
}

export function browserMatches(target: string, rule: BrowserMatch): boolean {
  const page = browserTarget(target);
  const origin = browserTarget(rule.origin.includes("://") ? rule.origin : `https://${rule.origin}`);
  if (!page || !origin || page.origin !== origin.origin) return false;
  if (!rule.pathPrefix) return true;
  return pathPrefixHit(page.pathname, rule.pathPrefix);
}

export function shellTokens(command: string): string[] | undefined {
  if (command.trim().length === 0 || SHELL_META.test(command)) return undefined;
  const tokens: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === "\\" && quote !== "'") {
      const next = command[++i];
      if (next === undefined) return undefined;
      if (quote === '"' && !['$', '`', '"', "\\"].includes(next)) word += "\\";
      word += next;
      started = true;
    } else if (quote && ch === quote) {
      quote = "";
    } else if (!quote && (ch === "'" || ch === '"')) {
      quote = ch;
      started = true;
    } else if (!quote && /\s/.test(ch)) {
      if (started) tokens.push(word);
      word = "";
      started = false;
    } else {
      // No variable, glob, tilde, brace or process expansion is statically matchable.
      if (quote !== "'" && (ch === "$" || (!quote && /[*?\[\]{}~()#]/.test(ch)))) return undefined;
      word += ch;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) tokens.push(word);
  if (tokens.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) return undefined;
  return tokens;
}

export function shellPrefixMatches(command: string, prefix: string[]): boolean {
  const tokens = shellTokens(command);
  if (!tokens || prefix.length === 0 || prefix.length > tokens.length) return false;
  return prefix.every((token, index) => token === tokens[index]);
}

export function normalizeBotPath(input: string): string | undefined {
  if (!input.startsWith("/") || input.includes("\\") || input.includes("\0")) return undefined;
  const pieces = input.split("/");
  if (pieces.some((part) => part === "..")) return undefined;
  const collapsed: string[] = [];
  for (const part of pieces) {
    if (part === "" || part === ".") continue;
    collapsed.push(part);
  }
  const path = `/${collapsed.join("/")}`;
  if (path !== "/home/bot" && !path.startsWith("/home/bot/")) return undefined;
  return path;
}

export function pathPrefixMatches(path: string, prefix: string): boolean {
  const file = normalizeBotPath(path);
  const root = normalizeBotPath(prefix);
  if (!file || !root) return false;
  return file === root || file.startsWith(`${root}/`);
}

export function ruleFromApproval(
  tool: string,
  args: unknown,
  browserUrl: string | undefined,
): { category: RuleCategory; match: RuleMatch } | { error: string } {
  if (tool === "install_mcp" || tool === "update_bot_profile" || tool === "bulk_delete_action" || tool.startsWith("desktop_")) {
    return { error: "这项不能自动批准" };
  }
  if (tool === "browser_open") {
    const url = stringField(args, "url");
    if (!url) return { error: "没有目标地址" };
    return browserRule(url);
  }
  if (tool.startsWith("browser_")) {
    if (!browserUrl) return { error: "读不到浏览器当前页面" };
    return browserRule(browserUrl);
  }
  if (tool === "shell_exec") {
    const cmd = stringField(args, "cmd");
    if (!cmd) return { error: "没有命令" };
    return parseRuleMatch("shell", { prefix: cmd });
  }
  if (tool === "fs_write") {
    const path = stringField(args, "path");
    if (!path) return { error: "没有路径" };
    return parseRuleMatch("fs_write", { pathPrefix: path });
  }
  return { error: "这项不能从审批卡片自动批准" };
}

function browserRule(raw: string): { category: "browser"; match: BrowserMatch } | { error: string } {
  const target = browserTarget(raw);
  if (!target) return { error: "浏览器地址无效" };
  return { category: "browser", match: { origin: target.origin, pathPrefix: target.pathname } };
}

function pathPrefixHit(pathname: string, prefix: string): boolean {
  if (!validPathPrefix(prefix)) return false;
  if (pathname === prefix) return true;
  const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname.startsWith(withSlash);
}

function validPathPrefix(prefix: string): boolean {
  return prefix.startsWith("/") && !prefix.split("/").includes("..");
}

function stringField(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isCategory(value: string): value is RuleCategory {
  return (RULE_CATEGORIES as readonly string[]).includes(value);
}
