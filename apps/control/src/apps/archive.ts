import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseSkillMarkdown } from "@viate-bot/protocol";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { gunzipSync, inflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const LIMIT = 200 * 1024 * 1024;
const COUNT = 5000;
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");
const stringMap = (v: unknown): boolean => object(v) && Object.values(v).every(x => typeof x === "string");
const nameOk = (s: string) => s.length <= 64 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(s) && !s.includes("--") && !s.includes("..");
const supportedPlaceholders = (s: string) => !/\$\{(?!PLUGIN_ROOT\}|PLUGIN_DATA\})[^}]*\}/.test(s);

export interface PackageFile { path: string; data: Buffer; executable?: boolean }
export interface ValidatedPackage { name: string; manifest: Record<string, unknown>; extension: Record<string, unknown>; skills: string[]; servers: Record<string, unknown>; warnings: string[]; files: PackageFile[]; archive: Buffer; sha256: string }

export function readPackageFiles(archivePath: string, sha256: string): PackageFile[] {
  const bytes = readFileSync(archivePath);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("应用包校验失败");
  return readTar(bytes);
}

function safePath(path: string): string {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw new Error("Invalid archive path");
  const parts = path.split("/");
  if (parts.includes("..")) throw new Error("Archive path escapes root");
  const result = posix.normalize(path).replace(/^\.\//, "").replace(/\/$/, "");
  if (!result || result === ".") throw new Error("Invalid archive path");
  return result;
}

function checked(files: PackageFile[]): PackageFile[] {
  let total = 0;
  const names = new Set<string>();
  if (files.length > COUNT) throw new Error("Too many archive files");
  return files.map(file => {
    const path = safePath(file.path);
    if (names.has(path)) throw new Error("Duplicate archive path");
    names.add(path);
    total += file.data.length;
    if (total > LIMIT) throw new Error("Archive too large");
    return { ...file, path };
  });
}

function octal(buf: Buffer): number {
  const text = buf.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("Invalid tar number");
  const n = text ? parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(n)) throw new Error("Invalid tar number");
  return n;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paxFields(bytes: Buffer): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error("Invalid tar metadata");
    const digits = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(digits)) throw new Error("Invalid tar metadata");
    const end = offset + Number(digits);
    if (!Number.isSafeInteger(end) || end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) throw new Error("Invalid tar metadata");
    const entry = bytes.subarray(space + 1, end - 1).toString("utf8"), separator = entry.indexOf("=");
    if (separator < 1) throw new Error("Invalid tar metadata");
    result[entry.slice(0, separator)] = entry.slice(separator + 1);
    offset = end;
  }
  return result;
}

