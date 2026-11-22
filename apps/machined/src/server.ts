/**
 * 这些路由只服务控制面：健康检查、指标、在机器内执行命令、读写机器内的文件、转发本机浏览器 CDP。
 * machined 不提供“把应用地址交给控制面去连”的接口。远程 MCP 从机器内发起。
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, statfs } from "node:fs/promises";
import { Readable, type Readable as ReadableStream } from "node:stream";
import { killProcessGroup } from "./process-group.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  MACHINE_PROTOCOL_VERSION,
  type ExecEvent,
  type FsListResponse,
  type FsReadResponse,
  type FsSearchResponse,
  type FsWriteResponse,
  type HealthResponse,
  type MetricsResponse,
} from "@viate-bot/protocol";
import { createAppRuntime, registerAppRoutes } from "./apps.js";
import { attachBrowser } from "./browser-route.js";
import { registerDisplayRoutes } from "./display.js";
import { createMcpHost, registerMcpRoutes } from "./mcp-host.js";
import { createFsClient, type FsClient } from "./fs-client.js";
import { parseConfinePolicy, resolveAccessible, type ConfinePolicy } from "./paths.js";

export const MACHINED_VERSION = "0.0.0";
const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 600;
const CAPTURE_BYTES = 8 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface MachinedOptions {
  token: string;
  version?: string;
  /** 缺省 http://127.0.0.1:9222/json/version。测试可以指到假的 Chromium。 */
  browserVersionUrl?: string;
  /** 只接受这个端口上的回环调试地址。缺省 9222。 */
  browserDebugPort?: number;
  /** 缺省以 bot 身份给 Chromium 主进程发 SIGTERM，由 supervisord 重新拉起。 */
  restartBrowser?: () => Promise<void>;
  /** 测试替换执行器。生产缺省是 run-as-bot。 */
  execSpawn?: { command: string; baseArgs: string[] };
  /** 测试替换文件系统。生产缺省按 uid 选择。 */
  files?: FsClient;
}

