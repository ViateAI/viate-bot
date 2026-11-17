import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { FsEntry, FsSearchHit } from "@viate-bot/protocol";
import { PathEscapeError, resolveConfined } from "./paths.js";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

export interface FsReadResult {
  path: string;
  content: string;
  truncated: boolean;
}

export interface FsWriteResult {
  path: string;
  bytes: number;
}

/** 调用方必须已经是 bot。路径检查是第一道拦截，打开文件时不再跟随最后一层符号链接。 */
export async function readRaw(requested: string): Promise<{ path: string; data: Buffer }> {
  const path = resolveConfined(requested);
  const file = await open(path, READ_FLAGS);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw Object.assign(new Error("不是普通文件"), { statusCode: 400 });
    const data = Buffer.alloc(info.size);
    await file.read(data, 0, data.length, 0);
    return { path, data };
  } finally {
    await file.close();
  }
}

export async function readConfined(requested: string, maxBytes: number): Promise<FsReadResult> {
  const path = resolveConfined(requested);
  const file = await open(path, READ_FLAGS);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw Object.assign(new Error("不是普通文件"), { statusCode: 400 });
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, 0);
    return { path, content: buffer.toString("utf8"), truncated: info.size > length };
  } finally {
    await file.close();
  }
}

export async function writeConfined(requested: string, content: Buffer, mode: number): Promise<FsWriteResult> {
  const path = resolveConfined(requested);
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, WRITE_FLAGS, mode);
  try {
    await file.write(content);
    return { path, bytes: content.length };
  } finally {
    await file.close();
  }
}

/**
 * 只删普通文件。先看请求路径的最后一段，不让 resolveConfined 把符号链接解析成目标。
 * 父目录仍走限制检查；最后一段是符号链接或目录时什么都不删。
 */
export async function deleteConfined(requested: string): Promise<{ path: string }> {
  const name = basename(requested);
  if (name.length === 0 || name === "." || name === "..") {
    throw Object.assign(new Error("只能删除普通文件"), { statusCode: 400 });
  }
  const path = join(resolveConfined(dirname(requested)), name);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw Object.assign(new Error("只能删除普通文件"), { statusCode: 400 });
  }
  await unlink(path);
  return { path };
}

export async function listConfined(requested: string): Promise<{ path: string; entries: FsEntry[] }> {
  const path = resolveConfined(requested);
  const dirents = await readdir(path, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (entry) => {
      const info = await stat(join(path, entry.name)).catch(() => undefined);
      const type = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "dir"
          : entry.isFile()
            ? "file"
            : "other";
      const item: FsEntry = { name: entry.name, type, size: info?.size ?? 0 };
      return item;
    }),
  );
  return { path, entries };
}

export async function searchConfined(
  requested: string,
  pattern: string,
  maxResults: number,
): Promise<{ hits: FsSearchHit[]; truncated: boolean }> {
  const path = resolveConfined(requested);
  const hits = await ripgrep(path, pattern, maxResults);
  return { hits: hits.slice(0, maxResults), truncated: hits.length > maxResults };
}

export function fsFailure(error: unknown): { error: string; name: string; statusCode: number } {
  if (error instanceof PathEscapeError) {
    return { error: error.message, name: error.name, statusCode: 400 };
  }
  const code = errorCode(error);
  if (code === "ENOENT") return { error: "文件不存在", name: "Error", statusCode: 404 };
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP" || code === "ENOTDIR") {
    return { error: "无法访问该路径", name: "Error", statusCode: 400 };
  }
  if (typeof error === "object" && error !== null && "statusCode" in error && error instanceof Error) {
    const status = error.statusCode;
    return {
      error: error.message,
      name: error.name,
      statusCode: typeof status === "number" ? status : 500,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: message, name: "Error", statusCode: 500 };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

async function ripgrep(path: string, pattern: string, maxResults: number): Promise<FsSearchHit[]> {
  const child = spawn("rg", ["--json", "--max-count", String(maxResults + 1), pattern, path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    child.on("error", () => resolve(""));
  });
  const hits: FsSearchHit[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const hit = rgHit(line, path);
    if (hit) hits.push(hit);
  }
  return hits;
}

function rgHit(line: string, root: string): FsSearchHit | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== "match") return undefined;
  if (!("data" in parsed) || !parsed.data || typeof parsed.data !== "object") return undefined;
  const data = parsed.data;
  if (!("path" in data) || !data.path || typeof data.path !== "object" || !("text" in data.path)) return undefined;
  if (typeof data.path.text !== "string") return undefined;
  if (!("line_number" in data) || typeof data.line_number !== "number") return undefined;
  let text = "";
  if ("lines" in data && data.lines && typeof data.lines === "object" && "text" in data.lines && typeof data.lines.text === "string") {
    text = data.lines.text.replace(/\n$/, "");
  }
  return {
    path: relative(root, data.path.text) || data.path.text,
    line: data.line_number,
    text,
  };
}