export function readTar(input: Buffer): PackageFile[] {
  if (input.length > LIMIT) throw new Error("Archive too large");
  if (input.length < 4) throw new Error("Invalid tar");
  const data = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input, { maxOutputLength: LIMIT + COUNT * 1024 }) : input.readUInt32LE(0) === 0xfd2fb528 ? zstdDecompressSync(input, { maxOutputLength: LIMIT + COUNT * 1024 }) : input;
  const files: PackageFile[] = [];
  let at = 0, entries = 0;
  let pending: Record<string, string> | undefined;
  while (at + 512 <= data.length) {
    const h = data.subarray(at, at + 512); at += 512;
    if (h.every(x => x === 0)) break;
    const expected = octal(h.subarray(148, 156));
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== expected) throw new Error("Invalid tar checksum");
    const text = (b: Buffer) => b.toString("utf8").replace(/\0.*$/, "");
    let path = [text(h.subarray(345, 500)), text(h.subarray(0, 100))].filter(Boolean).join("/");
    if (++entries > COUNT) throw new Error("Too many archive entries");
    let size = octal(h.subarray(124, 136));
    const type = h[156];
    if (size > LIMIT || at + size > data.length) throw new Error("Invalid tar size");
    if (type === 120 || type === 103) {
      if (size > 1024 * 1024 || pending) throw new Error("Invalid tar metadata");
      const fields = paxFields(data.subarray(at, at + size));
      if ("linkpath" in fields || "GNU.sparse.map" in fields || "GNU.sparse.size" in fields) throw new Error("Unsupported tar metadata");
      if (type === 103) { if ("path" in fields || "size" in fields) throw new Error("Unsupported global tar metadata"); }
      else pending = fields;
      at += Math.ceil(size / 512) * 512;
      continue;
    }
    if (pending) {
      path = pending.path ?? path;
      if (pending.size !== undefined) { if (!/^(?:0|[1-9][0-9]*)$/.test(pending.size)) throw new Error("Invalid tar size"); size = Number(pending.size); }
      pending = undefined;
      if (!Number.isSafeInteger(size) || size > LIMIT || at + size > data.length) throw new Error("Invalid tar size");
    }
    if ((path === "." || path === "./") && type === 53 && size === 0) continue;
    safePath(path);
    if (type === 0 || type === 48) files.push({ path, data: Buffer.from(data.subarray(at, at + size)), executable: !!(octal(h.subarray(100, 108)) & 0o111) });
    else if (type !== 53) throw new Error("Unsupported tar entry");
    if (files.length > COUNT) throw new Error("Too many archive files");
    at += Math.ceil(size / 512) * 512;
  }
  if (at > data.length) throw new Error("Truncated tar");
  return checked(files);
}

export function readZip(data: Buffer): PackageFile[] {
  if (data.length > LIMIT) throw new Error("Archive too large");
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { eocd = i; break; }
  if (eocd < 0 || data.readUInt16LE(eocd + 4) || data.readUInt16LE(eocd + 6)) throw new Error("Invalid zip");
  const count = data.readUInt16LE(eocd + 10), end = data.readUInt32LE(eocd + 16) + data.readUInt32LE(eocd + 12);
  if (count > COUNT || end > eocd || count !== data.readUInt16LE(eocd + 8)) throw new Error("Invalid zip directory");
  let at = data.readUInt32LE(eocd + 16), total = 0;
  const files: PackageFile[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) throw new Error("Invalid zip entry");
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), checksum = data.readUInt32LE(at + 16), compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24), nl = data.readUInt16LE(at + 28), el = data.readUInt16LE(at + 30), cl = data.readUInt16LE(at + 32), mode = data.readUInt32LE(at + 38) >>> 16, offset = data.readUInt32LE(at + 42);
    if (at + 46 + nl + el + cl > end || flags & 1 || (mode & 0o170000) === 0o120000) throw new Error("Invalid zip entry");
    const path = data.subarray(at + 46, at + 46 + nl).toString("utf8"); safePath(path);
    if ((mode & 0o170000) && ![0o100000, 0o040000].includes(mode & 0o170000)) throw new Error("Unsupported zip entry");
    at += 46 + nl + el + cl;
    if (path.endsWith("/")) continue;
    total += size; if (total > LIMIT || offset + 30 > data.length || data.readUInt32LE(offset) !== 0x04034b50) throw new Error("Invalid zip size");
    const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28);
    if (start + compressed > data.length) throw new Error("Truncated zip");
    const bytes = data.subarray(start, start + compressed);
    const content = method === 0 ? Buffer.from(bytes) : method === 8 ? inflateRawSync(bytes, { maxOutputLength: Math.min(LIMIT, size + 1) }) : (() => { throw new Error("Unsupported zip compression"); })();
    if (content.length !== size || crc32(content) !== checksum) throw new Error("Invalid zip content");
    files.push({ path, data: content, executable: !!(mode & 0o111) });
  }
  if (at !== end) throw new Error("Invalid zip directory");
  return checked(files);
}

