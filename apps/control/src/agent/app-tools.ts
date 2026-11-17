import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { arr, obj, opt, str, union, lit } from "@earendil-works/pi-schema";
import {
  CatalogRejected,
  findVisibleApp,
  installForUser,
  listUserInstalls,
  noteBotInstall,
  publishValidatedPackage,
  recordResolvedVersion,
  searchApps,
  type CatalogDeps,
  type ConfigInput,
} from "../apps/catalog.js";
import {
  assertAppName,
  assertExactOrLatest,
  assertRegistryPackage,
  assertRequestedCommand,
  buildRegistryPackage,
  buildRemotePackage,
  headerConfigKey,
  isCredentialHeader,
  PackageCommandError,
  registrySpec,
} from "../apps/package-command.js";
import { auditRepository } from "../db/audit.js";
import { AUDIT_ACTIONS } from "../m2/events.js";
import { adminScope } from "../scope.js";
import { MachineInstallUnconfirmedError } from "../machines/client.js";

const CONFIG_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const PLACEHOLDER = /^\{\{secret:([a-z0-9_]+)\}\}$/;
const REMOTE_VERSION = "1.0.0";

export interface InstallMcpBinding {
  userId: string;
  botId: string;
  botName: string;
  taskId: string;
  catalog: CatalogDeps;
  lookup(name: string): string | undefined;
  readFile(path: string): Promise<string | undefined>;
  /** 安装成功后启动 MCP，把新工具放进当前任务。失败不回滚安装。 */
  launch(appName: string, signal?: AbortSignal): Promise<string[]>;
  onUnconfirmed?(): void;
}

const searchSchema = obj({
  query: str({ description: "关键字。匹配名称、简介、MCP 服务名和配置项。空字符串返回可见应用。" }),
});

const installSchema = obj({
  catalog: opt(obj({ name: str(), version: opt(str()) })),
  remote: opt(obj({
    name: str(),
    url: str(),
    headers: opt(obj({}, { open: true })),
  })),
  package: opt(obj({
    name: str(),
    ecosystem: union([lit("npm"), lit("pip")]),
    package: str(),
    version: str(),
    command: opt(str()),
    args: opt(arr(str())),
  })),
  config: opt(obj({}, { open: true })),
  secretKeys: opt(arr(str())),
  reason: str({ description: "为什么需要这个 MCP" }),
});

export function searchAppsTool(catalog: CatalogDeps, userId: string): AgentTool<typeof searchSchema> {
  return {
    name: "search_apps",
    label: "搜索应用",
    description: "在当前用户可见的目录应用和他的私有应用里按关键字搜索。返回名称、版本、简介、MCP 服务、配置项、高风险工具和是否已安装。不访问网络。",
    parameters: searchSchema,
    execute: async (_id, params) => {
      const query = params.query.trim();
      if (query.length > 200) return fail("关键字过长");
      const hits = searchApps(catalog, userId, query);
      return {
        content: [{ type: "text", text: hits.length === 0 ? "没有匹配的应用" : JSON.stringify(hits) }],
        details: { count: hits.length },
      };
    },
  };
}

export function installMcpTool(binding: InstallMcpBinding): AgentTool<typeof installSchema> {
  return {
    name: "install_mcp",
    label: "安装 MCP",
    description: "安装一个 MCP 并在当前任务里启用它的工具。每次都要用户批准。敏感配置必须是 request_secret 返回的 {{secret:NAME}}，不能传明文。来源三选一：catalog、remote、package。",
    parameters: installSchema,
    execute: async (_id, params, signal) => {
      if (signal?.aborted) return fail("安装已取消");
      const problem = installMcpBlock(binding.catalog, binding.userId, params);
      if (problem) return fail(problem);
      try {
        const text = await runInstall(binding, params, signal);
        return { content: [{ type: "text", text }], details: {} };
      } catch (error) {
        if (error instanceof Error && error.cause instanceof MachineInstallUnconfirmedError) binding.onUnconfirmed?.();
        if (signal?.aborted) return fail("安装等待已取消；远端结果未确认时请在应用页核对状态");
        const message = error instanceof CatalogRejected || error instanceof PackageCommandError
          ? error.message
          : "安装失败";
        return fail(message);
      }
    },
  };
}

