import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";
import { parseSkillMarkdown, type FsListResponse, type FsReadResponse, type FsWriteResponse, type MachineEndpoint, type SkillListResponse, type SkillReadResponse } from "@viate-bot/protocol";
import { ulid } from "../id.js";
import { maskSecrets as maskSecretValues } from "./text.js";

/** OpenAI 函数名不接受点号，所以 skill.read 的工具名是 skill_read。 */
export const SKILL_READ_TOOL_NAME = "skill_read";
/** save-skill 的工具名。连字符与现有工具一样用下划线。 */
export const SAVE_SKILL_TOOL_NAME = "save_skill";

/** 提示词里全部技能说明合计不超过 8KB。 */
export const SKILL_DESCRIPTION_BUDGET = 8 * 1024;
/** 一份 SKILL.md 最多 64KB。 */
export const SKILL_FILE_LIMIT = 64 * 1024;

export const SKILL_ROOT = "/home/bot/.viate/skills";
export const APP_ROOT = "/home/bot/.viate/apps";
export const SKILL_APP_SOURCE = "user" as const;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const APP_DIR = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export interface SecretRef {
  name: string;
  value: string;
}

export type MaskSecrets = (text: string, secrets: SecretRef[]) => string;

/**
 * machined 上的技能读写。集成方用 skillHttpMachine 走
 * GET /skills、POST /skills/read {name}、POST /skills/save {name, content, secrets?}。
 * skillMachine 仍可用文件接口。secrets 是要打掉的明文，不是模型可见的结果。
 */
export interface SkillMachine {
  listSkills(signal?: AbortSignal): Promise<SkillListResponse>;
  readSkill(name: string, signal?: AbortSignal): Promise<SkillReadResponse>;
  writeSkill(
    name: string,
    content: string,
    signal?: AbortSignal,
    secrets?: readonly string[],
  ): Promise<{ path: string; bytes: number }>;
}

interface SkillHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface SkillHttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: "manual";
  signal?: AbortSignal;
}

export interface SkillFsClient {
  read(path: string, maxBytes: number, signal?: AbortSignal, encoding?: "utf8" | "base64", confine?: boolean): Promise<FsReadResponse>;
  write(path: string, content: string, signal?: AbortSignal, confine?: boolean): Promise<FsWriteResponse>;
  list(path: string, signal?: AbortSignal, confine?: boolean): Promise<FsListResponse>;
}

/**
 * 私有技能对应的应用行。集成方把它交给 createPrivateApp：
 * source 必须是 user，owner 是当前用户。skillMarkdown 已经打码，不是配置，不能写进 config_json。
 */
export interface PrivateSkillDraft {
  ownerUserId: string;
  name: string;
  version: string;
  description: string;
  skillMarkdown: string;
  manifestJson: string;
  archivePath: string;
  sha256: string;
}

export interface PrivateSkillRecord {
  id: string;
  versionId: string;
  name: string;
  source: typeof SKILL_APP_SOURCE;
  ownerUserId: string;
}

export interface PrivateAppStorage {
  saveUserSkill(draft: PrivateSkillDraft): PrivateSkillRecord | Promise<PrivateSkillRecord>;
}

export interface SkillToolBinding {
  /** 绑定到当前用户。模型参数里没有用户 id，不能写到别人名下。 */
  ownerUserId: string;
  machine: SkillMachine;
  knownSecrets: () => SecretRef[];
  /** 配置明文。写入前必须从技能文件里去掉，不能进 SKILL.md。 */
  configValues?: () => string[];
  maskSecrets?: MaskSecrets;
  apps: PrivateAppStorage;
}

const readSchema = obj({
  name: str({ description: "技能名字；重名时使用来源/技能名。" }),
});

const saveSchema = obj({
  name: str({ description: "技能名字。小写字母、数字和连字符，1 到 64 个字符。" }),
  description: str({ description: "一句话说明，最多 1024 个字符，不能包含引号或换行。" }),
  content: str({ description: "SKILL.md 正文。不要写入密钥或配置原文，用 {{secret:NAME}} 引用。" }),
});

export function isSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME.test(name);
}

function isSkillId(name: string): boolean {
  const parts = name.split("/");
  return parts.length === 1 ? isSkillName(name) : parts.length === 2 && isAppDir(parts[0]!) && isSkillName(parts[1]!);
}

export function skillFilePath(name: string): string {
  if (!isSkillName(name)) throw new Error("技能名字无效");
  return `${SKILL_ROOT}/${name}/SKILL.md`;
}