function tar(files: PackageFile[]): Buffer {
  const chunks: Buffer[] = [];
  const field = (b: Buffer, value: number, start: number, length: number) => b.write(value.toString(8).padStart(length - 1, "0") + "\0", start, length, "ascii");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const h = Buffer.alloc(512); let name = file.path, prefix = "";
    if (Buffer.byteLength(name) > 100) { const split = name.lastIndexOf("/", name.length - 1); prefix = name.slice(0, split); name = name.slice(split + 1); }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155 || !name) throw new Error("Archive path too long");
    h.write(name, 0, 100); field(h, file.executable ? 0o755 : 0o644, 100, 8); field(h, 0, 108, 8); field(h, 0, 116, 8); field(h, file.data.length, 124, 12); field(h, 0, 136, 12); h.fill(32, 148, 156); h[156] = 48; h.write("ustar\0", 257, 6); h.write("00", 263, 2); h.write(prefix, 345, 155);
    field(h, h.reduce((n, x) => n + x, 0), 148, 8);
    chunks.push(h, file.data, Buffer.alloc((512 - file.data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024)); return Buffer.concat(chunks);
}

function canonical(v: unknown): string { return JSON.stringify(v, (_key, value) => object(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value); }
function parseJson(file: PackageFile | undefined): unknown { if (!file) return undefined; return JSON.parse(file.data.toString("utf8")); }

function validServer(v: unknown): boolean {
  if (!object(v)) return false;
  const keys = Object.keys(v);
  if (v.type === "stdio") {
    if (keys.some(k => !["type", "command", "args", "env", "cwd"].includes(k)) || typeof v.command !== "string" || v.command === "." || v.command === ".." || !/^(?:[a-zA-Z0-9_+.-]+|\.\/[^\s]+)$/.test(v.command)) return false;
    try { if (v.command.startsWith("./")) safePath(v.command); } catch { return false; }
    if (v.args !== undefined && !strings(v.args) || v.env !== undefined && (!stringMap(v.env) || "PLUGIN_ROOT" in (v.env as object) || "PLUGIN_DATA" in (v.env as object))) return false;
    if (v.args !== undefined && !(v.args as string[]).every(supportedPlaceholders) || v.env !== undefined && !Object.values(v.env as Record<string, string>).every(supportedPlaceholders)) return false;
    if (v.cwd !== undefined) { if (typeof v.cwd !== "string" || !/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/.test(v.cwd) || v.cwd.split("/").includes("..")) return false; }
    if (typeof v.cwd === "string" && !supportedPlaceholders(v.cwd)) return false;
    return true;
  }
  if (v.type !== "streamable-http" && v.type !== "sse" || keys.some(k => !["type", "url", "headers"].includes(k)) || typeof v.url !== "string") return false;
  try {
    if (/\$\{[^}]*\}/.test(v.url)) return false;
    const u = new URL(v.url); if (u.username || u.password || u.hash || !["http:", "https:"].includes(u.protocol) || u.protocol === "http:" && !(u.hostname === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(u.hostname) || u.hostname === "[::1]")) return false;
    if (v.headers !== undefined) { if (!stringMap(v.headers)) return false; const seen = new Set<string>(); for (const [k, value] of Object.entries(v.headers as Record<string, string>)) { const key = k.toLowerCase(); if (seen.has(key)) return false; seen.add(key); new Headers([[k, value]]); } }
    return true;
  } catch { return false; }
}

