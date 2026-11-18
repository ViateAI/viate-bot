import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import type { FsEntry, FsSearchHit } from "@viate-bot/protocol";
import { deleteConfined, fsFailure, listConfined, packConfined, readConfined, readRaw, searchConfined, writeConfined } from "./fs-ops.js";

dropToBot();

if (process.argv[2] === "--pack") {
  const requested = process.argv[3] ?? "";
  packConfined(requested)
    .then((archive) => pipeline(archive, process.stdout))
    .catch((error: unknown) => {
      process.stderr.write(fsFailure(error).error);
      process.exit(1);
    });
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
  if (request.op === "read") {
    return { read: await readConfined(path, request.maxBytes ?? 1024 * 1024, request.encoding === "base64" ? "base64" : "utf8") };
  }
  if (request.op === "write" || request.op === "writeFile") {
    const bytes = request.op === "write" ? Buffer.from(request.content ?? "", "base64") : Buffer.from(request.data ?? "", "base64");
    const mode = request.mode ?? 0o644;
    return { write: await writeConfined(path, bytes, mode) };
  }
  if (request.op === "list") {
    const listed: { path: string; entries: FsEntry[] } = await listConfined(path);
    return { list: listed };
  }
  if (request.op === "search") {
    const found: { hits: FsSearchHit[]; truncated: boolean } = await searchConfined(
      path,
      request.pattern ?? "",
      request.maxResults ?? 100,
    );
    return { search: found };
  }
  if (request.op === "readFile") {
    const result = await readRaw(path);
    return { file: result.data.toString("base64") };
  }
  if (request.op === "delete") {
    return { delete: await deleteConfined(path) };
  }
  throw Object.assign(new Error("未知文件操作"), { statusCode: 400 });
}

function reply(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