/** 把技能说明放进提示词。整段按字节截断到 8KB。空列表返回空串。 */
export function formatSkillSection(
  skills: ReadonlyArray<{ name: string; description: string }>,
  budget = SKILL_DESCRIPTION_BUDGET,
): string {
  if (budget <= 0 || skills.length === 0) return "";
  const header = "技能（用 skill_read 读取某一份，单份最多 64KB）：";
  const headerBytes = Buffer.byteLength(header);
  if (headerBytes > budget) return clipUtf8(header, budget);
  const noteReserve = skills.length > 1 ? Math.min(48, budget - headerBytes) : 0;
  const limit = budget - noteReserve;
  const lines = [header];
  let used = headerBytes;
  let index = 0;
  for (; index < skills.length; index += 1) {
    const skill = skills[index];
    if (!skill) break;
    const name = skill.name.replace(/[\r\n]+/g, " ").trim();
    if (name.length === 0) continue;
    const description = skill.description.replace(/[\r\n]+/g, " ").trim();
    const line = `- ${name}: ${description}`;
    const bytes = Buffer.byteLength(line) + 1;
    if (used + bytes <= limit) {
      lines.push(line);
      used += bytes;
      continue;
    }
    const room = limit - used - 1;
    const prefix = `- ${name}: `;
    const prefixBytes = Buffer.byteLength(prefix);
    const ellipsisBytes = Buffer.byteLength("…");
    if (room >= prefixBytes + ellipsisBytes) {
      const partial = `${prefix}${clipUtf8(description, room - prefixBytes - ellipsisBytes)}…`;
      if (Buffer.byteLength(partial) <= room) {
        lines.push(partial);
        index += 1;
      }
    }
    break;
  }
  let text = lines.join("\n");
  const omitted = skills.length - index;
  if (omitted > 0) {
    const withNote = `${text}\n…[另有 ${omitted} 个技能未列入]…`;
    if (Buffer.byteLength(withNote) <= budget) text = withNote;
  }
  return Buffer.byteLength(text) <= budget ? text : clipUtf8(text, budget);
}

export async function skillPrompt(
  binding: Pick<SkillToolBinding, "machine" | "knownSecrets" | "configValues" | "maskSecrets">,
  budget = SKILL_DESCRIPTION_BUDGET,
  signal?: AbortSignal,
): Promise<string> {
  const listed = await binding.machine.listSkills(signal);
  const mask = binding.maskSecrets ?? maskSecretValues;
  const secrets = binding.knownSecrets();
  const configValues = binding.configValues?.() ?? [];
  const skills = listed.skills.map((skill) => ({
    name: skill.name,
    description: scrubLoose(skill.description, secrets, configValues, mask),
  }));
  return formatSkillSection(skills, budget);
}

/**
 * 走 machined 的技能路由，只请求绑定的 host:port。
 * 保存前调用方已经用 maskSecrets 打过码；secrets 再交给机器扫一遍剩余明文。
 */
export function skillHttpMachine(
  endpoint: MachineEndpoint,
  request: (url: string, init: SkillHttpInit) => Promise<SkillHttpResponse> = skillRequest(),
): SkillMachine {
  const origin = skillOrigin(endpoint);
  const call = async (path: "/skills" | "/skills/read" | "/skills/save", method: "GET" | "POST", body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const init: SkillHttpInit = {
      method,
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        accept: "application/json",
      },
      redirect: "manual",
    };
    if (body !== undefined) {
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    if (signal) init.signal = signal;
    let response: SkillHttpResponse;
    try {
      response = await request(`${origin}${path}`, init);
    } catch {
      throw new Error("连不上这台机器");
    }
    if (response.status >= 300 && response.status < 400) throw new Error("技能请求失败");
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text) as unknown;
    } catch {
      throw new Error("技能返回无效");
    }
    if (!response.ok) throw new Error(skillHttpError(parsed, endpoint.token));
    return parsed;
  };
  return {
    async listSkills(signal) {
      return parseSkillList(await call("/skills", "GET", undefined, signal));
    },
    async readSkill(name, signal) {
      if (!isSkillId(name)) throw new Error("技能名字无效");
      return parseSkillRead(name, await call("/skills/read", "POST", { name }, signal));
    },
    async writeSkill(name, content, signal, secrets) {
      if (!isSkillName(name)) throw new Error("技能名字无效");
      if (Buffer.byteLength(content) > SKILL_FILE_LIMIT) throw new Error("技能超过 64KB");
      const body: { name: string; content: string; secrets?: string[] } = { name, content };
      if (secrets !== undefined && secrets.length > 0) body.secrets = [...secrets];
      const value = await call("/skills/save", "POST", body, signal);
      if (!value || typeof value !== "object" || Array.isArray(value) || !("path" in value) || typeof value.path !== "string" || value.path.length === 0) {
        throw new Error("技能保存结果无效");
      }
      if (value.path.includes("\0") || value.path.includes("://")) throw new Error("技能保存结果无效");
      return { path: value.path, bytes: Buffer.byteLength(content) };
    },
  };
}