export function validatePackage(input: PackageFile[]): ValidatedPackage {
  const files = checked(input), find = (path: string) => files.find(f => f.path === path), warnings: string[] = [];
  const manifest = parseJson(find("plugin.json"));
  if (!object(manifest) || manifest.$schema !== PLUGIN_SCHEMA || typeof manifest.name !== "string" || !nameOk(manifest.name)) throw new Error("Invalid plugin manifest");
  const allowed = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
  for (const key of Object.keys(manifest)) if (!allowed.includes(key)) { warnings.push(`Unknown manifest field: ${key}`); delete manifest[key]; }
  for (const key of ["version", "description", "homepage", "repository", "license"]) if (manifest[key] !== undefined && typeof manifest[key] !== "string") throw new Error("Invalid manifest metadata");
  if (manifest.keywords !== undefined && !strings(manifest.keywords)) throw new Error("Invalid keywords");
  if (manifest.author !== undefined && (!object(manifest.author) || Object.keys(manifest.author).some(k => !["name", "email", "url"].includes(k)) || !stringMap(manifest.author))) throw new Error("Invalid author");
  if (manifest.extensions !== undefined && !object(manifest.extensions)) { warnings.push("Invalid extensions ignored"); delete manifest.extensions; }
  const embedded = object(manifest.extensions) ? manifest.extensions["ai.viate.bot"] : undefined, external = parseJson(find("ai.viate.bot/app.json"));
  if (embedded !== undefined && external !== undefined && canonical(embedded) !== canonical(external)) throw new Error("Conflicting extension");
  const extension = external ?? embedded ?? {}; if (!object(extension)) throw new Error("Invalid app extension");
  if (extension.bin !== undefined && typeof extension.bin !== "string" && !strings(extension.bin) && !stringMap(extension.bin)) throw new Error("Invalid app bin");
  if (extension.riskyTools !== undefined && !strings(extension.riskyTools)) throw new Error("Invalid risky tools");
  if (extension.routines !== undefined && !Array.isArray(extension.routines)) throw new Error("Invalid routines");
  if (extension.config !== undefined) {
    if (!Array.isArray(extension.config)) throw new Error("Invalid app configuration");
    const keys = new Set<string>();
    for (const item of extension.config) {
      if (!object(item) || typeof item.key !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.key) || keys.has(item.key) || item.secret !== undefined && typeof item.secret !== "boolean" || item.env !== undefined && (typeof item.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.env)) || item.header !== undefined && typeof item.header !== "string") throw new Error("Invalid app configuration");
      if (typeof item.header === "string") { try { new Headers([[item.header, "value"]]); } catch { throw new Error("Invalid app configuration header"); } }
      keys.add(item.key);
    }
  }
  if (extension.setup !== undefined) {
    if (!Array.isArray(extension.setup)) throw new Error("Invalid setup");
    for (const step of extension.setup) {
      if (!object(step) || typeof step.type !== "string") throw new Error("Invalid setup step");
      if (["apt", "npm", "pip"].includes(step.type)) { if (Object.keys(step).some(k => !["type", "packages", ...(step.type === "pip" ? ["isolated"] : [])].includes(k)) || step.isolated !== undefined && typeof step.isolated !== "boolean" || !strings(step.packages) || !step.packages.length || step.packages.some(p => !p || p.startsWith("-")) || step.type === "apt" && step.packages.some(p => !/^[a-z0-9][a-z0-9+.-]{0,63}$/.test(p))) throw new Error("Invalid setup packages"); }
      else if (step.type === "exec") { if (Object.keys(step).some(k => !["type", "argv"].includes(k)) || !strings(step.argv) || !step.argv.length || !step.argv[0] || step.argv.some(arg => arg.includes("\0")) || /^(?:sh|bash|sudo)$/.test(posix.basename(step.argv[0]))) throw new Error("Invalid setup command"); }
      else throw new Error("Invalid setup type");
    }
  }
  const skills: string[] = [];
  for (const f of files) { const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(f.path); if (!m?.[1]) continue; if (parseSkillMarkdown(m[1], f.data.toString("utf8"), f.data.length)) skills.push(m[1]); else warnings.push(`Invalid skill: ${m[1]}`); }
  let servers: Record<string, unknown> = {};
  if (find("mcp.json")) { try { const mcp = parseJson(find("mcp.json")); if (!object(mcp) || mcp.$schema !== MCP_SCHEMA || !object(mcp.mcpServers) || Object.keys(mcp).some(k => !["$schema", "mcpServers"].includes(k))) throw new Error(); for (const [name, value] of Object.entries(mcp.mcpServers)) if (validServer(value)) servers[name] = value; else warnings.push(`Invalid MCP server: ${name} (ValidationError)`); } catch { warnings.push("Invalid mcp.json"); servers = {}; } }
  if (files.some(f => /(?:^|\/)extensions\/.*\.ts$/.test(f.path))) warnings.push("Pi TypeScript extensions ignored");
  const archive = zstdCompressSync(tar(files));
  return { name: manifest.name, manifest, extension, skills, servers, warnings, files, archive, sha256: createHash("sha256").update(archive).digest("hex") };
}