/** 模型已经把明文写进工具参数时，从消息和步骤里抹掉，避免进入上下文。 */
export function scrubInstallPlaintext(args: unknown, catalog?: CatalogDeps, userId?: string): void {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const record = args as Record<string, unknown>;
  const secretKeys = Array.isArray(record.secretKeys)
    ? record.secretKeys.filter((item): item is string => typeof item === "string")
    : [];
  if (catalog && userId && record.catalog && typeof record.catalog === "object") {
    const source = record.catalog as { name?: unknown; version?: unknown };
    if (typeof source.name === "string") {
      const visible = findVisibleApp(catalog, userId, source.name, typeof source.version === "string" ? source.version : undefined);
      for (const item of visible?.config ?? []) if (item.secret) secretKeys.push(item.key);
    }
  }
  scrubMap(record.config, (key, value) => secretKeys.includes(key) && !PLACEHOLDER.test(value));
  const remote = record.remote;
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) return;
  const headers = (remote as { headers?: unknown }).headers;
  scrubMap(headers, (key, value) => {
    let configKey = "";
    try {
      configKey = headerConfigKey(key);
    } catch {
      configKey = "";
    }
    return (isCredentialHeader(key) || secretKeys.includes(configKey)) && !PLACEHOLDER.test(value);
  });
}

function scrubMap(value: unknown, secret: (key: string, value: string) => boolean): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (secret(key, typeof item === "string" ? item : "")) record[key] = "已填写的密钥";
  }
}

/** 批准前调用。明文密钥、缺版本、不合法来源都在这里拒绝，不创建审批。 */
export function installMcpBlock(catalog: CatalogDeps, userId: string, args: unknown): string | undefined {
  const parsed = parseInstall(args);
  if (!parsed.ok) return parsed.error;
  if (listUserInstalls(catalog, userId).some((item) => item.name === parsed.value.name && item.desired === "present" && (item.state === "installed" || item.state === "installing"))) {
    return "应用已安装或正在安装；修改配置请使用应用页";
  }
  if (parsed.value.kind === "catalog") {
    const visible = findVisibleApp(catalog, userId, parsed.value.name, parsed.value.version);
    if (!visible || (parsed.value.version !== undefined && !visible.versions.includes(parsed.value.version))) return "找不到";
    if (!parsed.value.version) return `目录应用必须写明版本。请使用版本 ${visible.version} 重新调用 install_mcp`;
    for (const item of visible.config) {
      const value = parsed.value.config[item.key];
      if (item.secret && value !== undefined && !PLACEHOLDER.test(value)) return "敏感配置不能传明文，请先调用 request_secret";
    }
  }
  return undefined;
}

export interface InstallCard {
  source: "catalog" | "remote" | "package";
  title: string;
  command: string;
  installLine?: string;
  config: Array<{ key: string; display: string }>;
  reason: string;
  riskyTools: string[];
  runsInstallScript: boolean;
}

/** 审批卡片。占位符显示成「已填写的密钥」，不包含解析后的值。 */
export function describeInstall(catalog: CatalogDeps, userId: string, args: unknown): InstallCard | undefined {
  const parsed = parseInstall(args);
  if (!parsed.ok) return undefined;
  const config = Object.entries(parsed.value.config).map(([key, value]) => ({
    key,
    display: PLACEHOLDER.test(value) ? "已填写的密钥" : value,
  }));
  const reason = parsed.value.reason;
  if (parsed.value.kind === "catalog") {
    const visible = findVisibleApp(catalog, userId, parsed.value.name, parsed.value.version);
    const servers = visible?.mcpServers.map((server) => [server.command ?? server.url ?? server.name, ...(server.args ?? []).map((arg) => JSON.stringify(arg))].join(" ")) ?? [];
    return {
      source: "catalog",
      title: `${parsed.value.name}${parsed.value.version ? ` ${parsed.value.version}` : ""}`,
      command: servers.length > 0 ? servers.join("\n") : "（目录应用未声明启动命令）",
      config,
      reason,
      riskyTools: visible?.riskyTools ?? [],
      runsInstallScript: visible?.runsInstallScript ?? false,
    };
  }
  if (parsed.value.kind === "remote") {
    return {
      source: "remote",
      title: parsed.value.url,
      command: parsed.value.url,
      config: [...config, ...parsed.value.headers.map((item) => ({
        key: item.header,
        display: PLACEHOLDER.test(item.value) ? "已填写的密钥" : item.value,
      }))],
      reason,
      riskyTools: [],
      runsInstallScript: false,
    };
  }
  const spec = registrySpec(parsed.value.ecosystem, parsed.value.packageName, parsed.value.version);
  const line = parsed.value.ecosystem === "npm" ? `npm install ${spec}` : `pip install ${spec}`;
  return {
    source: "package",
    title: `${parsed.value.ecosystem} ${parsed.value.packageName} ${parsed.value.version}`,
    command: [parsed.value.command ? `./bin/mcp（${parsed.value.command}）` : "./bin/mcp（安装时从包的 bin 推断）", ...parsed.value.args.map((arg) => JSON.stringify(arg))].join(" "),
    installLine: line,
    config,
    reason,
    riskyTools: [],
    runsInstallScript: true,
  };
}