/** 用已有的 machined 文件接口读写技能。私有技能在 /home/bot/.viate/skills，已安装应用在 current/skills。 */
export function skillMachine(client: SkillFsClient): SkillMachine {
  return {
    async listSkills(signal) {
      const skills: SkillListResponse["skills"] = [];
      const seen = new Set<string>();
      const add = async (name: string, path: string) => {
        if (seen.has(name) || !isSkillName(name)) return;
        const file = await readOptional(client, path, signal);
        if (!file) return;
        seen.add(name);
        skills.push({ name, description: skillDescription(name, file.content) });
      };
      for (const entry of await listOptional(client, SKILL_ROOT, signal)) {
        if (entry.type !== "dir") continue;
        await add(entry.name, `${SKILL_ROOT}/${entry.name}/SKILL.md`);
      }
      for (const app of await listOptional(client, APP_ROOT, signal)) {
        if (app.type !== "dir" || !isAppDir(app.name)) continue;
        const root = `${APP_ROOT}/${app.name}/current/skills`;
        for (const entry of await listOptional(client, root, signal)) {
          if (entry.type !== "dir") continue;
          await add(entry.name, `${root}/${entry.name}/SKILL.md`);
        }
      }
      return { skills };
    },
    async readSkill(name, signal) {
      if (!isSkillId(name)) throw new Error("技能名字无效");
      if (name.includes("/")) {
        const [source, skill] = name.split("/");
        const path = source === "user" ? skillFilePath(skill!) : `${APP_ROOT}/${source}/current/skills/${skill}/SKILL.md`;
        const result = await readOptional(client, path, signal);
        if (!result) throw new Error("找不到这个技能");
        return { name, content: result.content, truncated: result.truncated };
      }
      const direct = await readOptional(client, skillFilePath(name), signal);
      if (direct) return { name, content: direct.content, truncated: direct.truncated };
      for (const app of await listOptional(client, APP_ROOT, signal)) {
        if (app.type !== "dir" || !isAppDir(app.name)) continue;
        const path = `${APP_ROOT}/${app.name}/current/skills/${name}/SKILL.md`;
        const found = await readOptional(client, path, signal);
        if (found) return { name, content: found.content, truncated: found.truncated };
      }
      throw new Error("找不到这个技能");
    },
    async writeSkill(name, content, signal) {
      const path = skillFilePath(name);
      if (Buffer.byteLength(content) > SKILL_FILE_LIMIT) throw new Error("技能超过 64KB");
      const written = await client.write(path, content, signal, true);
      return { path: written.path, bytes: written.bytes };
    },
  };
}

/**
 * 工具绑定到这一个用户和这一台 machined。
 * skill_read 向机器要正文；save_skill 先打码，再写入，并写 source=user 应用行。
 * HTTP 实现是 skillHttpMachine：GET /skills、POST /skills/read、POST /skills/save。
 * 两者都不在只读名单或控制面名单里，要走 beforeToolCall 的精确名字和参数审批。
 * SKILL.md 里的 allowed-tools 只是正文，不会变成放行。
 */