export function buildServer(options: MachinedOptions): FastifyInstance {
  let files: FsClient | undefined = options.files;
  const filesystem = (): FsClient => {
    files ??= createFsClient();
    return files;
  };
  const token = options.token;
  if (!token) throw new Error("VB_MACHINED_TOKEN 不能为空");
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;
    if (header !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "未认证" });
    }
  });

  app.get("/health", async (): Promise<HealthResponse> => ({
    ok: true,
    version: options.version ?? MACHINED_VERSION,
    protocol: MACHINE_PROTOCOL_VERSION,
  }));

  app.get("/metrics", async (): Promise<MetricsResponse> => readMetrics());

  const execJobs = new Map<string, { kill: () => Promise<void>; done: Promise<void> }>();
  const launcher = options.execSpawn ?? { command: "/usr/bin/node", baseArgs: ["/opt/viate/run-as-bot.mjs"] };

  app.post("/exec/cancel", async (request) => {
    const body = bodyRecord(request.body);
    if (typeof body.id !== "string" || body.id.length === 0) {
      throw Object.assign(new Error("id 不能为空"), { name: "PathEscapeError" });
    }
    const job = execJobs.get(body.id);
    if (!job) return { stopped: true };
    await job.kill();
    await job.done;
    return { stopped: true };
  });

  app.post("/exec", async (request, reply) => {
    const body = bodyRecord(request.body);
    if (typeof body.cmd !== "string" || body.cmd.length === 0) {
      return reply.code(400).send({ error: "cmd 不能为空" });
    }
    if (body.timeoutSec !== undefined && typeof body.timeoutSec !== "number") {
      return reply.code(400).send({ error: "timeoutSec 必须是数字" });
    }
    const cwd = typeof body.cwd === "string" ? resolveAccessible(body.cwd, body.confine !== false, readPolicy(body)) : "/home/bot";
    const timeoutSec = clampTimeout(typeof body.timeoutSec === "number" ? body.timeoutSec : undefined);
    const id = randomUUID();
    await streamExec(reply, request, id, execJobs, launcher, body.cmd, cwd, timeoutSec, stringRecord(body.env));
  });

  app.post("/fs/read", async (request, reply) => {
    const body = bodyRecord(request.body);
    if (typeof body.path !== "string" || body.path.length === 0) {
      return reply.code(400).send({ error: "path 不能为空" });
    }
    const requestedMax = typeof body.maxBytes === "number" ? body.maxBytes : MAX_READ_BYTES;
    const maxBytes = Math.min(requestedMax, MAX_READ_BYTES);
    const encoding = body.encoding === "base64" ? "base64" : "utf8";
    const result = await filesystem().read(body.path, maxBytes, encoding, body.confine !== false, readPolicy(body));
    const response: FsReadResponse = result;
    return response;
  });

  app.post("/fs/write", async (request) => {
    const body = bodyRecord(request.body);
    if (typeof body.path !== "string" || body.path.length === 0) {
      throw Object.assign(new Error("path 不能为空"), { name: "PathEscapeError" });
    }
    if (typeof body.content !== "string") {
      throw Object.assign(new Error("content 必须是字符串"), { name: "PathEscapeError" });
    }
    const content = Buffer.from(body.content, "utf8");
    if (content.length > MAX_WRITE_BYTES) throw new Error("写入内容超过 8MB");
    const mode = typeof body.mode === "number" ? body.mode : 0o644;
    const result = await filesystem().write(body.path, content, mode, body.confine !== false, readPolicy(body));
    const response: FsWriteResponse = result;
    return response;
  });

  app.post("/fs/list", async (request) => {
    const body = bodyRecord(request.body);
    if (typeof body.path !== "string" || body.path.length === 0) {
      throw Object.assign(new Error("path 不能为空"), { name: "PathEscapeError" });
    }
    const result = await filesystem().list(body.path, body.confine !== false, readPolicy(body));
    const response: FsListResponse = result;
    return response;
  });

  app.post("/fs/search", async (request) => {
    const body = bodyRecord(request.body);
    if (typeof body.path !== "string" || typeof body.pattern !== "string" || body.pattern.length === 0) {
      throw Object.assign(new Error("path 和 pattern 不能为空"), { name: "PathEscapeError" });
    }
    const maxResults = typeof body.maxResults === "number" ? body.maxResults : 100;
    const result = await filesystem().search(body.path, body.pattern, maxResults, body.confine !== false, readPolicy(body));
    const response: FsSearchResponse = result;
    return response;
  });

  app.post("/fs/delete", async (request) => {
    const body = bodyRecord(request.body);
    if (typeof body.path !== "string" || body.path.length === 0) {
      throw Object.assign(new Error("path 不能为空"), { name: "PathEscapeError" });
    }
    return filesystem().delete(body.path, body.confine !== false, readPolicy(body));
  });

  app.post("/fs/pack", async (request, reply) => {
    const body = bodyRecord(request.body);
    if (typeof body.path !== "string" || body.path.length === 0) {
      throw Object.assign(new Error("path 不能为空"), { name: "PathEscapeError" });
    }
    const archive = await filesystem().pack(body.path, body.confine !== false, readPolicy(body));
    return reply.type("application/x-tar").send(archive);
  });

  app.post("/fs/download", async (request, reply) => {
    const body = bodyRecord(request.body);
    if (typeof body.path !== "string" || body.path.length === 0) {
      throw Object.assign(new Error("path 不能为空"), { name: "PathEscapeError" });
    }
    const requestedMax = typeof body.maxBytes === "number" && Number.isFinite(body.maxBytes) ? body.maxBytes : MAX_UPLOAD_BYTES;
    const maxBytes = Math.min(Math.max(0, requestedMax), MAX_UPLOAD_BYTES);
    const stream = await filesystem().download(body.path, maxBytes, body.confine !== false, readPolicy(body));
    return reply.type("application/octet-stream").send(stream);
  });

  app.get("/fs/file", async (request, reply) => {
    const path = queryPath(request);
    const data = await filesystem().readFile(path, queryConfined(request));
    reply.header("content-length", data.length);
    return reply.send(data);
  });

  app.put("/fs/file", async (request, reply) => {
    const path = queryPath(request);
    if (!(request.body instanceof Readable)) {
      return reply.code(415).send({ error: "上传需要 application/octet-stream" });
    }
    const data = await readBody(request.body, MAX_WRITE_BYTES);
    await filesystem().writeFile(path, data, queryConfined(request));
    return reply.send({ path });
  });

  app.post("/fs/upload", async (request, reply) => {
    const path = queryPath(request);
    const delivery = queryDelivery(request);
    const body = request.body;
    if (!(body instanceof Readable)) {
      return reply.code(415).send({ error: "上传需要 application/octet-stream" });
    }
    body.on("error", () => {});
    const closeLater = () => {
      reply.raw.once("finish", () => {
        if (!body.destroyed) body.destroy();
      });
    };
    try {
      const result = await filesystem().upload(path, body, MAX_UPLOAD_BYTES, delivery, queryConfined(request));
      closeLater();
      return reply.send(result);
    } catch (error) {
      const known = error instanceof Error ? error : new Error(String(error));
      const reported = "statusCode" in known && typeof known.statusCode === "number" ? known.statusCode : 500;
      const status = known.name === "PathEscapeError" ? 400 : reported;
      return reply.code(status).send({ error: known.message });
    }
  });

  attachBrowser(app, options);
  registerDisplayRoutes(app, { token: options.token });
  const mcp = createMcpHost();
  registerAppRoutes(app, createAppRuntime(), { mcp });
  registerMcpRoutes(app, mcp, { token: options.token });

  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof Error ? error : new Error(String(error));
    const reported = "statusCode" in known && typeof known.statusCode === "number" ? known.statusCode : undefined;
    const status = known.name === "PathEscapeError" ? 400 : reported && reported >= 400 && reported < 600 ? reported : 500;
    reply.code(status).send({ error: known.message });
  });

  return app;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("请求体必须是对象"), { name: "PathEscapeError" });
  }
  return Object.fromEntries(Object.entries(value));
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("env 必须是对象"), { name: "PathEscapeError" });
  }
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw Object.assign(new Error("env 的值必须是字符串"), { name: "PathEscapeError" });
    }
    env[key] = item;
  }
  return env;
}

