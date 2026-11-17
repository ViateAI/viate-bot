/**
 * 机器侧应用安装。布局是 /home/bot/.viate/apps/<name>/versions/<key>、current、data 和 .viate/bin。
 * 安装步骤只按 argv 执行，不经过 shell。失败时恢复 current 和属于本应用的 bin 链接，并删除未完成的新版本目录。data 保留。
 * apt 装上的系统包不会卸载。root 只跑受包名校验的 apt-get；npm、pip 和用户脚本在 root 时降到 bot。
 * 技能的 allowed-tools 不产生任何授权。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { delimiter, dirname, join, posix, sep } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  parseSkillMarkdown,
  type AppInstallResponse,
  type AppRoutineTemplate,
  type AppListEntry,
  type AppListResponse,
  type McpStartResponse,
  type SkillListEntry,
  type SkillListResponse,
  type SkillReadResponse,
} from "@viate-bot/protocol";
import type { McpHost } from "./mcp-host.js";
import { killProcessGroup } from "./process-group.js";

export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const ARCHIVE_BYTE_LIMIT = 200 * 1024 * 1024;
export const ARCHIVE_FILE_LIMIT = 5000;
export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
export const SKILL_BYTE_LIMIT = 64 * 1024;
export const SKILL_DESCRIPTION_BUDGET = 8 * 1024;
const MANIFEST_FIELDS = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,63}$/;
const SHELL_NAME = /^(?:sh|bash|sudo)$/;

export class AppError extends Error {
  readonly statusCode: number;
  constructor(message: string, readonly code: "invalid" | "setup" | "timeout") {
    super(message);
    this.name = "AppError";
    this.statusCode = code === "invalid" ? 400 : 422;
  }
}

export interface ArchiveFile {
  path: string;
  data: Buffer;
  executable?: boolean;
}

export interface PackedArchive {
  archive: Buffer;
  sha256: string;
  bytes: number;
}

export interface InstallRequest {
  name: string;
  version: string;
  sha256: string;
  archive: Buffer;
}

export interface InstallResult {
  name: string;
  version: string;
  state: "installed";
  sha256: string;
  warnings: string[];
  root: string;
  dataDir: string;
  bins: string[];
  riskyTools: string[];
  routines: AppRoutineTemplate[];
}

export interface AppInspection {
  name: string;
  version: string;
  sha256: string;
  warnings: string[];
  skills: SkillListEntry[];
  mcpServers: string[];
  bins: string[];
  riskyTools: string[];
  routines: unknown[];
}

export type SetupStep =
  | { type: "apt"; packages: string[] }
  | { type: "npm"; packages: string[] }
  | { type: "pip"; packages: string[] }
  | { type: "exec"; argv: string[] };

export interface SetupContext {
  root: string;
  dataDir: string;
  homeDir: string;
  timeoutMs: number;
  env: Record<string, string>;
}

export interface AppRuntimeOptions {
  homeDir?: string;
  setupTimeoutMs?: number;
  botUid?: number;
  botGid?: number;
  /** 测试替换实际执行。校验仍然先于这个函数。 */
  runSetup?: (step: SetupStep, context: SetupContext) => Promise<void>;
}

export interface AppRouteOptions {
  mcp?: McpHost;
}

export interface AppRuntime {
  install(request: InstallRequest): Promise<InstallResult>;
  uninstall(name: string, options?: { purge?: boolean }): Promise<{ name: string; state: "absent" }>;
  listApps(): Promise<AppListEntry[]>;
  listSkills(): Promise<SkillListResponse>;
  readSkill(name: string): Promise<SkillReadResponse>;
  saveSkill(input: { name: string; content: string; secrets?: readonly string[] }): Promise<{ name: string; path: string }>;
  /**
   * env 与 headers 必须已是 catalog resolveMcpLaunch 的结果。
   * stdio 只使用 env，并且不再展开其中的 ${...}。
   * HTTP/SSE 把 headers 注入初始 origin；跨源跳转丢掉 Authorization 和这些头。
   */
  launchMcp(
    host: McpHost,
    appName: string,
    serverName: string,
    env?: Record<string, string>,
    headers?: Record<string, string>,
    owner?: string,
  ): Promise<McpStartResponse>;
  inspect(name: string): Promise<AppInspection>;
}

interface LoadedPackage {
  warnings: string[];
  steps: SetupStep[];
  skills: { name: string; description: string }[];
  servers: Map<string, McpEntry>;
  bins: { name: string; path: string }[];
  riskyTools: string[];
  routines: AppRoutineTemplate[];
  config: ConfigDeclaration[];
}

export interface ConfigDeclaration {
  key: string;
  secret: boolean;
  env?: string;
  header?: string;
}

type McpEntry =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "streamable-http" | "sse"; url: string; headers?: Record<string, string> };

interface SkillFound {
  id: string;
  name: string;
  description: string;
  file: string;
}

export function viateLayout(homeDir: string): { apps: string; bin: string; skills: string } {
  const root = join(homeDir, ".viate");
  return { apps: join(root, "apps"), bin: join(root, "bin"), skills: join(root, "skills") };
}

/** 会话身份是应用目录、声明的 server、安装版本和这次生效的配置，不是显示名。 */
export function mcpConfigDigest(env?: Record<string, string>, headers?: Record<string, string>): string {
  const canon = (record: Record<string, string> | undefined) => Object.keys(record ?? {}).sort().map((key) => `${key}=${record?.[key] ?? ""}`).join("\n");
  return createHash("sha256").update(canon(env)).update("\0").update(canon(headers)).digest("hex");
}

export function mcpSessionKey(input: { appName: string; serverName: string; version: string; configDigest: string }): string {
  return createHash("sha256")
    .update(input.appName).update("\0")
    .update(input.serverName).update("\0")
    .update(input.version).update("\0")
    .update(input.configDigest)
    .digest("hex").slice(0, 32);
}

/** 同一安装身份下，不同任务各有一个进程。owner 只参与键，不写进日志。 */
export function mcpOwnerKey(sessionKey: string, owner: string): string {
  return createHash("sha256").update(sessionKey).update("\0").update(owner).digest("hex").slice(0, 32);
}

export function maskSecrets(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort((a, b) => b.length - a.length);
  let masked = text;
  for (const secret of unique) masked = masked.split(secret).join("\u2022\u2022\u2022\u2022");
  return masked;
}

export function packAppArchive(files: readonly ArchiveFile[]): PackedArchive {
  const archive = Buffer.from(zstdCompressSync(writeTar(checkFiles(files))));
  const sha256 = createHash("sha256").update(archive).digest("hex");
  return { archive, sha256, bytes: archive.length };
}

