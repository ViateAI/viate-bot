import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { auditRepository } from "../db/audit.js";
import { botRepository } from "../db/bots.js";
import type { AppDatabase } from "../db/index.js";
import { adminScope, userScope, type UserScope } from "../scope.js";
import { AVATAR_MAX_BYTES, sniffImage, type AvatarMime } from "./avatar.js";
import { normalizeBotPath } from "../approvals/rules.js";

const FORBIDDEN = ["alwaysAllow", "approveNone", "approvalRules", "rules", "quota", "userId", "ownerId", "botId", "settings", "settingsJson"];

const schema = obj({
  name: opt(str({ description: "新的显示名称" })),
  bio: opt(str({ description: "简介" })),
  avatarPath: opt(str({ description: "机器里的图片路径，png、jpeg 或 webp，不超过 1 MiB" })),
  instructions: opt(str({ description: "系统提示词。修改需要用户批准" })),
  model: opt(str({ description: "白名单内的模型。修改需要用户批准" })),
  enabledAppIds: opt(arr(str({ description: "要启用的应用安装 id" }))),
});

export interface ProfileToolDeps {
  db: AppDatabase;
  dataDir: string;
  userId: string;
  botId: string;
  taskId: string;
  allowModel: (model: string) => boolean;
  readFile: (path: string) => Promise<{ bytes: Buffer; truncated: boolean }>;
  /** 每次读头像再看。不传则仍只允许 /home/bot 和 /tmp。 */
  confineNow?: () => boolean;
}

export function profileNeedsApproval(args: unknown): boolean {
  const record = asRecord(args);
  return "instructions" in record || "model" in record || "enabledAppIds" in record;
}

export function profileForbidden(args: unknown): string | undefined {
  const record = asRecord(args);
  for (const key of FORBIDDEN) {
    if (key in record) return "不能修改审批设置、自动审批规则、配额或所属用户";
  }
  return undefined;
}

export function profileSummary(
  before: { name: string; bio: string; instructions: string; model: string; enabledAppIds?: string[] },
  args: unknown,
): string {
  const record = asRecord(args);
  const changes: Array<{ field: string; before?: string; after?: string; diff?: string }> = [];
  if (typeof record.name === "string") changes.push({ field: "name", before: before.name, after: record.name });
  if (typeof record.bio === "string") changes.push({ field: "bio", before: before.bio, after: record.bio });
  if (typeof record.avatarPath === "string") changes.push({ field: "avatar", after: "更换头像" });
  if (typeof record.instructions === "string") {
    changes.push({ field: "instructions", before: before.instructions, after: record.instructions, diff: lineDiff(before.instructions, record.instructions) });
  }
  if (typeof record.model === "string") changes.push({ field: "model", before: before.model, after: record.model });
  if (Array.isArray(record.enabledAppIds)) changes.push({ field: "enabledApps", before: (before.enabledAppIds ?? []).join(","), after: record.enabledAppIds.filter((item) => typeof item === "string").join(",") });
  return JSON.stringify({ kind: "bot_profile", changes });
}

export function updateBotProfileTool(deps: ProfileToolDeps): AgentTool<typeof schema> {
  return {
    name: "update_bot_profile",
    label: "修改这个 bot 的资料",
    description: "只能修改当前 bot 的名称、头像、简介、提示词、模型和启用的应用。不能修改审批设置、全部免审批开关、自动审批规则、配额或所属用户。提示词、模型和启用应用每次都要用户批准，除非用户打开了全部免审批。",
    parameters: schema,
    execute: async (_id, params) => {
      const problem = profileForbidden(params);
      if (problem) throw new Error(problem);
      const changed = await applyBotProfile(deps, params);
      if (changed.length === 0) throw new Error("没有要修改的内容");
      return { content: [{ type: "text", text: `已修改：${changed.join("、")}` }], details: { fields: changed } };
    },
  };
}