export function skillTools(binding: SkillToolBinding): AgentTool[] {
  const read: AgentTool<typeof readSchema> = {
    name: SKILL_READ_TOOL_NAME,
    label: "读取技能",
    description: "向当前用户的机器读取一份技能说明。单份最多 64KB。不能选择别的机器。",
    parameters: readSchema,
    execute: async (_toolCallId, params, signal) => {
      const name = params.name.trim();
      if (!isSkillId(name)) throw new Error("技能名字无效");
      const result = await binding.machine.readSkill(name, signal);
      const mask = binding.maskSecrets ?? maskSecretValues;
      const secrets = binding.knownSecrets();
      const configValues = binding.configValues?.() ?? [];
      const masked = scrubLoose(result.content, secrets, configValues, mask);
      const capped = capUtf8(masked, SKILL_FILE_LIMIT);
      const truncated = result.truncated || capped.truncated;
      const note = truncated ? "\n…[内容已截断]…" : "";
      return {
        content: [{ type: "text", text: capped.text + note }],
        details: { name, truncated },
      };
    },
  };

  const save: AgentTool<typeof saveSchema> = {
    name: SAVE_SKILL_TOOL_NAME,
    label: "保存技能",
    description: "把一份私有技能写到当前用户的机器，并记一条只有该用户可见的应用。密钥和配置原文不会写进文件。",
    parameters: saveSchema,
    execute: async (_toolCallId, params, signal) => {
      if (binding.ownerUserId.length === 0 || binding.ownerUserId.includes("\0")) throw new Error("用户无效");
      const mask = binding.maskSecrets ?? maskSecretValues;
      const secrets = binding.knownSecrets();
      const configValues = binding.configValues?.() ?? [];
      const prepared = prepareSkill(params.name, params.description, params.content, secrets, configValues, mask);
      const secretValues = [...secrets.map((item) => item.value), ...configValues].filter((value) => value.length > 0);
      const written = await binding.machine.writeSkill(prepared.name, prepared.skillMarkdown, signal, secretValues);
      const saved = await binding.apps.saveUserSkill({
        ownerUserId: binding.ownerUserId,
        name: prepared.name,
        version: ulid(),
        description: prepared.description,
        skillMarkdown: prepared.skillMarkdown,
        manifestJson: prepared.manifestJson,
        archivePath: written.path,
        sha256: prepared.sha256,
      });
      if (saved.source !== SKILL_APP_SOURCE || saved.ownerUserId !== binding.ownerUserId || saved.name !== prepared.name) {
        throw new Error("私有技能没有记到当前用户名下");
      }
      return {
        content: [{ type: "text", text: `已保存私有技能 ${prepared.name}` }],
        details: { name: prepared.name, appId: saved.id, versionId: saved.versionId, path: written.path },
      };
    },
  };

  return [read, save];
}

export function skillDescription(name: string, markdown: string): string {
  return parseSkillMarkdown(name, markdown, Buffer.byteLength(markdown))?.description ?? "";
}

function prepareSkill(
  name: string,
  description: string,
  body: string,
  secrets: SecretRef[],
  configValues: readonly string[],
  mask: MaskSecrets,
): { name: string; description: string; skillMarkdown: string; manifestJson: string; sha256: string } {
  const safeName = name.trim();
  if (!isSkillName(safeName)) throw new Error("技能名字无效");
  if (Buffer.byteLength(description) > SKILL_FILE_LIMIT || Buffer.byteLength(body) > SKILL_FILE_LIMIT) {
    throw new Error("技能超过 64KB");
  }
  assertShortConfig(safeName, configValues);
  assertShortConfig(description, configValues);
  assertShortConfig(body, configValues);
  const safeDescription = scrubStrict(description.trim(), secrets, configValues, mask);
  if (!isSkillDescription(safeDescription)) throw new Error("技能说明无效");
  const safeBody = scrubStrict(body, secrets, configValues, mask).replace(/\r\n/g, "\n");
  assertNoLeak(safeName, "技能名字", secrets, configValues);
  assertNoLeak(safeDescription, "技能说明", secrets, configValues);
  assertNoLeak(safeBody, "技能正文", secrets, configValues);
  const skillMarkdown = renderSkill(safeName, safeDescription, safeBody);
  if (Buffer.byteLength(skillMarkdown) > SKILL_FILE_LIMIT) throw new Error("技能超过 64KB");
  const manifestJson = JSON.stringify({ name: safeName, description: safeDescription });
  return {
    name: safeName,
    description: safeDescription,
    skillMarkdown,
    manifestJson,
    sha256: createHash("sha256").update(skillMarkdown).digest("hex"),
  };
}

function renderSkill(name: string, description: string, body: string): string {
  const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "");
  const suffix = trimmed.length === 0 ? "\n" : `\n\n${trimmed}\n`;
  return `---\nname: ${name}\ndescription: ${description}\n---${suffix}`;
}