interface CatalogSource { kind: "catalog"; name: string; version?: string; config: Record<string, string>; secretKeys: string[]; reason: string }
interface RemoteSource {
  kind: "remote";
  name: string;
  url: string;
  headers: Array<{ header: string; value: string }>;
  config: Record<string, string>;
  secretKeys: string[];
  reason: string;
}
interface PackageSource {
  kind: "package";
  name: string;
  ecosystem: "npm" | "pip";
  packageName: string;
  version: string;
  command?: string;
  args: string[];
  config: Record<string, string>;
  secretKeys: string[];
  reason: string;
}
type InstallRequest = CatalogSource | RemoteSource | PackageSource;

function parseInstall(args: unknown): { ok: true; value: InstallRequest } | { ok: false; error: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "参数不合法" };
  const record = args as Record<string, unknown>;
  const present = ["catalog", "remote", "package"].filter((key) => record[key] !== undefined && record[key] !== null);
  if (present.length !== 1) return { ok: false, error: "catalog、remote、package 必须三选一" };
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (!reason || reason.length > 500) return { ok: false, error: "请说明为什么需要这个 MCP" };
  let secretKeys: string[];
  try {
    secretKeys = readSecretKeys(record.secretKeys);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "配置名不合法" };
  }
  let config: Record<string, string>;
  try {
    config = readConfig(record.config, secretKeys);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "配置不合法" };
  }
  try {
    if (present[0] === "catalog") return { ok: true, value: { kind: "catalog", ...readCatalog(record.catalog), config, secretKeys, reason } };
    if (present[0] === "remote") {
      const remote = readRemote(record.remote, secretKeys);
      return { ok: true, value: { kind: "remote", ...remote, config, secretKeys, reason } };
    }
    return { ok: true, value: { kind: "package", ...readPackage(record.package), config, secretKeys, reason } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "参数不合法" };
  }
}

function readSecretKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !CONFIG_KEY.test(item))) {
    throw new Error("secretKeys 里的配置名不合法");
  }
  return [...new Set(value)];
}

function readConfig(value: unknown, secretKeys: readonly string[]): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置不合法");
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!CONFIG_KEY.test(key)) throw new Error("配置名不合法");
    if (typeof item !== "string" || item.length === 0 || item.length > 4096) throw new Error("配置值不合法");
    if (item.includes("{{secret:") && !PLACEHOLDER.test(item)) throw new Error("密钥占位符必须单独作为配置值");
    if (secretKeys.includes(key) && !PLACEHOLDER.test(item)) throw new Error("敏感配置不能传明文，请先调用 request_secret");
    output[key] = item;
  }
  for (const key of secretKeys) {
    if (!(key in output)) throw new Error(`缺少敏感配置 ${key}`);
    if (!PLACEHOLDER.test(output[key] ?? "")) throw new Error("敏感配置不能传明文，请先调用 request_secret");
  }
  return output;
}

function readCatalog(value: unknown): { name: string; version?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("目录参数不合法");
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") throw new Error("目录应用名不合法");
  const name = assertAppName(record.name);
  if (record.version === undefined) return { name };
  if (typeof record.version !== "string" || record.version.length === 0 || record.version.length > 64) throw new Error("版本号不合法");
  return { name, version: record.version };
}