export async function applyBotProfile(deps: ProfileToolDeps, params: {
  name?: string;
  bio?: string;
  avatarPath?: string;
  instructions?: string;
  model?: string;
  enabledAppIds?: string[];
}): Promise<string[]> {
  const scope = userScope(deps.userId);
  const bots = botRepository(deps.db);
  const bot = bots.findById(scope, deps.botId);
  if (!bot) throw new Error("找不到 bot");
  const fields: string[] = [];
  const patch: { name?: string; bio?: string; instructions?: string; model?: string; avatar?: string | null } = {};
  if (params.name !== undefined) {
    const name = params.name.trim();
    if (name.length === 0 || name.length > 80) throw new Error("名称无效");
    patch.name = name;
    fields.push("name");
  }
  if (params.bio !== undefined) {
    if (params.bio.length > 500) throw new Error("简介不能超过 500 字");
    patch.bio = params.bio;
    fields.push("bio");
  }
  if (params.instructions !== undefined) {
    if (params.instructions.length > 32_000) throw new Error("提示词太长");
    patch.instructions = params.instructions;
    fields.push("instructions");
  }
  if (params.model !== undefined) {
    const model = params.model.trim();
    if (!model || !deps.allowModel(model)) throw new Error("模型不在白名单内");
    patch.model = model;
    fields.push("model");
  }
  if (params.avatarPath !== undefined) {
    const confine = deps.confineNow?.() ?? true;
    const path = confine ? imagePath(params.avatarPath) : openImagePath(params.avatarPath);
    if (!path) throw new Error(confine ? "头像路径只能在 /home/bot 或 /tmp" : "路径必须是绝对路径");
    const file = await deps.readFile(path);
    if (file.truncated || file.bytes.length > AVATAR_MAX_BYTES) throw new Error("头像不能超过 1 MiB");
    const mime = sniffImage(file.bytes);
    if (!mime) throw new Error("头像必须是 png、jpeg 或 webp");
    writeAvatar(deps.dataDir, deps.botId, file.bytes);
    patch.avatar = mime;
    fields.push("avatar");
  }
  if (params.enabledAppIds !== undefined) {
    setEnabledApps(deps.db, scope, deps.botId, params.enabledAppIds);
    fields.push("enabledApps");
  }
  if (patch.name || patch.bio !== undefined || patch.instructions !== undefined || patch.model || patch.avatar) {
    const ok = bots.update(scope, deps.botId, patch);
    if (!ok) throw new Error("找不到 bot");
  }
  if (fields.length > 0) {
    auditRepository(deps.db).write(adminScope(deps.userId), "bot.profile", deps.botId, {
      by: "bot",
      taskId: deps.taskId,
      fields,
    });
  }
  return fields;
}

export function avatarFile(dataDir: string, botId: string): string {
  return join(dataDir, "avatars", botId);
}

export function lineDiff(before: string, after: string): string {
  if (before === after) return "";
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.length > 200 || right.length > 200) return [...left.map((line) => `-${line}`), ...right.map((line) => `+${line}`)].join("\n");
  const rows = left.length;
  const cols = right.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      const next = left[i] === right[j] ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
      const row = dp[i];
      if (row) row[j] = next;
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      lines.push(` ${left[i] ?? ""}`);
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      lines.push(`-${left[i] ?? ""}`);
      i += 1;
    } else {
      lines.push(`+${right[j] ?? ""}`);
      j += 1;
    }
  }
  while (i < rows) {
    lines.push(`-${left[i] ?? ""}`);
    i += 1;
  }
  while (j < cols) {
    lines.push(`+${right[j] ?? ""}`);
    j += 1;
  }
  return lines.join("\n");
}

function writeAvatar(dataDir: string, botId: string, bytes: Buffer): void {
  const path = avatarFile(dataDir, botId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
}

function imagePath(input: string): string | undefined {
  const home = normalizeBotPath(input);
  if (home) return home;
  if (!input.startsWith("/tmp/") && input !== "/tmp") return undefined;
  if (input.includes("\\") || input.includes("\0") || input.split("/").includes("..")) return undefined;
  const collapsed: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    collapsed.push(part);
  }
  const path = `/${collapsed.join("/")}`;
  if (path !== "/tmp" && !path.startsWith("/tmp/")) return undefined;
  return path;
}

function openImagePath(input: string): string | undefined {
  if (input.length === 0 || !isAbsolute(input) || input.includes("\0")) return undefined;
  return input;
}

function setEnabledApps(db: AppDatabase, scope: UserScope, botId: string, installIds: string[]): void {
  const bot = botRepository(db).findById(scope, botId);
  if (!bot) throw new Error("找不到 bot");
  const owned = db.$client
    .prepare("select i.id as id from app_installs i join machines m on m.id = i.machine_id where m.user_id = ?")
    .all(scope.userId) as Array<{ id: string }>;
  const allowed = new Set(owned.map((row) => row.id));
  if (installIds.some((id) => !allowed.has(id))) throw new Error("找不到应用");
  const wanted = new Set(installIds);
  const existing = db.$client.prepare("select app_install_id as id from bot_apps where bot_id = ?").all(botId) as Array<{ id: string }>;
  for (const row of existing) {
    db.$client.prepare("update bot_apps set enabled = ? where bot_id = ? and app_install_id = ?").run(wanted.has(row.id) ? 1 : 0, botId, row.id);
  }
  for (const id of allowed) {
    if (existing.some((row) => row.id === id)) continue;
    db.$client.prepare("insert into bot_apps (bot_id, app_install_id, enabled) values (?, ?, ?)").run(botId, id, wanted.has(id) ? 1 : 0);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export type { AvatarMime };
