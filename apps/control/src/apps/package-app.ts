import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { readTar, validatePackage, type PackageFile, type ValidatedPackage } from "./archive.js";
import { CatalogRejected, publishValidatedPackage, type CatalogDeps } from "./catalog.js";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_PREFIX = /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9])/;
const BEARER = /authorization:\s*bearer\s+[A-Za-z0-9._~+/-]{20,}/i;

export interface PackageAppResult {
  name: string;
  version: string;
  kinds: string[];
  files: number;
  bytes: number;
  warnings: string[];
}

export async function packageAppFromArchive(
  deps: CatalogDeps,
  userId: string,
  input: { version: string; note?: string; archive: Buffer; secrets: readonly string[] },
): Promise<PackageAppResult> {
  if (!SEMVER.test(input.version)) throw new CatalogRejected("版本号必须是 semver", 400);
  if (input.note !== undefined && [...input.note].length > 500) throw new CatalogRejected("说明过长", 400);
  let files: PackageFile[];
  try {
    files = readTar(input.archive);
  } catch (error) {
    throw new CatalogRejected("应用包不合法", 400, { cause: error });
  }
  let pkg: ValidatedPackage;
  try {
    pkg = validatePackage(files);
  } catch (error) {
    throw new CatalogRejected("应用包不合法", 400, { cause: error });
  }
  assertNoSecrets(pkg, input.secrets);
  const published = await publishValidatedPackage(deps, userId, pkg, { version: input.version, privateUserId: userId });
  return {
    name: published.name,
    version: published.version,
    kinds: packageKinds(pkg),
    files: pkg.files.length,
    bytes: pkg.files.reduce((sum, file) => sum + file.data.length, 0),
    warnings: published.warnings,
  };
}

export interface PackageAppClient {
  pack(path: string, signal?: AbortSignal, confine?: boolean): Promise<Buffer>;
}

export function packageAppTool(binding: {
  userId: string;
  catalog: CatalogDeps;
  client: PackageAppClient;
  secrets(): readonly string[];
  /** 任务开始时的说明。不传则保持原来的限制文案。 */
  confined?: boolean;
  /** 每次打包再读。不传则继续限制在 /home/bot 和 /tmp。 */
  confineNow?: () => boolean;
}) {
  const confined = binding.confined !== false;
  const confineNow = binding.confineNow ?? (() => true);
  const packageSchema = obj({
    path: str({ description: confined ? "机器上的目录，只能在 /home/bot 或 /tmp 下" : "机器上的目录" }),
    version: str({ description: "semver 版本" }),
    note: opt(str({ description: "给自己的说明，最多 500 字" })),
  });
  const tool: AgentTool<typeof packageSchema> = {
    name: "package_app",
    label: "打包应用",
    description: "把当前用户机器上的一个目录打成私有应用。不需要批准，也不会对其他用户可见。",
    parameters: packageSchema,
    execute: async (_toolCallId, params, signal) => {
      const confine = confineNow();
      if (confine) assertPackPath(params.path);
      else if (!params.path.startsWith("/")) throw new Error("路径必须是绝对路径");
      const archive = await binding.client.pack(params.path, signal, confine);
      const saved = await packageAppFromArchive(binding.catalog, binding.userId, {
        version: params.version,
        archive,
        secrets: binding.secrets(),
        ...(params.note !== undefined ? { note: params.note } : {}),
      });
      const warnings = saved.warnings.length === 0 ? "无" : saved.warnings.join("；");
      const text = [
        `${saved.name} ${saved.version}`,
        `类型：${saved.kinds.join("、") || "未识别"}`,
        `文件数：${saved.files}`,
        `大小：${saved.bytes}`,
        `警告：${warnings}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: saved };
    },
  };
  return tool;
}

function assertPackPath(path: string): void {
  if (path.includes("\0") || path.split("/").includes("..")) throw new Error("路径只能在 /home/bot 或 /tmp 下");
  const inside = path === "/home/bot" || path.startsWith("/home/bot/") || path === "/tmp" || path.startsWith("/tmp/");
  if (!inside) throw new Error("路径只能在 /home/bot 或 /tmp 下");
}

function assertNoSecrets(pkg: ValidatedPackage, secrets: readonly string[]): void {
  const known = secrets.filter((value) => value.length > 0);
  for (const file of pkg.files) {
    if (file.data.includes(0)) continue;
    const text = file.data.toString("utf8");
    if (PRIVATE_KEY.test(text)) rejectSecret(file.path, "私钥块");
    if (KEY_PREFIX.test(text)) rejectSecret(file.path, "密钥前缀");
    if (BEARER.test(text)) rejectSecret(file.path, "Bearer 令牌");
    if (known.some((value) => text.includes(value))) rejectSecret(file.path, "已知密钥");
  }
  const mcp = pkg.files.find((file) => file.path === "mcp.json");
  if (!mcp || mcp.data.includes(0)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(mcp.data.toString("utf8")) as unknown;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || !("mcpServers" in parsed)) return;
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object") return;
  const declared = declaredKeys(pkg.extension);
  for (const server of Object.values(servers)) {
    if (!server || typeof server !== "object") continue;
    const record = server as { env?: unknown; headers?: unknown };
    for (const value of configValues(record.env, record.headers)) {
      if (!allowedConfigValue(value, declared)) rejectSecret("mcp.json", "明文配置");
    }
  }
}

function configValues(env: unknown, headers: unknown): string[] {
  const values: string[] = [];
  for (const source of [env, headers]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const value of Object.values(source)) if (typeof value === "string") values.push(value);
  }
  return values;
}

function allowedConfigValue(value: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(value)) return true;
  if (!value.includes("${")) return false;
  const refs = value.matchAll(/\$\{config\.([A-Z][A-Z0-9_]{0,63})\}/g);
  for (const ref of refs) {
    if (!declared.has(ref[1] ?? "")) rejectSecret("mcp.json", "未声明的配置键");
  }
  const rest = value.replace(/\$\{[^}]+\}/g, "");
  return rest.length === 0;
}

function declaredKeys(extension: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(extension.config)) return keys;
  for (const item of extension.config) {
    if (item && typeof item === "object" && "key" in item && typeof item.key === "string") keys.add(item.key);
  }
  return keys;
}

function rejectSecret(path: string, rule: string): never {
  throw new CatalogRejected(`${path}: ${rule}`, 400);
}

export function packageKinds(pkg: ValidatedPackage): string[] {
  const kinds: string[] = [];
  if (pkg.skills.length > 0) kinds.push("技能");
  const mcp = pkg.files.find((file) => file.path === "mcp.json");
  if (mcp && !mcp.data.includes(0)) {
    try {
      const parsed = JSON.parse(mcp.data.toString("utf8")) as { mcpServers?: Record<string, { type?: unknown }> };
      const servers = Object.values(parsed.mcpServers ?? {});
      if (servers.some((server) => server?.type === "stdio")) kinds.push("本地 MCP");
      if (servers.some((server) => server?.type === "streamable-http" || server?.type === "sse")) kinds.push("远程 MCP");
    } catch {
      // 类型只用于展示。非法 mcp.json 已经在校验警告里。
    }
  }
  if (Array.isArray(pkg.extension.routines) && pkg.extension.routines.length > 0) kinds.push("定时任务");
  return kinds;
}