function readRemote(value: unknown, secretKeys: readonly string[]): { name: string; url: string; headers: Array<{ header: string; value: string }> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("远程参数不合法");
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") throw new Error("应用名不合法");
  const name = assertAppName(record.name);
  if (typeof record.url !== "string" || record.url.includes("{{secret:")) throw new Error("远程 MCP 地址无效");
  const url = record.url;
  const headers: Array<{ header: string; value: string }> = [];
  if (record.headers !== undefined) {
    if (!record.headers || typeof record.headers !== "object" || Array.isArray(record.headers)) throw new Error("请求头不合法");
    const seen = new Set<string>();
    for (const [header, item] of Object.entries(record.headers)) {
      if (typeof item !== "string" || item.length === 0 || item.length > 4096) throw new Error("请求头不合法");
      const lower = header.toLowerCase();
      if (seen.has(lower)) throw new Error("请求头重复");
      seen.add(lower);
      if (item.includes("{{secret:") && !PLACEHOLDER.test(item)) throw new Error("密钥占位符必须单独作为配置值");
      if ((isCredentialHeader(header) || secretKeys.includes(headerConfigKey(header))) && !PLACEHOLDER.test(item)) {
        throw new Error("敏感配置不能传明文，请先调用 request_secret");
      }
      headers.push({ header, value: item });
    }
  }
  return { name, url, headers };
}

function readPackage(value: unknown): {
  name: string;
  ecosystem: "npm" | "pip";
  packageName: string;
  version: string;
  command?: string;
  args: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("包参数不合法");
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") throw new Error("应用名不合法");
  const name = assertAppName(record.name);
  if (record.ecosystem !== "npm" && record.ecosystem !== "pip") throw new Error("ecosystem 只能是 npm 或 pip");
  if (typeof record.package !== "string") throw new Error("包名不合法");
  const packageName = assertRegistryPackage(record.ecosystem, record.package);
  if (typeof record.version !== "string") throw new Error("version 必须是精确版本或 latest");
  assertExactOrLatest(record.version);
  const command = assertRequestedCommand(typeof record.command === "string" ? record.command : undefined);
  const args = record.args === undefined ? [] : record.args;
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) throw new Error("启动参数不合法");
  return { name, ecosystem: record.ecosystem, packageName, version: record.version, ...(command ? { command } : {}), args };
}

async function runInstall(binding: InstallMcpBinding, args: unknown, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const parsed = parseInstall(args);
  if (!parsed.ok) throw new PackageCommandError(parsed.error);
  const request = parsed.value;
  const config = resolveConfig(request, binding.lookup);
  let installedName = "";
  let versionId = "";
  let version = "";
  const source: InstallRequest["kind"] = request.kind;
  if (request.kind === "catalog") {
    const view = await installForUser(binding.catalog, binding.userId, request.name, {
      onlyIfAbsent: true,
      ...(signal ? { signal } : {}),
      ...(request.version ? { version: request.version } : {}),
      config,
    });
    installedName = view.name;
    versionId = view.versionId;
    version = view.version;
  } else if (request.kind === "remote") {
    const published = await publishRemote(binding, request);
    const view = await installForUser(binding.catalog, binding.userId, request.name, {
      onlyIfAbsent: true,
      ...(signal ? { signal } : {}),
      version: published.version,
      config: remoteConfig(request, binding.lookup, config),
    });
    installedName = view.name;
    versionId = view.versionId;
    version = view.version;
  } else {
    const published = await publishPackage(binding, request);
    const view = await installForUser(binding.catalog, binding.userId, request.name, {
      onlyIfAbsent: true,
      ...(signal ? { signal } : {}),
      version: published.version,
      config,
    });
    installedName = view.name;
    versionId = view.versionId;
    version = view.version;
    const resolved = await binding.readFile(`/home/bot/.viate/apps/${request.name}/data/resolved-version`);
    const recorded = resolved?.trim();
    if (recorded) version = recordResolvedVersion(binding.catalog, versionId, recorded);
  }
  const installId = installIdFor(binding, installedName);
  if (installId) noteBotInstall(binding.catalog, installId, { id: binding.botId, name: binding.botName });
  const approver = approverFor(binding);
  auditRepository(binding.catalog.db).write(adminScope(approver), AUDIT_ACTIONS.appInstallByBot, installId || installedName, {
    source,
    version,
    botId: binding.botId,
    taskId: binding.taskId,
    approver,
  });
  try {
    signal?.throwIfAborted();
    const tools = await binding.launch(installedName, signal);
    const listed = tools.length > 0 ? tools.join("、") : "（这个 MCP 没有新工具）";
    return `已安装 ${installedName} ${version}。新工具：${listed}。下一轮可以直接调用。`;
  } catch {
    return failText("安装已完成，但 MCP 启动失败。可以在应用页查看日志。");
  }
}