export function createAppRuntime(options: AppRuntimeOptions = {}): AppRuntime {
  const homeDir = options.homeDir ?? "/home/bot";
  const layout = viateLayout(homeDir);
  const timeoutMs = options.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
  const lock = createLock();
  const identity = botIdentity(options);

  const appDir = (name: string): string => {
    assertAppName(name);
    return join(layout.apps, name);
  };

  async function install(request: InstallRequest): Promise<InstallResult> {
    assertAppName(request.name);
    assertVersion(request.version);
    if (!/^[a-f0-9]{64}$/i.test(request.sha256)) throw new AppError("\u5f52\u6863\u6821\u9a8c\u5931\u8d25", "invalid");
    if (request.archive.length > ARCHIVE_BYTE_LIMIT) throw new AppError("\u5f52\u6863\u8d85\u8fc7 200MB", "invalid");
    if (!sameHash(createHash("sha256").update(request.archive).digest("hex"), request.sha256.toLowerCase())) {
      throw new AppError("\u5f52\u6863\u6821\u9a8c\u5931\u8d25", "invalid");
    }
    const files = readArchive(request.archive);
    const loaded = interpret(files);
    const manifest = readManifest(files);
    if (manifest.name !== request.name) throw new AppError("\u63d2\u4ef6\u540d\u79f0\u4e0d\u5339\u914d", "invalid");
    return lock(request.name, async () => {
      await mkdir(layout.apps, { recursive: true });
      await mkdir(layout.bin, { recursive: true });
      const dir = appDir(request.name);
      const dataDir = join(dir, "data");
      const versions = join(dir, "versions");
      const storageKey = createHash("sha256").update(request.version).digest("hex");
      const incoming = join(versions, `.incoming-${storageKey}`);
      await mkdir(dataDir, { recursive: true });
      await mkdir(versions, { recursive: true });
      await rm(incoming, { recursive: true, force: true });
      await mkdir(incoming, { recursive: true });
      let promoted = false;
      let replaced = false;
      const previous = join(versions, `.previous-${storageKey}`);
      const destination = join(versions, storageKey);
      const current = join(dir, "current");
      const oldCurrent = await readlink(current).catch(() => undefined);
      const oldBins = await previousBins(dir);
      const binSnapshots = new Map<string, string | undefined>();
      try {
        await writeTree(incoming, files, runnablePaths(loaded));
        if (identity.uid !== undefined && identity.gid !== undefined) {
          if (!(await lstat(dataDir)).isDirectory()) throw new AppError("数据目录无效", "invalid");
          await chown(dataDir, identity.uid, identity.gid);
          await chownTree(incoming, identity.uid, identity.gid);
        }
        const context: SetupContext = {
          root: incoming,
          dataDir,
          homeDir,
          timeoutMs,
          env: baseEnv(homeDir, layout.bin, incoming, dataDir),
        };
        for (const step of loaded.steps) {
          if (options.runSetup) await options.runSetup(step, context);
          else await runSetupStep(step, context, identity);
        }
        for (const name of new Set([...oldBins, ...loaded.bins.map((bin) => bin.name)])) {
          const path = join(layout.bin, name);
          const info = await lstat(path).catch(() => undefined);
          if (info && !info.isSymbolicLink()) throw new AppError("bin 名称已被占用", "invalid");
          const target = info ? await readlink(path) : undefined;
          if (target && !target.startsWith(`../apps/${request.name}/`)) throw new AppError("bin 名称已被占用", "invalid");
          binSnapshots.set(name, target);
        }
        await rm(previous, { recursive: true, force: true });
        try {
          await rename(destination, previous);
          replaced = true;
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
        await rename(incoming, destination);
        promoted = true;
        await replaceSymlink(`versions/${storageKey}`, current);
        await linkBins(layout.bin, request.name, loaded.bins, oldBins);
        const stateTemp = join(dir, `.install-${process.pid}.tmp`);
        await writeNoFollow(stateTemp, JSON.stringify({
          name: request.name,
          version: request.version,
          storageKey,
          sha256: request.sha256.toLowerCase(),
          bins: loaded.bins.map((bin) => bin.name),
        }), 0o644);
        await rename(stateTemp, join(dir, "install.json"));
      } catch (error) {
        if (promoted) {
          if (oldCurrent !== undefined) await replaceSymlink(oldCurrent, current);
          else await unlink(current).catch(() => undefined);
          for (const [name, target] of binSnapshots) {
            const path = join(layout.bin, name);
            await unlink(path).catch(() => undefined);
            if (target !== undefined) await symlink(target, path);
          }
          await rm(destination, { recursive: true, force: true });
        }
        if (replaced) await rename(previous, destination);
        await rm(incoming, { recursive: true, force: true });
        await rm(join(dir, `.install-${process.pid}.tmp`), { force: true });
        if (error instanceof AppError) throw error;
        throw new AppError("\u5b89\u88c5\u5931\u8d25", "setup");
      }
      if (replaced) await rm(previous, { recursive: true, force: true });
      const root = await realpath(destination);
      return {
        name: request.name,
        version: request.version,
        state: "installed",
        sha256: request.sha256.toLowerCase(),
        warnings: loaded.warnings,
        root,
        dataDir,
        bins: loaded.bins.map((bin) => bin.name),
        riskyTools: loaded.riskyTools,
        routines: loaded.routines,
      };
    });
  }

  async function uninstall(name: string, uninstallOptions?: { purge?: boolean }): Promise<{ name: string; state: "absent" }> {
    assertAppName(name);
    return lock(name, async () => {
      const dir = appDir(name);
      const bins = await previousBins(dir);
      await removeOwnedBins(layout.bin, dir, bins);
      const entries = await readdir(dir).catch(() => [] as string[]);
      for (const entry of entries) {
        if (entry === "data" && !uninstallOptions?.purge) continue;
        await rm(join(dir, entry), { recursive: true, force: true });
      }
      if (uninstallOptions?.purge) await rm(dir, { recursive: true, force: true });
      return { name, state: "absent" };
    });
  }

  async function listApps(): Promise<AppListEntry[]> {
    const names = await readdir(layout.apps).catch(() => [] as string[]);
    const apps: AppListEntry[] = [];
    for (const name of names.sort()) {
      if (!isAppName(name)) continue;
      const dir = join(layout.apps, name);
      const link = await readlink(join(dir, "current")).catch(() => "");
      const state = await readState(dir);
      if (validCurrentLink(link) && state && isVersion(state.version)) apps.push({ name, version: state.version, state: "installed" });
      else apps.push({ name, version: null, state: "absent" });
    }
    return apps;
  }

  async function discover(): Promise<SkillFound[]> {
    const found: SkillFound[] = [];
    await collectDirSkills(layout.skills, "user", found);
    const apps = await listApps();
    for (const app of apps) {
      if (app.state !== "installed" || !app.version) continue;
      await collectDirSkills(join(layout.apps, app.name, "current", "skills"), app.name, found);
    }
    const groups = new Map<string, SkillFound[]>();
    for (const skill of found) {
      const list = groups.get(skill.name) ?? [];
      list.push(skill);
      groups.set(skill.name, list);
    }
    const named: SkillFound[] = [];
    for (const [name, list] of groups) {
      const only = list[0];
      if (list.length === 1 && only) named.push({ ...only, id: name });
      else for (const skill of list) named.push({ ...skill, id: `${skill.id}/${name}` });
    }
    named.sort((a, b) => a.id.localeCompare(b.id));
    return named;
  }

  async function listSkills(): Promise<SkillListResponse> {
    const skills = capDescriptions((await discover()).map((skill) => ({ name: skill.id, description: skill.description })));
    const response: SkillListResponse = { skills };
    return response;
  }

  async function readSkill(name: string): Promise<SkillReadResponse> {
    const skill = (await discover()).find((item) => item.id === name);
    if (!skill) throw new AppError("\u6280\u80fd\u4e0d\u5b58\u5728", "invalid");
    const info = await lstat(skill.file);
    if (!info.isFile()) throw new AppError("\u6280\u80fd\u4e0d\u5b58\u5728", "invalid");
    const take = Math.min(info.size, SKILL_BYTE_LIMIT);
    const data = await readNoFollow(skill.file, take);
    return { name, content: data.toString("utf8"), truncated: info.size > SKILL_BYTE_LIMIT };
  }

  async function saveSkill(input: { name: string; content: string; secrets?: readonly string[] }): Promise<{ name: string; path: string }> {
    if (!isSkillName(input.name)) throw new AppError("\u6280\u80fd\u540d\u79f0\u65e0\u6548", "invalid");
    const masked = maskSecrets(input.content, input.secrets ?? []);
    if ((input.secrets ?? []).some((secret) => secret.length > 0 && masked.includes(secret))) {
      throw new AppError("\u6280\u80fd\u5185\u5bb9\u4ecd\u5305\u542b配置值", "invalid");
    }
    if (Buffer.byteLength(masked) > SKILL_BYTE_LIMIT) throw new AppError("\u6280\u80fd\u8d85\u8fc7 64KB", "invalid");
    const parsed = parseSkill(input.name, masked);
    if (!parsed) throw new AppError("\u6280\u80fd\u4e0d合规", "invalid");
    return lock(`skill:${input.name}`, async () => {
      await mkdir(layout.skills, { recursive: true });
      const dir = join(layout.skills, input.name);
      const rootReal = await realpath(layout.skills);
      const existing = await lstat(dir).catch(() => undefined);
      if (existing?.isSymbolicLink()) throw new AppError("\u6280\u80fd路径无效", "invalid");
      await mkdir(dir, { recursive: true });
      const real = await realpath(dir);
      if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) throw new AppError("\u6280\u80fd路径越界", "invalid");
      const path = join(dir, "SKILL.md");
      const link = await lstat(path).catch(() => undefined);
      if (link?.isSymbolicLink()) await unlink(path);
      await writeNoFollow(path, masked, 0o644);
      return { name: input.name, path };
    });
  }

  async function currentRoot(name: string): Promise<string> {
    assertAppName(name);
    const dir = appDir(name);
    const link = await readlink(join(dir, "current")).catch(() => "");
    if (!validCurrentLink(link)) throw new AppError("\u5e94\u7528\u672a\u5b89\u88c5", "invalid");
    const root = join(dir, link);
    const [appReal, rootReal] = await Promise.all([realpath(dir), realpath(root)]);
    if (rootReal !== appReal && !rootReal.startsWith(`${appReal}${sep}`)) throw new AppError("\u5e94\u7528路径越界", "invalid");
    return rootReal;
  }

  async function launchMcp(
    host: McpHost,
    appName: string,
    serverName: string,
    env?: Record<string, string>,
    headers?: Record<string, string>,
    owner?: string,
  ): Promise<McpStartResponse> {
    const root = await currentRoot(appName);
    const dataDir = join(appDir(appName), "data");
    const loaded = interpret(await snapshotFiles(root), false);
    const entry = loaded.servers.get(serverName);
    if (!entry) throw new AppError("MCP \u4e0d\u5b58\u5728", "invalid");
    const state = await readState(appDir(appName));
    const sessionKey = mcpSessionKey({
      appName,
      serverName,
      version: state?.version ?? "",
      configDigest: mcpConfigDigest(env, headers),
    });
    const processKey = owner ? mcpOwnerKey(sessionKey, owner) : sessionKey;
    if (entry.type === "stdio") {
      const command = entry.command;
      const args = (entry.args ?? []).map((arg) => expandPlaceholders(arg, root, dataDir));
      const cwd = entry.cwd ? await resolveCwd(entry.cwd, root, dataDir) : root;
      const merged: Record<string, string> = {
        ...baseEnv(homeDir, layout.bin, root, dataDir),
        ...expandEnv(entry.env, root, dataDir),
        ...sealedRecord(env),
      };
      const executable = command.startsWith("./") ? await resolveInside(root, command.slice(2)) : command;
      return host.startStdio(processKey, {
        command: executable,
        args,
        cwd,
        env: merged,
        pluginRoot: root,
        pluginData: dataDir,
      });
    }
    const injected = sealedRecord(headers);
    const mergedHeaders = { ...entry.headers, ...injected };
    const names = Object.keys(injected);
    return host.startRemote(processKey, {
      url: entry.url,
      ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
      ...(names.length > 0 ? { injectedHeaders: names } : {}),
      transport: entry.type,
    });
  }

  async function inspect(name: string): Promise<AppInspection> {
    const root = await currentRoot(name);
    const loaded = interpret(await snapshotFiles(root), false);
    const state = await readState(appDir(name));
    return {
      name,
      version: state?.version ?? "",
      sha256: state?.sha256 ?? "",
      warnings: loaded.warnings,
      skills: loaded.skills,
      mcpServers: [...loaded.servers.keys()],
      bins: loaded.bins.map((bin) => bin.name),
      riskyTools: loaded.riskyTools,
      routines: loaded.routines,
    };
  }

  return { install, uninstall, listApps, listSkills, readSkill, saveSkill, launchMcp, inspect };
}

