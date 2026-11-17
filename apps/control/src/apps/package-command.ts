import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validatePackage, type ValidatedPackage } from "./archive.js";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const APP_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PIP_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const FORBIDDEN = new Set(["npx", "npm", "uvx", "uv", "pip", "pip3", "python", "python3", "node", "sh", "bash", "sudo", "busybox"]);
const CONFIG_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

const linkSource = readFileSync(fileURLToPath(new URL("./link-mcp.mjs", import.meta.url)));

export class PackageCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageCommandError";
  }
}

export function assertExactOrLatest(version: string): "latest" | "exact" {
  if (version === "latest") return "latest";
  if (EXACT_VERSION.test(version)) return "exact";
  throw new PackageCommandError("version 必须是精确版本或 latest");
}

export function assertAppName(name: string): string {
  if (!APP_NAME.test(name) || name.includes("..") || name.includes("--")) throw new PackageCommandError("应用名不合法");
  return name;
}

export function assertRegistryPackage(ecosystem: "npm" | "pip", packageName: string): string {
  if (ecosystem === "npm") {
    if (!NPM_NAME.test(packageName) || packageName.startsWith("-") || packageName.length > 214) throw new PackageCommandError("npm 包名不合法");
    return packageName;
  }
  if (!PIP_NAME.test(packageName) || packageName.length > 214) throw new PackageCommandError("pip 包名不合法");
  return packageName;
}

/** 只检查调用方给出的 command 形状。真正的 bin 要等机器装完再读。 */
export function assertRequestedCommand(command: string | undefined): string | undefined {
  if (command === undefined || command.length === 0) return undefined;
  if (!BIN_NAME.test(command) || command.includes("/") || FORBIDDEN.has(command)) {
    throw new PackageCommandError("启动命令必须是已安装包里的可执行文件名，不能是 npx、uvx 或 shell");
  }
  return command;
}

export function registrySpec(ecosystem: "npm" | "pip", packageName: string, version: string): string {
  assertRegistryPackage(ecosystem, packageName);
  assertExactOrLatest(version);
  if (ecosystem === "npm") return `${packageName}@${version}`;
  return version === "latest" ? packageName : `${packageName}==${version}`;
}

export interface RegistryPackageInput {
  appName: string;
  ecosystem: "npm" | "pip";
  packageName: string;
  version: string;
  command?: string;
  args?: string[];
  config?: Array<{ key: string; secret?: boolean; description?: string; env?: string }>;
}

export function buildRegistryPackage(input: RegistryPackageInput): ValidatedPackage {
  const name = assertAppName(input.appName);
  const spec = registrySpec(input.ecosystem, input.packageName, input.version);
  const command = assertRequestedCommand(input.command);
  const args = input.args ?? [];
  if (args.some((arg) => arg.includes("\0") || /\$\{(?!PLUGIN_ROOT\}|PLUGIN_DATA\})/.test(arg))) {
    throw new PackageCommandError("启动参数不合法");
  }
  const server: Record<string, unknown> = { type: "stdio", command: "./bin/mcp", cwd: "${PLUGIN_ROOT}" };
  if (args.length > 0) server.args = args;
  const extension: Record<string, unknown> = {
    setup: [{ type: input.ecosystem, packages: [spec], ...(input.ecosystem === "pip" ? { isolated: true } : {}) }, { type: "exec", argv: ["./bin/link.mjs"] }],
  };
  const declared = input.config ?? [];
  if (declared.length > 0) {
    extension.config = declared.map((item) => {
      if (!CONFIG_KEY.test(item.key)) throw new PackageCommandError("配置名不合法");
      return {
        key: item.key,
        ...(item.secret ? { secret: true } : {}),
        ...(item.description ? { description: item.description } : {}),
        ...(item.env ? { env: item.env } : {}),
      };
    });
  }
  const specJson = {
    ecosystem: input.ecosystem,
    packageName: input.packageName,
    ...(command ? { command } : {}),
  };
  return validatePackage([
    { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name, version: input.version, description: "由 bot 安装的 MCP" })) },
    { path: "mcp.json", data: Buffer.from(JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { [name]: server } })) },
    { path: "ai.viate.bot/app.json", data: Buffer.from(JSON.stringify(extension)) },
    { path: "bin/spec.json", data: Buffer.from(JSON.stringify(specJson)) },
    { path: "bin/link.mjs", data: linkSource, executable: true },
  ]);
}

const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
]);

export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.toLowerCase());
}

export function headerConfigKey(name: string): string {
  const key = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!CONFIG_KEY.test(key)) throw new PackageCommandError("请求头名称不能作为配置项");
  return key;
}

export interface RemotePackageInput {
  appName: string;
  url: string;
  headers: Array<{ header: string; key: string; secret: boolean }>;
  config?: Array<{ key: string; secret: boolean }>;
}

export function buildRemotePackage(input: RemotePackageInput): ValidatedPackage {
  const name = assertAppName(input.appName);
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new PackageCommandError("远程 MCP 地址无效");
  }
  if (parsed.username || parsed.password || parsed.hash) throw new PackageCommandError("远程 MCP 地址无效");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new PackageCommandError("远程 MCP 只能由机器内发起，且非回环地址必须是 https");
  }
  const config = [
    ...input.headers.map((item) => ({
      key: item.key,
      secret: item.secret,
      header: item.header,
    })),
    ...(input.config ?? []).map((item) => ({
      key: item.key,
      ...(item.secret ? { secret: true } : {}),
    })),
  ];
  const extension = config.length > 0 ? { config } : {};
  return validatePackage([
    { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name, version: "1.0.0", description: "由 bot 安装的远程 MCP" })) },
    {
      path: "mcp.json",
      data: Buffer.from(JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: { [name]: { type: "streamable-http", url: input.url } },
      })),
    },
    { path: "ai.viate.bot/app.json", data: Buffer.from(JSON.stringify(extension)) },
  ]);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(match?.slice(1).every((part) => Number(part) <= 255));
}
