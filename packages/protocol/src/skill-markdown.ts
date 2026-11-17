/**
 * Agent Skills 的 SKILL.md 前言。用 YAML 1.2 core 解析，不执行标签，不把别名展开。
 * name 与 description 必填；license、compatibility、metadata、allowed-tools 按官方类型校验。
 * 其余字段允许出现并忽略。不合规则返回 undefined，调用方只跳过这一份技能。
 */
import { parse } from "yaml";

const SKILL_FILE_LIMIT = 64 * 1024;
const NAME_LIMIT = 64;
const DESCRIPTION_LIMIT = 1024;
const COMPATIBILITY_LIMIT = 500;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export function parseSkillMarkdown(directory: string, text: string, byteLength: number): SkillFrontmatter | undefined {
  if (byteLength > SKILL_FILE_LIMIT || !SKILL_NAME.test(directory) || directory.length > NAME_LIMIT) return undefined;
  const front = frontmatter(text);
  if (front === undefined) return undefined;
  let value: unknown;
  try {
    value = parse(front, { schema: "core", maxAliasCount: 0, uniqueKeys: true });
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { name, description } = value;
  if (typeof name !== "string" || name !== directory || !SKILL_NAME.test(name) || name.length > NAME_LIMIT) return undefined;
  if (typeof description !== "string") return undefined;
  const normalized = description.replace(/\r\n/g, "\n").trim();
  if (normalized.length < 1 || normalized.length > DESCRIPTION_LIMIT) return undefined;
  if (value.license !== undefined && typeof value.license !== "string") return undefined;
  if (value.compatibility !== undefined && (typeof value.compatibility !== "string" || value.compatibility.length > COMPATIBILITY_LIMIT)) return undefined;
  if (value["allowed-tools"] !== undefined && typeof value["allowed-tools"] !== "string") return undefined;
  if (value.metadata !== undefined && !isStringRecord(value.metadata)) return undefined;
  return { name, description: normalized };
}

function frontmatter(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") return lines.slice(1, index).join("\n");
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