export function registerAppRoutes(app: FastifyInstance, runtime: AppRuntime, options: AppRouteOptions = {}): void {
  try {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, payload, done) => {
      done(null, payload);
    });
  } catch {
    // server.ts 已把同一类型注册为流。
  }

  app.post("/apps/install", { bodyLimit: ARCHIVE_BYTE_LIMIT }, async (request): Promise<AppInstallResponse> => {
    const result = await runtime.install(await readInstallRequest(request));
    return { name: result.name, version: result.version, state: "installed", routines: result.routines };
  });

  app.get("/apps", async (): Promise<AppListResponse> => ({ apps: await runtime.listApps() }));

  app.post("/apps/uninstall", async (request) => {
    const body = asObject(request.body);
    if (typeof body.name !== "string") throw new AppError("\u7f3a\u5c11\u5e94\u7528\u540d\u79f0", "invalid");
    return runtime.uninstall(body.name, { purge: body.purge === true });
  });

  app.get("/skills", async () => runtime.listSkills());

  app.post("/skills/read", async (request) => {
    const body = asObject(request.body);
    if (typeof body.name !== "string") throw new AppError("\u7f3a\u5c11\u6280\u80fd\u540d\u79f0", "invalid");
    return runtime.readSkill(body.name);
  });

  app.post("/skills/save", async (request) => {
    const body = asObject(request.body);
    if (typeof body.name !== "string" || typeof body.content !== "string") throw new AppError("\u6280\u80fd\u5185\u5bb9\u65e0\u6548", "invalid");
    const secrets = body.secrets === undefined ? undefined : stringList(body.secrets, "\u914d\u7f6e\u503c\u65e0\u6548");
    return runtime.saveSkill({
      name: body.name,
      content: body.content,
      ...(secrets ? { secrets } : {}),
    });
  });

  app.get("/apps/:name", async (request) => {
    const name = routeParam(request.params, "name");
    return runtime.inspect(name);
  });

  app.post("/apps/:name/mcp/:server", async (request) => {
    if (!options.mcp) throw new AppError("MCP \u672a\u914d\u7f6e", "invalid");
    const name = routeParam(request.params, "name");
    const server = routeParam(request.params, "server");
    const body = request.body === undefined || request.body === null ? {} : asObject(request.body);
    const env = body.env === undefined ? undefined : stringRecord(body.env, "MCP \u73af\u5883\u65e0\u6548");
    const headers = body.headers === undefined ? undefined : stringRecord(body.headers, "\u914d\u7f6e\u503c\u65e0\u6548");
    const owner = typeof body.owner === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.owner) ? body.owner : undefined;
    return runtime.launchMcp(options.mcp, name, server, env, headers, owner);
  });
}

function createLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    tails.set(key, run.then(() => undefined, () => undefined));
    return run;
  };
}

function botIdentity(options: AppRuntimeOptions): { uid?: number; gid?: number } {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return {};
  return { uid: options.botUid ?? 1000, gid: options.botGid ?? 1000 };
}

function baseEnv(homeDir: string, binDir: string, root: string, dataDir: string): Record<string, string> {
  return {
    PATH: `${binDir}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: homeDir,
    USER: "bot",
    LOGNAME: "bot",
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    PLUGIN_ROOT: root,
    PLUGIN_DATA: dataDir,
  };
}

/** apt 保持当前进程身份。其余步骤在 root 上才降到 bot。失败后不执行 apt-get remove。 */
export function setupSpawnIdentity(step: { type: string }, identity: { uid?: number; gid?: number }): { uid?: number; gid?: number } {
  if (step.type === "apt") return {};
  return identity;
}

export function setupCommand(step: Extract<SetupStep, { type: "apt" }>, context: SetupContext, identity: { uid?: number; gid?: number }): { command: string; args: string[]; options: RunOptions } {
  return {
    command: "/usr/bin/apt-get",
    args: ["install", "-y", "--no-install-recommends", ...step.packages],
    options: {
      cwd: "/",
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", DEBIAN_FRONTEND: "noninteractive", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      timeoutMs: context.timeoutMs,
      ...userIds(setupSpawnIdentity(step, identity)),
    },
  };
}

async function runSetupStep(step: SetupStep, context: SetupContext, identity: { uid?: number; gid?: number }): Promise<void> {
  const owner = userIds(setupSpawnIdentity(step, identity));
  if (step.type === "apt") {
    const { command, args, options } = setupCommand(step, context, identity);
    await runProcess(command, args, options);
    return;
  }
  if (step.type === "npm") {
    await runProcess("npm", ["install", "--prefix", context.dataDir, ...step.packages], {
      cwd: context.dataDir,
      env: {
        ...context.env,
        npm_config_cache: join(context.dataDir, ".npm-cache"),
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_AUDIT: "false",
      },
      timeoutMs: context.timeoutMs,
      ...owner,
    });
    return;
  }
  if (step.type === "pip") {
    await runProcess("python3", ["-m", "pip", "install", "--user", "--no-input", ...step.packages], {
      cwd: context.dataDir,
      env: {
        ...context.env,
        PIP_CACHE_DIR: join(context.dataDir, ".pip-cache"),
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
      },
      timeoutMs: context.timeoutMs,
      ...owner,
    });
    return;
  }
  const [command, ...args] = step.argv;
  if (!command) throw new AppError("\u5b89\u88c5\u547d\u4ee4\u65e0\u6548", "invalid");
  const resolved = await resolveCommand(command, context.root);
  await runProcess(resolved, args, {
    cwd: context.root,
    env: context.env,
    timeoutMs: context.timeoutMs,
    ...owner,
  });
}

function userIds(identity: { uid?: number; gid?: number }): { uid: number; gid: number } | Record<string, never> {
  if (identity.uid === undefined || identity.gid === undefined) return {};
  return { uid: identity.uid, gid: identity.gid };
}

interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  uid?: number;
  gid?: number;
}

function runProcess(command: string, args: string[], options: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: AppError | undefined;
    const finish = (error?: AppError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.uid !== undefined && options.gid !== undefined ? { uid: options.uid, gid: options.gid } : {}),
      });
    } catch {
      finish(new AppError("\u5b89\u88c5\u6b65\u9aa4\u5931\u8d25", "setup"));
      return;
    }
    child.stdout?.resume();
    child.stderr?.resume();
    timer = setTimeout(() => {
      failure = new AppError("\u5b89\u88c5\u6b65\u9aa4\u8d85\u65f6", "timeout");
      void killProcessGroup(child.pid).catch(() => finish(new AppError("安装进程停止未确认", "setup")));
    }, options.timeoutMs);
    child.once("error", () => {
      finish(new AppError("\u5b89\u88c5\u6b65\u9aa4\u5931\u8d25", "setup"));
    });
    child.once("close", (code) => {
      if (failure) finish(failure);
      else if (code === 0) finish();
      else finish(new AppError("\u5b89\u88c5\u6b65\u9aa4\u5931\u8d25", "setup"));
    });
  });
}

async function resolveCommand(command: string, root: string): Promise<string> {
  if (SHELL_NAME.test(posix.basename(command))) throw new AppError("\u5b89\u88c5\u547d\u4ee4\u4e0d\u80fd\u662f shell", "invalid");
  if (!command.includes("/")) return command;
  if (command.startsWith("/")) {
    if (command.split("/").includes("..")) throw new AppError("\u5b89\u88c5\u547d\u4ee4\u65e0\u6548", "invalid");
    return command;
  }
  const relative = command.startsWith("./") ? command.slice(2) : command;
  return resolveInside(root, relative);
}

async function resolveInside(root: string, relative: string): Promise<string> {
  if (!relative || relative.split("/").includes("..") || relative.startsWith("/")) throw new AppError("\u5b89\u88c5\u547d\u4ee4\u8d8a\u754c", "invalid");
  const full = join(root, relative);
  const rootReal = await realpath(root);
  let real: string;
  try {
    real = await realpath(full);
  } catch {
    throw new AppError("\u5b89\u88c5\u547d\u4ee4\u4e0d\u5b58\u5728", "setup");
  }
  if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) throw new AppError("\u5b89\u88c5\u547d\u4ee4\u8d8a\u754c", "invalid");
  const info = await lstat(real);
  if (!info.isFile()) throw new AppError("\u5b89\u88c5\u547d\u4ee4\u65e0\u6548", "invalid");
  if ((info.mode & 0o111) === 0) await chmod(real, (info.mode & 0o777) | 0o755);
  return real;
}

function expandPlaceholders(value: string, root: string, dataDir: string): string {
  return value.replace(/\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g, (token) => (token === "${PLUGIN_ROOT}" ? root : dataDir));
}

function expandEnv(env: Record<string, string> | undefined, root: string, dataDir: string): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, expandPlaceholders(value, root, dataDir)]));
}

function sealedRecord(value: Record<string, string> | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.includes("\0") || item.includes("\0") || item.includes("\r") || item.includes("\n")) {
      throw new AppError("\u914d\u7f6e\u503c\u65e0\u6548", "invalid");
    }
    out[key] = item;
  }
  return out;
}

async function resolveCwd(cwd: string, root: string, dataDir: string): Promise<string> {
  const expanded = expandPlaceholders(cwd, root, dataDir);
  let base = root;
  let relative = expanded;
  if (expanded === root || expanded.startsWith(`${root}${sep}`) || expanded.startsWith(`${root}/`)) {
    base = root;
    relative = expanded.slice(root.length).replace(/^\/+/, "");
  } else if (expanded === dataDir || expanded.startsWith(`${dataDir}${sep}`) || expanded.startsWith(`${dataDir}/`)) {
    base = dataDir;
    relative = expanded.slice(dataDir.length).replace(/^\/+/, "");
  } else if (cwd.startsWith("./") || cwd.startsWith("${PLUGIN_ROOT}")) {
    base = root;
    relative = expanded.startsWith(root) ? expanded.slice(root.length).replace(/^\/+/, "") : expanded.replace(/^\.\//, "");
  } else {
    throw new AppError("MCP \u5de5\u4f5c\u76ee\u5f55\u65e0\u6548", "invalid");
  }
  if (relative.split("/").includes("..")) throw new AppError("MCP \u5de5\u4f5c\u76ee\u5f55\u8d8a\u754c", "invalid");
  const full = relative ? join(base, relative) : base;
  await mkdir(full, { recursive: true });
  const baseReal = await realpath(base);
  const real = await realpath(full);
  if (real !== baseReal && !real.startsWith(`${baseReal}${sep}`)) throw new AppError("MCP \u5de5\u4f5c\u76ee\u5f55\u8d8a\u754c", "invalid");
  return real;
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new AppError("安装目录包含符号链接", "invalid");
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await chownTree(join(path, entry), uid, gid);
  }
  await chown(path, uid, gid);
}

async function replaceSymlink(target: string, linkPath: string): Promise<void> {
  const temporary = `${linkPath}.tmp-${process.pid}`;
  await unlink(temporary).catch(() => undefined);
  await symlink(target, temporary);
  try {
    await rename(temporary, linkPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function linkBins(binDir: string, name: string, bins: { name: string; path: string }[], previous: string[]): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const next = new Set(bins.map((bin) => bin.name));
  for (const old of previous) {
    if (!next.has(old)) await unlinkOwnedBin(binDir, name, old);
  }
  for (const bin of bins) {
    const link = join(binDir, bin.name);
    const existing = await lstat(link).catch(() => undefined);
    if (existing?.isSymbolicLink()) await unlink(link);
    else if (existing) throw new AppError("bin \u540d\u79f0\u5df2\u88ab\u5360\u7528", "invalid");
    await symlink(join("..", "apps", name, "current", bin.path), link);
  }
}

async function unlinkOwnedBin(binDir: string, name: string, binName: string): Promise<void> {
  const link = join(binDir, binName);
  const info = await lstat(link).catch(() => undefined);
  if (!info?.isSymbolicLink()) return;
  const target = await readlink(link);
  if (!target.includes(`${sep}apps${sep}${name}${sep}`) && !target.includes(`/apps/${name}/`) && !target.startsWith(`../apps/${name}/`)) return;
  await unlink(link);
}

async function removeOwnedBins(binDir: string, dir: string, bins: string[]): Promise<void> {
  const name = dir.split(sep).at(-1) ?? "";
  for (const bin of bins) await unlinkOwnedBin(binDir, name, bin);
}

async function previousBins(dir: string): Promise<string[]> {
  return (await readState(dir))?.bins ?? [];
}

async function readState(dir: string): Promise<{ version: string; sha256: string; bins: string[] } | undefined> {
  const raw = await readRegular(join(dir, "install.json"), 64 * 1024);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || typeof parsed.version !== "string" || typeof parsed.sha256 !== "string" || !Array.isArray(parsed.bins)) return undefined;
  if (!parsed.bins.every((bin) => typeof bin === "string")) return undefined;
  return { version: parsed.version, sha256: parsed.sha256, bins: parsed.bins };
}

function runnablePaths(loaded: LoadedPackage): Set<string> {
  const paths = new Set<string>();
  const addCommand = (value: string): void => {
    if (!value.startsWith("./")) return;
    try {
      paths.add(safePath(value.slice(2)));
    } catch {
      // 没通过校验的相对路径不能变成可执行文件。
    }
  };
  for (const bin of loaded.bins) paths.add(bin.path);
  for (const step of loaded.steps) {
    if (step.type === "exec" && step.argv[0]) addCommand(step.argv[0]);
  }
  for (const server of loaded.servers.values()) {
    if (server.type === "stdio") addCommand(server.command);
  }
  return paths;
}

async function writeTree(root: string, files: ArchiveFile[], runnable: ReadonlySet<string>): Promise<void> {
  const rootReal = await realpath(root);
  for (const file of files) {
    const dest = join(root, file.path);
    const parent = dirname(dest);
    await mkdir(parent, { recursive: true });
    const parentReal = await realpath(parent);
    if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) throw new AppError("\u5f52\u6863\u8def\u5f84\u8d8a\u754c", "invalid");
    const existing = await lstat(dest).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new AppError("\u5f52\u6863\u8def\u5f84\u662f\u7b26\u53f7\u94fe\u63a5", "invalid");
    await writeNoFollow(dest, file.data, runnable.has(file.path) ? 0o755 : 0o644);
  }
}

async function writeNoFollow(path: string, data: Buffer | string, mode: number): Promise<void> {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes.subarray(offset));
      if (bytesWritten <= 0) throw new AppError("\u5199\u5165\u5931\u8d25", "invalid");
      offset += bytesWritten;
    }
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function readNoFollow(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const data = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(data, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === length ? data : data.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function snapshotFiles(root: string): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  for (const path of ["plugin.json", "ai.viate.bot/app.json", "mcp.json"]) {
    const data = await readRegular(join(root, path), 1024 * 1024);
    if (data) files.push({ path, data });
  }
  const skills = await readdir(join(root, "skills"), { withFileTypes: true }).catch(() => []);
  for (const entry of skills) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const rel = `skills/${entry.name}/SKILL.md`;
    const data = await readRegular(join(root, rel), SKILL_BYTE_LIMIT);
    if (data) files.push({ path: rel, data });
  }
  const tree = await walkFiles(root, "");
  for (const path of tree) {
    if (/(?:^|\/)extensions\/.*\.ts$/.test(path)) files.push({ path, data: Buffer.alloc(0) });
  }
  return files;
}

async function readRegular(path: string, max: number): Promise<Buffer | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  return readNoFollow(path, Math.min(info.size, max));
}

async function walkFiles(root: string, relative: string): Promise<string[]> {
  const dir = relative ? join(root, relative) : root;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...(await walkFiles(root, rel)));
    else if (entry.isFile()) paths.push(rel);
  }
  return paths;
}

async function collectDirSkills(dir: string, source: string, found: SkillFound[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (source !== "user" && info.size > SKILL_BYTE_LIMIT) continue;
    const data = await readNoFollow(file, Math.min(info.size, SKILL_BYTE_LIMIT)).catch(() => undefined);
    if (!data) continue;
    const parsed = parseSkill(entry.name, data.toString("utf8"));
    if (!parsed) continue;
    found.push({ id: source, name: parsed.name, description: parsed.description, file });
  }
}

function capDescriptions(skills: SkillListEntry[]): SkillListEntry[] {
  let used = 0;
  return skills.map((skill) => {
    const room = SKILL_DESCRIPTION_BUDGET - used;
    if (room <= 0) return { name: skill.name, description: "" };
    const description = clipUtf8(skill.description, room);
    used += Buffer.byteLength(description);
    return { name: skill.name, description };
  });
}

function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function interpret(files: ArchiveFile[], requireBinFiles = true): LoadedPackage {
  const warnings: string[] = [];
  const manifest = readManifest(files);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const external = parseJsonFile(byPath.get("ai.viate.bot/app.json"));
  let embedded = manifest.extensions?.["ai.viate.bot"];
  if (embedded !== undefined && !isObject(embedded)) throw new AppError("\u6269\u5c55\u65e0\u6548", "invalid");
  if (external !== undefined && !isObject(external)) throw new AppError("\u6269\u5c55\u65e0\u6548", "invalid");
  if (embedded !== undefined && external !== undefined && canonicalJson(embedded) !== canonicalJson(external)) {
    throw new AppError("\u6269\u5c55\u51b2\u7a81", "invalid");
  }
  const extension = external ?? embedded ?? {};
  if (!isObject(extension)) throw new AppError("\u6269\u5c55\u65e0\u6548", "invalid");
  const steps = parseSetup(extension.setup);
  const bins = parseBins(extension.bin, requireBinFiles ? byPath : undefined);
  let riskyTools: string[] = [];
  if (extension.riskyTools !== undefined) {
    if (!isStringArray(extension.riskyTools)) throw new AppError("riskyTools \u65e0\u6548", "invalid");
    riskyTools = extension.riskyTools;
  }
  const routines = parseRoutines(extension.routines, warnings);
  const config = parseConfig(extension.config);
  const skills: { name: string; description: string }[] = [];
  for (const file of files) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    if (!match?.[1]) continue;
    const parsed = file.data.length <= SKILL_BYTE_LIMIT ? parseSkill(match[1], file.data.toString("utf8")) : undefined;
    if (parsed) skills.push(parsed);
    else warnings.push(`\u6280\u80fd\u4e0d\u5408\u89c4\uff1a${match[1]}`);
  }
  const servers = new Map<string, McpEntry>();
  const mcpFile = byPath.get("mcp.json");
  if (mcpFile) {
    try {
      const mcp = parseJson(mcpFile.data.toString("utf8"));
      if (!isObject(mcp) || mcp.$schema !== MCP_SCHEMA || !isObject(mcp.mcpServers) || Object.keys(mcp).some((key) => key !== "$schema" && key !== "mcpServers")) {
        throw new AppError("mcp.json \u65e0\u6548", "invalid");
      }
      for (const [name, value] of Object.entries(mcp.mcpServers)) {
        const server = parseServer(value);
        if (server) servers.set(name, server);
        else warnings.push(`\u5df2\u8df3\u8fc7\u65e0\u6548 MCP\uff1a${name}`);
      }
    } catch (error) {
      if (error instanceof AppError && error.message === "mcp.json \u65e0\u6548") warnings.push("mcp.json \u65e0\u6548");
      else if (!(error instanceof AppError)) warnings.push("mcp.json \u65e0\u6548");
      else throw error;
    }
  }
  if (files.some((file) => /(?:^|\/)extensions\/.*\.ts$/.test(file.path))) warnings.push("\u5df2\u5ffd\u7565 Pi TypeScript \u6269\u5c55");
  warnings.push(...manifest.warnings);
  return { warnings, steps, skills, servers, bins, riskyTools, routines, config };
}

function readManifest(files: ArchiveFile[]): { name: string; version?: string; extensions?: Record<string, unknown>; warnings: string[] } {
  const file = files.find((item) => item.path === "plugin.json");
  if (!file) throw new AppError("\u63d2\u4ef6\u6e05\u5355\u65e0\u6548", "invalid");
  let parsed: unknown;
  try {
    parsed = parseJson(file.data.toString("utf8"));
  } catch {
    throw new AppError("\u63d2\u4ef6\u6e05\u5355\u65e0\u6548", "invalid");
  }
  if (!isObject(parsed) || parsed.$schema !== PLUGIN_SCHEMA || typeof parsed.name !== "string" || !isAppName(parsed.name)) {
    throw new AppError("\u63d2\u4ef6\u6e05\u5355\u65e0\u6548", "invalid");
  }
  const warnings: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!MANIFEST_FIELDS.includes(key)) {
      warnings.push(`\u672a\u77e5\u6e05\u5355\u5b57\u6bb5\uff1a${key}`);
      delete parsed[key];
    }
  }
  for (const key of ["version", "description", "homepage", "repository", "license"]) {
    if (parsed[key] !== undefined && typeof parsed[key] !== "string") throw new AppError("\u63d2\u4ef6\u6e05\u5355\u65e0\u6548", "invalid");
  }
  if (parsed.keywords !== undefined && !isStringArray(parsed.keywords)) throw new AppError("\u63d2\u4ef6\u6e05\u5355\u65e0\u6548", "invalid");
  if (parsed.author !== undefined) {
    if (!isObject(parsed.author) || Object.entries(parsed.author).some(([key, value]) => !["name", "email", "url"].includes(key) || typeof value !== "string")) {
      throw new AppError("\u63d2\u4ef6\u6e05\u5355\u65e0\u6548", "invalid");
    }
  }
  if (parsed.extensions !== undefined && !isObject(parsed.extensions)) {
    warnings.push("\u5df2\u5ffd\u7565\u65e0\u6548 extensions");
    delete parsed.extensions;
  }
  const version = typeof parsed.version === "string" ? parsed.version : undefined;
  const extensions = isObject(parsed.extensions) ? parsed.extensions : undefined;
  return {
    name: parsed.name,
    warnings,
    ...(version !== undefined ? { version } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

function parseConfig(value: unknown): ConfigDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AppError("\u914d\u7f6e\u65e0\u6548", "invalid");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isObject(item) || Object.keys(item).some((key) => !["key", "secret", "env", "header"].includes(key))) throw new AppError("\u914d\u7f6e\u65e0\u6548", "invalid");
    if (typeof item.key !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.key) || seen.has(item.key)) throw new AppError("\u914d\u7f6e\u65e0\u6548", "invalid");
    if (item.secret !== undefined && typeof item.secret !== "boolean") throw new AppError("\u914d\u7f6e\u65e0\u6548", "invalid");
    if (item.env !== undefined && (typeof item.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.env))) throw new AppError("\u914d\u7f6e\u65e0\u6548", "invalid");
    if (item.header !== undefined && (typeof item.header !== "string" || !/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(item.header))) throw new AppError("\u914d\u7f6e\u65e0\u6548", "invalid");
    seen.add(item.key);
    const env = typeof item.env === "string" ? item.env : undefined;
    const header = typeof item.header === "string" ? item.header : undefined;
    return {
      key: item.key,
      secret: item.secret === true,
      ...(env ? { env } : {}),
      ...(header ? { header } : {}),
    };
  });
}

function parseRoutines(value: unknown, warnings: string[]): AppRoutineTemplate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AppError("routines 无效", "invalid");
  const routines: AppRoutineTemplate[] = [];
  for (const item of value) {
    if (!isRoutineTemplate(item)) {
      warnings.push("已跳过无效定时任务");
      continue;
    }
    routines.push({ cron: item.cron, timezone: item.timezone, prompt: item.prompt.trim() });
  }
  return routines;
}

function isRoutineTemplate(value: unknown): value is AppRoutineTemplate {
  if (!isObject(value) || Object.keys(value).some((key) => key !== "cron" && key !== "timezone" && key !== "prompt")) return false;
  const { cron, timezone, prompt } = value;
  return typeof cron === "string" && cron.length > 0 && cron.length <= 128
    && typeof timezone === "string" && timezone.length > 0 && timezone.length <= 64
    && typeof prompt === "string" && prompt.trim().length > 0 && prompt.trim().length <= 4000;
}

function parseSetup(value: unknown): SetupStep[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AppError("\u5b89\u88c5\u6b65\u9aa4\u65e0\u6548", "invalid");
  return value.map((step) => {
    if (!isObject(step) || typeof step.type !== "string") throw new AppError("\u5b89\u88c5\u6b65\u9aa4\u65e0\u6548", "invalid");
    if (step.type === "apt" || step.type === "npm" || step.type === "pip") {
      const packages = step.packages;
      if (Object.keys(step).some((key) => key !== "type" && key !== "packages") || !isStringArray(packages)) {
        throw new AppError("\u5b89\u88c5\u5305\u65e0\u6548", "invalid");
      }
      if (packages.length === 0 || packages.some((pkg) => !pkg || pkg.startsWith("-") || pkg.includes("\0"))) {
        throw new AppError("\u5b89\u88c5\u5305\u65e0\u6548", "invalid");
      }
      if (step.type === "apt" && packages.some((pkg) => !APT_PACKAGE.test(pkg))) throw new AppError("\u5b89\u88c5\u5305\u65e0\u6548", "invalid");
      return { type: step.type, packages };
    }
    if (step.type === "exec") {
      const argv = step.argv;
      if (Object.keys(step).some((key) => key !== "type" && key !== "argv") || !isStringArray(argv)) {
        throw new AppError("\u5b89\u88c5\u547d\u4ee4\u65e0\u6548", "invalid");
      }
      const command = argv[0];
      if (argv.length === 0 || !command || argv.some((part) => part.includes("\0"))) throw new AppError("\u5b89\u88c5\u547d\u4ee4\u65e0\u6548", "invalid");
      if (SHELL_NAME.test(posix.basename(command))) throw new AppError("\u5b89\u88c5\u547d\u4ee4\u4e0d\u80fd\u662f shell", "invalid");
      return { type: "exec", argv };
    }
    throw new AppError("\u5b89\u88c5\u6b65\u9aa4\u65e0\u6548", "invalid");
  });
}

function parseBins(value: unknown, files: Map<string, ArchiveFile> | undefined): { name: string; path: string }[] {
  if (value === undefined) return [];
  const entries: { name: string; path: string }[] = [];
  if (typeof value === "string") entries.push({ name: posix.basename(value), path: value });
  else if (isStringArray(value)) {
    for (const path of value) entries.push({ name: posix.basename(path), path });
  } else if (isStringRecordValue(value)) {
    for (const [name, path] of Object.entries(value)) entries.push({ name, path });
  } else throw new AppError("bin \u914d\u7f6e\u65e0\u6548", "invalid");
  return entries.map((bin) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(bin.name) || SHELL_NAME.test(bin.name)) throw new AppError("bin \u540d\u79f0\u65e0\u6548", "invalid");
    const relative = bin.path.startsWith("./") ? bin.path.slice(2) : bin.path;
    let path: string;
    try {
      path = safePath(relative);
    } catch {
      throw new AppError("bin \u8def\u5f84\u65e0\u6548", "invalid");
    }
    if (files && !files.has(path)) throw new AppError("bin \u6587\u4ef6\u4e0d\u5b58\u5728", "invalid");
    return { name: bin.name, path };
  });
}

function parseServer(value: unknown): McpEntry | undefined {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value);
  if (value.type === "stdio") {
    if (keys.some((key) => !["type", "command", "args", "env", "cwd"].includes(key))) return undefined;
    if (typeof value.command !== "string" || value.command === "." || value.command === ".." || value.command.includes("$") || /\s/.test(value.command) || !/^(?:[A-Za-z0-9_+.-]+|\.\/\S+)$/.test(value.command)) return undefined;
    if (value.command.startsWith("./")) {
      try { safePath(value.command.slice(2)); } catch { return undefined; }
    }
    if (value.args !== undefined && !isStringArray(value.args)) return undefined;
    if (value.env !== undefined && (!isStringRecordValue(value.env) || "PLUGIN_ROOT" in value.env || "PLUGIN_DATA" in value.env)) return undefined;
    if (isStringArray(value.args) && !value.args.every(supportedPlaceholders)) return undefined;
    if (isStringRecordValue(value.env) && !Object.values(value.env).every(supportedPlaceholders)) return undefined;
    if (value.cwd !== undefined) {
      if (typeof value.cwd !== "string" || !/^(?:\.\/|\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\})$/.test(value.cwd)) return undefined;
    }
    const args = isStringArray(value.args) ? value.args : undefined;
    const env = isStringRecordValue(value.env) ? value.env : undefined;
    const cwd = typeof value.cwd === "string" ? value.cwd : undefined;
    return {
      type: "stdio",
      command: value.command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  if ((value.type !== "streamable-http" && value.type !== "sse") || keys.some((key) => !["type", "url", "headers"].includes(key))) return undefined;
  if (typeof value.url !== "string" || /\$\{[^}]*\}/.test(value.url) || !validRemoteUrl(value.url)) return undefined;
  if (value.headers !== undefined && !validHeaders(value.headers)) return undefined;
  const headers = isStringRecordValue(value.headers) ? value.headers : undefined;
  return { type: value.type, url: value.url, ...(headers ? { headers } : {}) };
}

function supportedPlaceholders(value: string): boolean {
  return !/\$\{(?!PLUGIN_ROOT\}|PLUGIN_DATA\})[^}]*\}/.test(value);
}

function parseSkill(directory: string, text: string): { name: string; description: string } | undefined {
  return parseSkillMarkdown(directory, text, Buffer.byteLength(text));
}

function validRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
    if (url.protocol === "http:" && !isLoopback(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function validHeaders(value: unknown): boolean {
  if (!isStringRecordValue(value)) return false;
  const seen = new Set<string>();
  for (const [key, header] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (seen.has(lower) || !/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(key)) return false;
    try {
      new Headers([[key, header]]);
    } catch {
      return false;
    }
    seen.add(lower);
  }
  return true;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(match?.slice(1).every((part) => Number(part) <= 255));
}

function readArchive(input: Buffer): ArchiveFile[] {
  let data = input;
  if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) {
    data = Buffer.from(gunzipSync(input, { maxOutputLength: ARCHIVE_BYTE_LIMIT + ARCHIVE_FILE_LIMIT * 1024 }));
  } else if (input.length >= 4 && input.readUInt32LE(0) === 0xfd2fb528) {
    data = Buffer.from(zstdDecompressSync(input, { maxOutputLength: ARCHIVE_BYTE_LIMIT + ARCHIVE_FILE_LIMIT * 1024 }));
  }
  if (data.length > ARCHIVE_BYTE_LIMIT + ARCHIVE_FILE_LIMIT * 1024) throw new AppError("\u5f52\u6863\u8d85\u8fc7 200MB", "invalid");
  const files: ArchiveFile[] = [];
  let at = 0;
  while (at + 512 <= data.length) {
    const header = data.subarray(at, at + 512);
    at += 512;
    if (header.every((byte) => byte === 0)) break;
    const expected = octal(header.subarray(148, 156));
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
    if (sum !== expected) throw new AppError("\u5f52\u6863\u6821\u9a8c\u5931\u8d25", "invalid");
    const text = (bytes: Buffer): string => bytes.toString("utf8").replace(/\0.*$/, "");
    const path = [text(header.subarray(345, 500)), text(header.subarray(0, 100))].filter(Boolean).join("/");
    let safe: string;
    try {
      safe = safePath(path);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("\u5f52\u6863\u8def\u5f84\u8d8a\u754c", "invalid");
    }
    const size = octal(header.subarray(124, 136));
    const type = header[156];
    if (size > ARCHIVE_BYTE_LIMIT || at + size > data.length) throw new AppError("\u5f52\u6863\u5927\u5c0f\u65e0\u6548", "invalid");
    if (type === 0 || type === 48) {
      files.push({
        path: safe,
        data: Buffer.from(data.subarray(at, at + size)),
        executable: Boolean(octal(header.subarray(100, 108)) & 0o111),
      });
    } else if (type !== 53) {
      throw new AppError("\u5f52\u6863\u5305\u542b\u975e\u5e38\u89c4\u6587\u4ef6", "invalid");
    }
    if (files.length > ARCHIVE_FILE_LIMIT) throw new AppError("\u5f52\u6863\u6587\u4ef6\u8fc7\u591a", "invalid");
    at += Math.ceil(size / 512) * 512;
  }
  return checkFiles(files);
}

function writeTar(files: ArchiveFile[]): Buffer {
  const chunks: Buffer[] = [];
  const field = (header: Buffer, value: number, start: number, length: number): void => {
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
  };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const header = Buffer.alloc(512);
    let name = file.path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf("/", name.length - 1);
      prefix = name.slice(0, split);
      name = name.slice(split + 1);
    }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155 || !name) throw new AppError("\u5f52\u6863\u8def\u5f84\u8fc7\u957f", "invalid");
    header.write(name, 0, 100);
    field(header, file.executable ? 0o755 : 0o644, 100, 8);
    field(header, 0, 108, 8);
    field(header, 0, 116, 8);
    field(header, file.data.length, 124, 12);
    field(header, 0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    header.write(prefix, 345, 155);
    field(header, header.reduce((sum, byte) => sum + byte, 0), 148, 8);
    chunks.push(header, file.data, Buffer.alloc((512 - (file.data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function checkFiles(files: readonly ArchiveFile[]): ArchiveFile[] {
  if (files.length > ARCHIVE_FILE_LIMIT) throw new AppError("\u5f52\u6863\u6587\u4ef6\u8fc7\u591a", "invalid");
  let total = 0;
  const names = new Set<string>();
  return files.map((file) => {
    const path = safePath(file.path);
    if (names.has(path)) throw new AppError("\u5f52\u6863\u8def\u5f84\u91cd\u590d", "invalid");
    names.add(path);
    total += file.data.length;
    if (total > ARCHIVE_BYTE_LIMIT) throw new AppError("\u5f52\u6863\u8d85\u8fc7 200MB", "invalid");
    return { ...file, path };
  });
}

function safePath(path: string): string {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new AppError("\u5f52\u6863\u8def\u5f84\u8d8a\u754c", "invalid");
  }
  if (path.split("/").includes("..")) throw new AppError("\u5f52\u6863\u8def\u5f84\u8d8a\u754c", "invalid");
  const normalized = posix.normalize(path).replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") throw new AppError("\u5f52\u6863\u8def\u5f84\u8d8a\u754c", "invalid");
  return normalized;
}

function octal(bytes: Buffer): number {
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new AppError("\u5f52\u6863\u6821\u9a8c\u5931\u8d25", "invalid");
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value)) throw new AppError("\u5f52\u6863\u6821\u9a8c\u5931\u8d25", "invalid");
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (
    isObject(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item
  ));
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function parseJsonFile(file: ArchiveFile | undefined): unknown {
  if (!file) return undefined;
  return parseJson(file.data.toString("utf8"));
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAppName(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value);
}

function isVersion(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validCurrentLink(value: string): boolean {
  return /^versions\/[a-f0-9]{64}$/.test(value) || (isVersion(value) && !value.includes(".."));
}

function isSkillName(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function assertAppName(name: string): void {
  if (!isAppName(name)) throw new AppError("\u5e94\u7528\u540d\u79f0\u65e0\u6548", "invalid");
}

function assertVersion(version: string): void {
  if (!isVersion(version)) throw new AppError("\u7248\u672c\u65e0\u6548", "invalid");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecordValue(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new AppError("\u8bf7\u6c42\u4f53\u5fc5\u987b\u662f\u5bf9\u8c61", "invalid");
  return value;
}

function stringList(value: unknown, message: string): string[] {
  if (!isStringArray(value)) throw new AppError(message, "invalid");
  return value;
}

function stringRecord(value: unknown, message: string): Record<string, string> {
  if (!isStringRecordValue(value)) throw new AppError(message, "invalid");
  return value;
}

function routeParam(params: unknown, key: string): string {
  if (!isObject(params)) throw new AppError("\u8def\u5f84\u53c2\u6570\u65e0\u6548", "invalid");
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new AppError("\u8def\u5f84\u53c2\u6570\u65e0\u6548", "invalid");
  return value;
}

function isEnoent(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

async function readInstallRequest(request: FastifyRequest): Promise<InstallRequest> {
  const query = isObject(request.query) ? request.query : {};
  if (request.body instanceof Readable) {
    return {
      name: requiredString(query.name),
      version: requiredString(query.version),
      sha256: requiredString(query.sha256),
      archive: await readLimited(request.body),
    };
  }
  if (Buffer.isBuffer(request.body)) {
    return {
      name: requiredString(query.name),
      version: requiredString(query.version),
      sha256: requiredString(query.sha256),
      archive: request.body,
    };
  }
  const body = asObject(request.body);
  const name = typeof body.name === "string" ? body.name : requiredString(query.name);
  const version = typeof body.version === "string" ? body.version : requiredString(query.version);
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : requiredString(query.sha256);
  if (typeof body.archiveBase64 !== "string") throw new AppError("\u7f3a\u5c11\u5f52\u6863", "invalid");
  if (body.archiveBase64.length > ARCHIVE_BYTE_LIMIT * 2) throw new AppError("\u5f52\u6863\u8d85\u8fc7 200MB", "invalid");
  return { name, version, sha256, archive: Buffer.from(body.archiveBase64, "base64") };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new AppError("\u5b89\u88c5\u53c2\u6570\u65e0\u6548", "invalid");
  return value;
}

async function readLimited(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > ARCHIVE_BYTE_LIMIT) throw new AppError("\u5f52\u6863\u8d85\u8fc7 200MB", "invalid");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
