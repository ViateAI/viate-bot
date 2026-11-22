import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import type { FsEntry, FsSearchHit } from "@viate-bot/protocol";
import { deleteConfined, fsFailure, listConfined, openDownloadStream, packConfined, readConfined, readRaw, searchConfined, streamUpload, writeConfined } from "./fs-ops.js";
import { parseConfinePolicy, PathEscapeError, type ConfinePolicy } from "./paths.js";

dropToBot();

if (process.argv[2] === "--pack") {
  const requested = process.argv[3] ?? "";
  const confine = process.argv[4] !== "false";
  let policy: ConfinePolicy | undefined;
  try {
    policy = policyArg(process.argv[5]);
  } catch (error: unknown) {
    process.stderr.write(fsFailure(error).error);
    process.exit(1);
  }
  packConfined(requested, confine, policy)
    .then((archive) => pipeline(archive, process.stdout))
    .catch((error: unknown) => {
      process.stderr.write(fsFailure(error).error);
      process.exit(1);
    });
} else if (process.argv[2] === "--upload") {
  const path = process.argv[3] ?? "";
  const maxBytes = Number(process.argv[4] ?? 25 * 1024 * 1024);
  const deliveryId = process.argv[5] ?? "";
  const confine = process.argv[6] !== "false";
  let policy: ConfinePolicy | undefined;
  try {
    policy = policyArg(process.argv[7]);
  } catch (error: unknown) {
    const failure = fsFailure(error);
    process.stdout.write(JSON.stringify({ ok: false, ...failure }));
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) streamUpload(path, process.stdin, maxBytes, deliveryId, confine, policy).then((result) => {
    process.stdout.write(JSON.stringify({ ok: true, ...result }));
  }).catch((error: unknown) => {
    const failure = fsFailure(error);
    process.stdout.write(JSON.stringify({ ok: false, ...failure }));
    process.exitCode = 1;
  });
} else if (process.argv[2] === "--download") {
  void runDownload();
} else {
  const lines = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  lines.on("line", (line) => {
    chain = chain.then(() => handle(line));
  });
}

function dropToBot(): void {
  if (process.getuid?.() !== 0) return;
  if (process.setgid === undefined || process.setuid === undefined || process.getuid === undefined) {
    process.stderr.write("fs worker 无法降权\n");
    process.exit(127);
  }
  process.setgroups?.([]);
  process.setgid(1000);
  process.setuid(1000);
  if (process.getuid() !== 1000) {
    process.stderr.write("fs worker 没能降到 uid 1000\n");
    process.exit(127);
  }
}

interface Request {
  id: number;
  op: "read" | "write" | "list" | "search" | "readFile" | "writeFile" | "delete";
  path?: string;
  maxBytes?: number;
  content?: string;
  mode?: number;
  pattern?: string;
  maxResults?: number;
  data?: string;
  encoding?: "utf8" | "base64";
  confine?: boolean;
  confinePolicy?: ConfinePolicy;
}

async function handle(line: string): Promise<void> {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    return;
  }
  const path = request.path;
  if (typeof request.id !== "number" || typeof path !== "string") {
    reply({ id: request.id, ok: false, error: "请求不完整", name: "Error", statusCode: 400 });
    return;
  }
  try {
    const result = await run(request, path);
    reply({ id: request.id, ok: true, ...result });
  } catch (error) {
    const failure = fsFailure(error);
    reply({ id: request.id, ok: false, ...failure });
  }
}

async function run(request: Request, path: string): Promise<Record<string, unknown>> {
  const confine = request.confine !== false;
  const policy = request.confinePolicy;
  if (request.op === "read") {
    return { read: await readConfined(path, request.maxBytes ?? 1024 * 1024, request.encoding === "base64" ? "base64" : "utf8", confine, policy) };
  }
  if (request.op === "write" || request.op === "writeFile") {
    const bytes = request.op === "write" ? Buffer.from(request.content ?? "", "base64") : Buffer.from(request.data ?? "", "base64");
    const mode = request.mode ?? 0o644;
    return { write: await writeConfined(path, bytes, mode, confine, policy) };
  }
  if (request.op === "list") {
    const listed: { path: string; entries: FsEntry[] } = await listConfined(path, confine, policy);
    return { list: listed };
  }
  if (request.op === "search") {
    const found: { hits: FsSearchHit[]; truncated: boolean } = await searchConfined(
      path,
      request.pattern ?? "",
      request.maxResults ?? 100,
      confine,
      policy,
    );
    return { search: found };
  }
  if (request.op === "readFile") {
    const result = await readRaw(path, confine, policy);
    return { file: result.data.toString("base64") };
  }
  if (request.op === "delete") {
    return { delete: await deleteConfined(path, confine, policy) };
  }
  throw Object.assign(new Error("未知文件操作"), { statusCode: 400 });
}

function reply(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function policyArg(raw: string | undefined): ConfinePolicy | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PathEscapeError("confinePolicy 必须是对象");
  }
  return parseConfinePolicy(parsed);
}

async function runDownload(): Promise<void> {
  try {
    const requested = process.argv[3] ?? "";
    const maxBytes = Number(process.argv[4]);
    const confine = process.argv[5] !== "false";
    const policy = policyArg(process.argv[6]);
    const opened = await openDownloadStream(requested, maxBytes, confine, policy);
    await pipeline(opened.stream, process.stdout);
  } catch (error: unknown) {
    await new Promise<void>((resolve) => {
      process.stderr.write(JSON.stringify(fsFailure(error)), () => resolve());
    });
    process.exit(1);
  }
}