export function wrapSkill(name: string, files: PackageFile[]): ValidatedPackage {
  if (!nameOk(name) || !files.some(f => f.path === "SKILL.md")) throw new Error("Invalid skill");
  return validatePackage([{ path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name })) }, ...checked(files).map(f => ({ ...f, path: `skills/${name}/${f.path}` }))]);
}

export function wrapMcpUrl(name: string, url: string): ValidatedPackage {
  if (!validServer({ type: "streamable-http", url })) throw new Error("Invalid MCP URL");
  return validatePackage([{ path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name })) }, { path: "mcp.json", data: Buffer.from(JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { [name]: { type: "streamable-http", url } } })) }]);
}

export function wrapMcpb(input: Buffer): ValidatedPackage {
  const files = readZip(input), manifest = parseJson(files.find(f => f.path === "manifest.json"));
  if (!object(manifest) || typeof manifest.name !== "string" || !nameOk(manifest.name) || typeof manifest.manifest_version !== "string" || typeof manifest.version !== "string" || typeof manifest.description !== "string" || !object(manifest.author) || typeof manifest.author.name !== "string" || !object(manifest.server) || !object(manifest.server.mcp_config)) throw new Error("Invalid MCPB manifest");
  const config = manifest.server.mcp_config;
  if (typeof config.command !== "string" || config.args !== undefined && !strings(config.args) || config.env !== undefined && !stringMap(config.env)) throw new Error("Invalid MCPB server");
  const convert = (v: string) => v.replaceAll("${__dirname}", "${PLUGIN_ROOT}");
  const declarations: Array<{ key: string; secret: boolean; env: string }> = [];
  const environment: Record<string, string> = {};
  for (const [env, value] of Object.entries((config.env ?? {}) as Record<string, string>)) {
    const reference = /^\$\{user_config\.([a-zA-Z0-9_]+)\}$/.exec(value);
    if (!reference) { environment[env] = convert(value); continue; }
    const configName = reference[1]!;
    const key = configName.toUpperCase();
    const item = object(manifest.user_config) ? manifest.user_config[configName] : undefined;
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || !object(item) || declarations.some(d => d.key === key)) throw new Error("Unsupported MCPB user configuration");
    declarations.push({ key, secret: item.sensitive === true, env });
  }
  const server = { type: "stdio", command: config.command, ...(config.args === undefined ? {} : { args: (config.args as string[]).map(convert) }), ...(Object.keys(environment).length ? { env: environment } : {}) };
  if (!validServer(server)) throw new Error("Invalid MCPB server");
  const extension = declarations.length ? { config: declarations } : {};
  const generated: PackageFile[] = [
    { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: manifest.name, version: manifest.version, description: manifest.description })) },
    { path: "mcp.json", data: Buffer.from(JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { [manifest.name]: server } })) },
    { path: "ai.viate.bot/app.json", data: Buffer.from(JSON.stringify(extension)) },
  ];
  if (files.some(f => generated.some(g => g.path === f.path))) throw new Error("MCPB conflicts with generated files");
  return validatePackage([...files, ...generated]);
}

export async function storePackage(dataDir: string, appId: string, version: string, pkg: ValidatedPackage): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(appId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version) || version.includes("..")) throw new Error("Invalid package identity");
  const dir = join(dataDir, "apps", appId); await mkdir(dir, { recursive: true }); const path = join(dir, `${version}.tar.zst`); await writeFile(path, pkg.archive, { flag: "wx", mode: 0o600 }); return path;
}
