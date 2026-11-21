import { describe, expect, it } from "vitest";
import {
  browserMatches,
  normalizeBotPath,
  parseRuleMatch,
  pathPrefixMatches,
  ruleFromApproval,
  ruleMatches,
  shellPrefixMatches,
  type StoredRule,
} from "./rules.js";

function rule(partial: StoredRule): StoredRule {
  return partial;
}

describe("auto-approval rules", () => {
  it("matches the browser origin and optional path, ignoring other arguments", () => {
    expect(browserMatches("https://app.internal/e2e/page", { origin: "https://app.internal", pathPrefix: "/e2e" })).toBe(true);
    expect(browserMatches("https://app.internal/e2e", { origin: "https://app.internal", pathPrefix: "/e2e" })).toBe(true);
    expect(browserMatches("https://app.internal/e2e-other", { origin: "https://app.internal", pathPrefix: "/e2e" })).toBe(false);
    expect(browserMatches("http://app.internal/e2e", { origin: "https://app.internal" })).toBe(false);
    expect(browserMatches("https://evil.example/e2e?next=https://app.internal", { origin: "https://app.internal" })).toBe(false);
    const stored = rule({ id: "r", category: "browser", match: { origin: "https://app.internal" }, expiresAt: null });
    expect(ruleMatches(stored, { now: 0, tool: "browser_click", args: { url: "https://evil.example" }, browserUrl: "https://app.internal/home" })).toBe(true);
    expect(ruleMatches(stored, { now: 0, tool: "browser_click", args: { url: "https://app.internal" }, browserUrl: "https://evil.example" })).toBe(false);
  });

  it("does not apply a shell rule when the command contains shell metacharacters", () => {
    expect(shellPrefixMatches("git status", ["git"])).toBe(true);
    expect(shellPrefixMatches("git status --short", ["git", "status"])).toBe(true);
    expect(shellPrefixMatches("git diff", ["git", "status"])).toBe(false);
    for (const command of ["git status; rm", "git status && rm", "git status | sh", "echo `id`", "echo $(id)", "echo hi > /tmp/x", "echo hi < /tmp/x", "echo hi\nrm"]) {
      expect(shellPrefixMatches(command, ["git"]) || shellPrefixMatches(command, ["echo"])).toBe(false);
    }
  });

  it("normalizes fs paths and rejects ..", () => {
    expect(normalizeBotPath("/home/bot/./work")).toBe("/home/bot/work");
    expect(normalizeBotPath("/home/bot/../bot/work")).toBeUndefined();
    expect(normalizeBotPath("/tmp/x")).toBeUndefined();
    expect(pathPrefixMatches("/home/bot/work/a.txt", "/home/bot/work")).toBe(true);
    expect(pathPrefixMatches("/home/bot/work2/a.txt", "/home/bot/work")).toBe(false);
    expect(pathPrefixMatches("/home/bot/../etc/passwd", "/home/bot")).toBe(false);
  });

  it("matches literal shell words, not expansions or interpreter environment overrides", () => {
    expect(shellPrefixMatches('printf "%s" "two words"', ["printf", "%s", "two words"])).toBe(true);
    expect(shellPrefixMatches("echo safe\\ value", ["echo", "safe value"])).toBe(true);
    for (const cmd of ["echo $SECRET", "echo ${SECRET}", "echo *", "echo ~", "A=x echo safe", "echo 'unclosed"]) {
      expect(shellPrefixMatches(cmd, ["echo"]), cmd).toBe(false);
    }
    const stored = rule({ id: "r", category: "shell", match: { prefix: ["git"] }, expiresAt: null });
    expect(ruleMatches(stored, { now: 0, tool: "shell_exec", args: { cmd: "git status", env: { PATH: "/tmp" } } })).toBe(false);
    expect(ruleMatches(stored, { now: 0, tool: "shell_exec", args: { cmd: "git status", cwd: "/tmp/untrusted" } })).toBe(false);
  });

  it("matches an mcp app and optional tool", () => {
    const all = rule({ id: "r", category: "mcp", match: { app: "demo" }, expiresAt: null });
    const one = rule({ id: "r2", category: "mcp", match: { app: "demo", tool: "ping" }, expiresAt: null });
    expect(ruleMatches(all, { now: 0, tool: "ping", args: {}, mcpApp: "demo" })).toBe(true);
    expect(ruleMatches(one, { now: 0, tool: "other", args: {}, mcpApp: "demo" })).toBe(false);
    expect(ruleMatches(all, { now: 0, tool: "ping", args: {}, mcpApp: "other" })).toBe(false);
    expect(ruleMatches(all, { now: 0, tool: "shell_exec", args: { cmd: "true" }, mcpApp: "demo" })).toBe(false);
    expect(ruleMatches(all, { now: 0, tool: "mcp_call", args: { app: "demo", tool: "ping", arguments: { q: 1 } } })).toBe(true);
    expect(ruleMatches(one, { now: 0, tool: "mcp_call", args: { app: "demo", tool: "ping" } })).toBe(true);
    expect(ruleMatches(one, { now: 0, tool: "mcp_call", args: { app: "demo", tool: "other" } })).toBe(false);
    expect(ruleMatches(all, { now: 0, tool: "mcp_call", args: { app: "other", tool: "ping" } })).toBe(false);
    expect(ruleMatches(all, { now: 0, tool: "mcp_call", args: { app: "demo", tool: "shell_exec" } })).toBe(false);
  });

  it("ignores expired rules and exempt tools", () => {
    const stored = rule({ id: "r", category: "shell", match: { prefix: ["echo"] }, expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(ruleMatches(stored, { now: Date.parse("2026-01-01T00:00:00.000Z"), tool: "shell_exec", args: { cmd: "echo hi" } })).toBe(false);
    const live = rule({ ...stored, expiresAt: null });
    expect(ruleMatches(live, { now: 0, tool: "install_mcp", args: {} })).toBe(false);
    expect(ruleMatches(live, { now: 0, tool: "update_bot_profile", args: {} })).toBe(false);
    expect(ruleMatches(live, { now: 0, tool: "bulk_delete_action", args: {} })).toBe(false);
  });

  it("builds a card rule from the real target, not from a side parameter", () => {
    expect(ruleFromApproval("browser_open", { url: "https://app.internal/e2e", note: "https://evil.example" }, "https://evil.example")).toEqual({
      category: "browser",
      match: { origin: "https://app.internal", pathPrefix: "/e2e" },
    });
    expect(ruleFromApproval("browser_click", { url: "https://evil.example" }, "https://app.internal/now")).toMatchObject({
      category: "browser",
      match: { origin: "https://app.internal" },
    });
    expect(ruleFromApproval("shell_exec", { cmd: "echo hi; id" }, undefined)).toEqual({ error: "命令前缀无效，或包含 shell 元字符" });
    expect(ruleFromApproval("desktop_mouse", {}, undefined)).toEqual({ error: "这项不能自动批准" });
    expect(ruleFromApproval("mcp_call", { app: "demo", tool: "ping", arguments: { text: "hi" } }, undefined)).toEqual({
      category: "mcp",
      match: { app: "demo", tool: "ping" },
    });
    expect(ruleFromApproval("mcp_call", { app: "demo" }, undefined)).toEqual({ error: "没有应用或工具" });
    expect(ruleFromApproval("mcp_call", { app: "demo", tool: "shell_exec" }, undefined)).toEqual({ error: "这项不能从审批卡片自动批准" });
    expect(parseRuleMatch("desktop", {})).toEqual({ error: "不支持这类自动审批" });
  });
});