function isSkillDescription(value: string): boolean {
  return value.length >= 1 && value.length <= 1024 && !/[\r\n'"]/.test(value);
}

function isAppDir(name: string): boolean {
  return APP_DIR.test(name) && !name.includes("..") && !name.includes("--");
}

function scrubStrict(text: string, secrets: SecretRef[], configValues: readonly string[], mask: MaskSecrets): string {
  const output = applyMask(text, secrets, configValues, mask);
  assertNoLeak(output, "技能", secrets, configValues);
  return output;
}

function scrubLoose(text: string, secrets: SecretRef[], configValues: readonly string[], mask: MaskSecrets): string {
  const output = applyMask(text, secrets, configValues, mask);
  if (leaks(output, secrets, configValues)) return "[redacted]";
  return output;
}


function applyMask(text: string, secrets: SecretRef[], configValues: readonly string[], mask: MaskSecrets): string {
  let output = mask(text, secrets);
  const values = [...configValues].filter((value) => value.length >= 4).sort((left, right) => right.length - left.length);
  for (const value of values) {
    if (output.includes(value)) output = output.split(value).join("[redacted]");
  }
  return output;
}

function assertNoLeak(text: string, label: string, secrets: SecretRef[], configValues: readonly string[]): void {
  if (secrets.some((secret) => leaked(text, secret.value))) throw new Error(`${label}里还有密钥，已拒绝写入`);
  if (configValues.some((value) => leaked(text, value))) throw new Error(`${label}里还有配置值，已拒绝写入`);
}

function leaks(text: string, secrets: SecretRef[], configValues: readonly string[]): boolean {
  return secrets.some((secret) => leaked(text, secret.value)) || configValues.some((value) => leaked(text, value));
}

function leaked(text: string, value: string): boolean {
  if (value.length < 4) return false;
  const stripped = text.replace(/\{\{secret:[A-Za-z0-9_:.-]+\}\}/g, "").replaceAll("[redacted]", "");
  return stripped.includes(value);
}

function assertShortConfig(text: string, configValues: readonly string[]): void {
  for (const value of configValues) {
    if (value.length > 0 && value.length < 4 && text.includes(value)) {
      throw new Error("配置值太短，无法安全打码，已拒绝写入");
    }
  }
}

function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  return { text: clipUtf8(text, maxBytes), truncated: true };
}

function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

async function listOptional(client: SkillFsClient, path: string, signal?: AbortSignal): Promise<FsListResponse["entries"]> {
  try {
    return (await client.list(path, signal, true)).entries;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readOptional(client: SkillFsClient, path: string, signal?: AbortSignal): Promise<FsReadResponse | undefined> {
  try {
    return await client.read(path, SKILL_FILE_LIMIT, signal, undefined, true);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("不存在") || message.includes("ENOENT");
}

function skillRequest(): (url: string, init: SkillHttpInit) => Promise<SkillHttpResponse> {
  const fallback = globalThis.fetch.bind(globalThis);
  return (url, init) => fallback(url, init);
}

function skillOrigin(endpoint: MachineEndpoint): string {
  if (!endpoint || typeof endpoint.host !== "string" || typeof endpoint.token !== "string" || endpoint.token.length === 0) {
    throw new Error("机器地址不完整");
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error("机器端口无效");
  if (
    endpoint.host.length === 0 ||
    endpoint.host.includes("://") ||
    endpoint.host.includes("/") ||
    endpoint.host.includes("?") ||
    endpoint.host.includes("#") ||
    endpoint.host.includes("@") ||
    endpoint.host.includes("\\") ||
    endpoint.host.includes(" ")
  ) {
    throw new Error("机器地址必须是主机名，不能是远程 URL");
  }
  const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[") ? `[${endpoint.host}]` : endpoint.host;
  return `http://${host}:${endpoint.port}`;
}

function skillHttpError(value: unknown, token: string): string {
  const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "";
  if (message.length === 0 || message.length > 200 || message.includes(token) || message.includes("://") || message.includes("$")) {
    return "技能请求失败";
  }
  return message;
}

function parseSkillList(value: unknown): SkillListResponse {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("skills" in value) || !Array.isArray(value.skills)) {
    throw new Error("技能列表无效");
  }
  const skills: SkillListResponse["skills"] = [];
  for (const item of value.skills) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("name" in item) || typeof item.name !== "string") {
      throw new Error("技能列表无效");
    }
    const description = "description" in item && typeof item.description === "string" ? item.description : "";
    skills.push({ name: item.name, description });
  }
  return { skills };
}

function parseSkillRead(name: string, value: unknown): SkillReadResponse {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("content" in value) || typeof value.content !== "string") {
    throw new Error("技能内容无效");
  }
  const truncated = "truncated" in value && value.truncated === true;
  return { name, content: value.content, truncated };
}