function failText(text: string): never {
  const error = new PackageCommandError(text);
  throw error;
}

async function publishRemote(binding: InstallMcpBinding, request: RemoteSource): Promise<{ version: string; versionId: string }> {
  const headers = request.headers.map((item) => ({
    header: item.header,
    key: headerConfigKey(item.header),
    secret: isCredentialHeader(item.header) || PLACEHOLDER.test(item.value),
  }));
  const headerKeys = new Set(headers.map((item) => item.key));
  for (const key of Object.keys(request.config)) {
    if (headerKeys.has(key)) throw new PackageCommandError(`配置项 ${key} 与请求头冲突`);
  }
  const pkg = buildRemotePackage({
    appName: request.name,
    url: request.url,
    headers,
    config: Object.keys(request.config).sort().map((key) => ({
      key,
      secret: request.secretKeys.includes(key) || PLACEHOLDER.test(request.config[key] ?? ""),
    })),
  });
  const saved = await publishValidatedPackage(binding.catalog, binding.userId, pkg, {
    version: REMOTE_VERSION,
    privateUserId: binding.userId,
  });
  return { version: saved.version, versionId: saved.versionId };
}

async function publishPackage(binding: InstallMcpBinding, request: PackageSource): Promise<{ version: string; versionId: string }> {
  const pkg = buildRegistryPackage({
    appName: request.name,
    ecosystem: request.ecosystem,
    packageName: request.packageName,
    version: request.version,
    ...(request.command ? { command: request.command } : {}),
    args: request.args,
    config: Object.keys(request.config).sort().map((key) => ({
      key,
      secret: request.secretKeys.includes(key) || PLACEHOLDER.test(request.config[key] ?? ""),
    })),
  });
  const saved = await publishValidatedPackage(binding.catalog, binding.userId, pkg, {
    version: request.version,
    privateUserId: binding.userId,
  });
  return { version: saved.version, versionId: saved.versionId };
}

function remoteConfig(request: RemoteSource, lookup: (name: string) => string | undefined, base: ConfigInput): ConfigInput {
  const config: ConfigInput = { ...base };
  for (const item of request.headers) {
    const key = headerConfigKey(item.header);
    const secret = isCredentialHeader(item.header) || PLACEHOLDER.test(item.value);
    const value = resolveValue(item.value, lookup);
    config[key] = secret ? { secret: true, value } : value;
  }
  return config;
}

function resolveConfig(request: InstallRequest, lookup: (name: string) => string | undefined): ConfigInput {
  const config: ConfigInput = {};
  for (const [key, value] of Object.entries(request.config)) {
    const resolved = resolveValue(value, lookup);
    config[key] = request.secretKeys.includes(key) || PLACEHOLDER.test(value) ? { secret: true, value: resolved } : resolved;
  }
  return config;
}

function resolveValue(value: string, lookup: (name: string) => string | undefined): string {
  const match = PLACEHOLDER.exec(value);
  if (!match) return value;
  const found = lookup(match[1] ?? "");
  if (found === undefined || found.length === 0) throw new PackageCommandError(`密钥 ${match[1]} 不存在`);
  return found;
}

function installIdFor(binding: InstallMcpBinding, name: string): string {
  const row = binding.catalog.db.$client.prepare(
    `select i.id as id from app_installs i
     join app_versions v on v.id = i.app_version_id
     join apps a on a.id = v.app_id
     join machines m on m.id = i.machine_id
     where m.user_id = ? and a.name = ? and i.desired = 'present'
     order by i.updated_at desc limit 1`,
  ).get(binding.userId, name) as { id: string } | undefined;
  return row?.id ?? "";
}

function approverFor(binding: InstallMcpBinding): string {
  const row = binding.catalog.db.$client.prepare(
    `select decided_by as decidedBy from approvals
     where task_id = ? and tool = 'install_mcp' and state = 'allowed'
     order by rowid desc limit 1`,
  ).get(binding.taskId) as { decidedBy: string | null } | undefined;
  return row?.decidedBy || binding.userId;
}

function fail(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}