function queryPath(request: FastifyRequest): string {
  const query = request.query;
  if (!query || typeof query !== "object" || !("path" in query) || typeof query.path !== "string" || query.path.length === 0) {
    throw Object.assign(new Error("缺少 path"), { name: "PathEscapeError" });
  }
  return query.path;
}

function queryDelivery(request: FastifyRequest): string {
  const query = request.query;
  if (!query || typeof query !== "object" || !("delivery" in query) || typeof query.delivery !== "string" || query.delivery.length === 0) {
    throw Object.assign(new Error("缺少 delivery"), { name: "PathEscapeError" });
  }
  return query.delivery;
}

function queryConfined(request: FastifyRequest): boolean {
  const query = request.query;
  if (!query || typeof query !== "object" || !("confine" in query)) return true;
  return query.confine !== "false";
}

function readPolicy(body: Record<string, unknown>): ConfinePolicy | undefined {
  if (!Object.hasOwn(body, "confinePolicy") || body.confinePolicy === undefined) return undefined;
  return parseConfinePolicy(body.confinePolicy);
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SEC;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_SEC) {
    throw Object.assign(new Error(`timeoutSec 必须是 1 到 ${MAX_TIMEOUT_SEC} 的整数`), {
      name: "PathEscapeError",
    });
  }
  return value;
}

