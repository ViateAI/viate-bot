import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { FsEntry, FsSearchHit } from "@viate-bot/protocol";
import { PathEscapeError, resolveConfined } from "./paths.js";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
const PACK_FILES = 5000;
const PACK_BYTES = 200 * 1024 * 1024;

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

export async function readConfined(requested: string, maxBytes: number, encoding: "utf8" | "base64" = "utf8"): Promise<FsReadResult> {
  const path = resolveConfined(requested);
  const file = await open(path, READ_FLAGS);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw Object.assign(new Error("不是普通文件"), { statusCode: 400 });
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, 0);
    return { path, content: buffer.toString(encoding), truncated: info.size > length };
  } finally {
    await file.close();
  }
}

export async function writeConfined(requested: string, content: Buffer, mode: number): Promise<FsWriteResult> {
  const path = resolveConfined(requested);
  // A lexical approval prefix must not write through an alias to a different directory.
  if (path !== resolve(requested)) throw new PathEscapeError("写入路径不能包含符号链接");
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

interface PackedFile {
  path: string;
  absolute: string;
  size: number;
  ino: number;
  dev: number;
  mode: number;
}

/** 打包目录为 ustar。不跟随符号链接，跳过 fifo、socket 和设备文件，超限时在读文件内容前停下。 */
export async function packConfined(requested: string): Promise<Readable> {
  const root = resolveConfined(requested);
  const info = await lstat(root);
  if (!info.isDirectory()) throw Object.assign(new Error("只能打包目录"), { statusCode: 400 });
  const files: PackedFile[] = [];
  const total = { bytes: 0 };
  await collectPack(root, root, files, total);
  return Readable.from(renderTar(root, files), { objectMode: false, highWaterMark: 64 * 1024 });
}

async function collectPack(root: string, dir: string, files: PackedFile[], total: { bytes: number }): Promise<void> {
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const entry of dirents) {
    const abs = join(dir, entry.name);
    const info = await lstat(abs);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await collectPack(root, abs, files, total);
      continue;
    }
    if (!info.isFile()) continue;
    if (files.length >= PACK_FILES) throw Object.assign(new Error("文件数超过 5000"), { statusCode: 400 });
    if (total.bytes + info.size > PACK_BYTES) throw Object.assign(new Error("打包超过 200MB"), { statusCode: 400 });
    total.bytes += info.size;
    files.push({ path: relative(root, abs).split(sep).join("/"), absolute: abs, size: info.size, ino: info.ino, dev: info.dev, mode: info.mode & 0o777 });
  }
}

async function* renderTar(root: string, files: PackedFile[]): AsyncGenerator<Buffer> {
  const field = (header: Buffer, value: number, start: number, length: number) => {
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
  };
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    const header = Buffer.alloc(512);
    let name = file.path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf("/");
      prefix = split > 0 ? name.slice(0, split) : "";
      name = split > 0 ? name.slice(split + 1) : name;
    }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155 || name.length === 0) {
      throw Object.assign(new Error("打包路径过长"), { statusCode: 400 });
    }
    header.write(name, 0, Buffer.byteLength(name), "utf8");
    field(header, file.mode, 100, 8);
    field(header, 0, 108, 8);
    field(header, 0, 116, 8);
    field(header, file.size, 124, 12);
    field(header, 0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (prefix.length > 0) header.write(prefix, 345, Buffer.byteLength(prefix), "utf8");
    let sum = 0;
    for (const byte of header) sum += byte;
    field(header, sum, 148, 8);
    const resolved = resolveConfined(file.absolute);
    if (resolved !== file.absolute || !resolved.startsWith(`${root}/`)) throw new PathEscapeError("打包路径已改变");
    const handle = await open(file.absolute, READ_FLAGS | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== file.ino || info.dev !== file.dev || info.size !== file.size) {
        throw Object.assign(new Error("打包文件已改变"), { statusCode: 400 });
      }
      yield header;
      let at = 0;
      while (at < file.size) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, file.size - at));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, at);
        if (bytesRead === 0) throw Object.assign(new Error("打包文件已改变"), { statusCode: 400 });
        at += bytesRead;
        yield bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }
    const pad = (512 - (file.size % 512)) % 512;
    if (pad !== 0) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024);
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
