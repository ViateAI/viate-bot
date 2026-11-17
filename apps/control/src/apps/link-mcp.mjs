#!/usr/bin/env node
/**
 * 安装步骤在机器上跑完 npm/pip 之后执行。
 * 从已安装包的 bin / console_scripts 推断启动命令，写成 ./bin/mcp。
 * 不访问 registry，不用 npx / uvx。
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN = new Set([
  "npx", "npm", "uvx", "uv", "pip", "pip3", "python", "python3", "node", "sh", "bash", "sudo", "busybox",
]);
const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export function normalizeDistribution(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export function unscopedName(packageName) {
  const slash = packageName.lastIndexOf("/");
  return slash >= 0 ? packageName.slice(slash + 1) : packageName;
}

/** 确定性规则。bins 是已安装包声明的可执行文件名。 */
export function inferLaunchBin(input) {
  const requested = typeof input.command === "string" ? input.command : "";
  const names = Object.keys(input.bins ?? {}).filter((name) => BIN_NAME.test(name) && !FORBIDDEN.has(name)).sort();
  if (requested) {
    if (!BIN_NAME.test(requested) || requested.includes("/") || FORBIDDEN.has(requested)) {
      return { error: "启动命令必须是已安装包里的可执行文件名，不能是 npx、uvx 或 shell" };
    }
    if (!names.includes(requested)) return { error: "包里没有这个可执行文件，请检查 command" };
    return { bin: requested };
  }
  if (names.length === 1) return { bin: names[0] };
  const unscoped = unscopedName(input.packageName);
  if (BIN_NAME.test(unscoped) && names.includes(unscoped)) return { bin: unscoped };
  if (names.length === 0) return { error: "这个包没有可执行文件，请在 install_mcp 里显式给出 command" };
  return { error: `无法从包的 bin 推断启动命令（候选：${names.join(", ")}），请在 install_mcp 里显式给出 command` };
}

export function npmBinMap(packageJson, packageName) {
  const bin = packageJson?.bin;
  const unscoped = unscopedName(packageName);
  if (typeof bin === "string" && bin.length > 0 && BIN_NAME.test(unscoped)) return { [unscoped]: bin };
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) return {};
  const map = {};
  for (const [name, path] of Object.entries(bin)) {
    if (typeof path === "string" && BIN_NAME.test(name) && !FORBIDDEN.has(name)) map[name] = path;
  }
  return map;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function npmPackageDir(dataDir, packageName) {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    if (!scope || !name) return undefined;
    return join(dataDir, "node_modules", scope, name);
  }
  return join(dataDir, "node_modules", packageName);
}

function metadataValue(text, field) {
  const match = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(text);
  return match?.[1]?.trim();
}

function consoleScripts(text) {
  const lines = text.split(/\r?\n/);
  let section = "";
  const bins = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = trimmed.slice(1, -1).trim().toLowerCase();
      continue;
    }
    if (section !== "console_scripts") continue;
    const split = trimmed.indexOf("=");
    if (split <= 0) continue;
    const name = trimmed.slice(0, split).trim();
    if (BIN_NAME.test(name) && !FORBIDDEN.has(name)) bins[name] = name;
  }
  return bins;
}

export function discoverInstalled(spec, env) {
  const dataDir = env.PLUGIN_DATA;
  if (spec.ecosystem === "npm") {
    if (!dataDir) return { error: "找不到安装目录" };
    const dir = npmPackageDir(dataDir, spec.packageName);
    if (!dir) return { error: "包名不合法" };
    let parsed;
    try {
      parsed = readJson(join(dir, "package.json"));
    } catch {
      return { error: "安装后没有找到包的 package.json" };
    }
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    return { version, bins: npmBinMap(parsed, spec.packageName) };
  }
  if (!dataDir) return { error: "找不到安装目录" };
  const wanted = normalizeDistribution(spec.packageName);
  const root = join(dataDir, "python", "lib");
  let version = "";
  let bins = {};
  let pythons = [];
  try {
    pythons = readdirSync(root);
  } catch {
    return { error: "安装后没有找到 pip 包" };
  }
  for (const python of pythons) {
    const site = join(root, python, "site-packages");
    let entries = [];
    try {
      entries = readdirSync(site);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".dist-info")) continue;
      let meta = "";
      try {
        meta = readFileSync(join(site, entry, "METADATA"), "utf8");
      } catch {
        continue;
      }
      const name = metadataValue(meta, "Name");
      if (!name || normalizeDistribution(name) !== wanted) continue;
      version = metadataValue(meta, "Version") ?? "";
      try {
        bins = consoleScripts(readFileSync(join(site, entry, "entry_points.txt"), "utf8"));
      } catch {
        bins = {};
      }
    }
  }
  if (!version && Object.keys(bins).length === 0) return { error: "安装后没有找到 pip 包" };
  return { version, bins };
}

function shim(bin, ecosystem) {
  const target = ecosystem === "pip"
    ? "join(process.env.PLUGIN_DATA || \"\", \"python\", \"bin\", bin)"
    : "join(process.env.PLUGIN_DATA || \"\", \"node_modules\", \".bin\", bin)";
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
const bin = ${JSON.stringify(bin)};
const target = ${target};
const env = ${ecosystem === "pip" ? '{ ...process.env, PYTHONUSERBASE: join(process.env.PLUGIN_DATA || "", "python") }' : "process.env"};
const child = spawn(target, process.argv.slice(2), { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
child.on("error", () => process.exit(1));
`;
}

export function linkInstalled(spec, env, root) {
  const found = discoverInstalled(spec, env);
  if (found.error) return found;
  const picked = inferLaunchBin({ packageName: spec.packageName, command: spec.command, bins: found.bins });
  if (picked.error) return picked;
  const version = found.version.trim();
  if (!version || version.length > 64 || /[\r\n\0]/.test(version)) return { error: "没有读到实际版本" };
  const dataDir = env.PLUGIN_DATA;
  if (!dataDir) return { error: "找不到安装目录" };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "resolved-version"), `${version}\n`, { mode: 0o644 });
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const mcp = join(binDir, "mcp");
  writeFileSync(mcp, shim(picked.bin, spec.ecosystem), { mode: 0o755 });
  chmodSync(mcp, 0o755);
  return { bin: picked.bin, version };
}

function main() {
  const spec = readJson(join(dirname(fileURLToPath(import.meta.url)), "spec.json"));
  const root = process.env.PLUGIN_ROOT;
  if (!root) {
    process.stderr.write("找不到安装目录\n");
    process.exit(1);
  }
  const linked = linkInstalled(spec, process.env, root);
  if (linked.error) {
    process.stderr.write(`${linked.error}\n`);
    process.exit(1);
  }
}

const invoked = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invoked) main();