async function streamExec(
  reply: FastifyReply,
  request: FastifyRequest,
  id: string,
  jobs: Map<string, { kill: () => Promise<void>; done: Promise<void> }>,
  launcher: { command: string; baseArgs: string[] },
  cmd: string,
  cwd: string,
  timeoutSec: number,
  env: Record<string, string> | undefined,
): Promise<void> {
  const child: ChildProcessByStdio<null, ReadableStream, ReadableStream> = spawn(
    launcher.command,
    [...launcher.baseArgs, cwd, cmd],
    {
      cwd,
      env: { ...process.env, ...env, HOME: "/home/bot", USER: "bot", LOGNAME: "bot" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const kill = () => killProcessGroup(child.pid);
  jobs.set(id, { kill, done });
  let ending = false;
  const onClientGone = () => {
    if (!ending) void kill().catch((error: unknown) => appKillError(error));
  };
  reply.raw.on("close", onClientGone);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-exec-id": id,
  });
  reply.raw.flushHeaders?.();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void kill().catch((error: unknown) => appKillError(error));
  }, timeoutSec * 1000);
  const stdout = captureStream(child.stdout, "stdout", (event) => writeEvent(reply, event));
  const stderr = captureStream(child.stderr, "stderr", (event) => writeEvent(reply, event));
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (exitCode) => resolve(exitCode));
  });
  settle();
  clearTimeout(timer);
  ending = true;
  reply.raw.off("close", onClientGone);
  jobs.delete(id);
  await Promise.all([stdout, stderr]);
  const event: ExecEvent = {
    type: "exit",
    code,
    signal: timedOut || child.signalCode === "SIGKILL" ? "SIGKILL" : null,
    timedOut,
  };
  writeEvent(reply, event);
  reply.raw.end();
}

function appKillError(error: unknown): void {
  console.error("exec 进程组停止失败", error instanceof Error ? error.message : "unknown");
}

export function captureStream(
  stream: ReadableStream,
  name: "stdout" | "stderr",
  emit: (event: ExecEvent) => void,
): Promise<void> {
  const head: Buffer[] = [];
  const tail: Buffer[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let dropped = 0;
  return new Promise((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      let offset = 0;
      if (headBytes < CAPTURE_BYTES) {
        const take = Math.min(CAPTURE_BYTES - headBytes, chunk.length);
        head.push(chunk.subarray(0, take));
        headBytes += take;
        offset = take;
      }
      if (offset < chunk.length) {
        const rest = chunk.subarray(offset);
        tail.push(rest);
        tailBytes += rest.length;
        dropped += rest.length;
        while (tailBytes > CAPTURE_BYTES) {
          const extra = tailBytes - CAPTURE_BYTES;
          const first = tail[0];
          if (!first) break;
          if (first.length <= extra) {
            tail.shift();
            tailBytes -= first.length;
          } else {
            tail[0] = first.subarray(extra);
            tailBytes -= extra;
          }
        }
      }
    });
    stream.on("end", () => {
      if (headBytes > 0) emit({ type: name, data: Buffer.concat(head).toString("utf8") });
      if (dropped > tailBytes) {
        emit({ type: "truncated", stream: name, droppedBytes: dropped - tailBytes });
      }
      if (tailBytes > 0) emit({ type: name, data: Buffer.concat(tail).toString("utf8") });
      resolve();
    });
  });
}

function writeEvent(reply: FastifyReply, event: ExecEvent): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readMetrics(): Promise<MetricsResponse> {
  const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => "");
  const total = kilobytes(meminfo, "MemTotal");
  const available = kilobytes(meminfo, "MemAvailable");
  const memMb = total && available ? (total - available) / 1024 : 0;
  const load = await readFile("/proc/loadavg", "utf8").catch(() => "0");
  const cores = Number((await readFile("/proc/cpuinfo", "utf8").catch(() => "")).match(/processor/g)?.length ?? 1);
  const cpuPct = (Number(load.split(" ")[0] ?? 0) / cores) * 100;
  const disk = await diskUsage("/home/bot");
    const processes = (await readdir("/proc").catch(() => [] as string[])).filter((name) => /^\d+$/.test(name))
      .length;
  return {
    cpuPct: Number(cpuPct.toFixed(1)),
    memMb: Number(memMb.toFixed(1)),
    diskMb: Number((disk.used / (1024 * 1024)).toFixed(1)),
    processCount: processes,
  };
}

function kilobytes(meminfo: string, key: string): number {
  const match = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
  return match?.[1] ? Number(match[1]) : 0;
}

async function diskUsage(path: string): Promise<{ used: number }> {
  try {
    const info = await statfs(path);
    const total = Number(info.blocks) * Number(info.bsize);
    const free = Number(info.bavail) * Number(info.bsize);
    return { used: total - free };
  } catch {
    return { used: 0 };
  }
}

async function readBody(stream: ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw Object.assign(new Error("写入内容超过 8MB"), { statusCode: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
