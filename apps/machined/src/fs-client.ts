import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough, type Readable, type Writable } from "node:stream";
import type { FsEntry, FsSearchHit } from "@viate-bot/protocol";
import {
  deleteConfined,
  fsFailure,
  listConfined,
  packConfined,
  readConfined,
  readRaw,
  searchConfined,
  streamUpload,
  writeConfined,
  type FsReadResult,
  type FsWriteResult,
} from "./fs-ops.js";

function workerBin(): string {
  return process.env.VB_FS_WORKER_BIN || "/opt/viate/fs-worker.mjs";
}

interface RpcOk {
  id: number;
  ok: true;
  read?: FsReadResult;
  write?: FsWriteResult;
  list?: { path: string; entries: FsEntry[] };
  search?: { hits: FsSearchHit[]; truncated: boolean };
  file?: string;
  delete?: { path: string };
}

interface RpcFail {
  id: number;
  ok: false;
  error: string;
  name: string;
  statusCode: number;
}

type RpcResponse = RpcOk | RpcFail;

interface RpcRequest {
  id: number;
  op: "read" | "write" | "list" | "search" | "readFile" | "writeFile" | "delete";
  path: string;
  maxBytes?: number;
  content?: string;
  mode?: number;
  pattern?: string;
  maxResults?: number;
  data?: string;
  encoding?: "utf8" | "base64";
}

export interface FsClient {
  read(path: string, maxBytes: number, encoding?: "utf8" | "base64"): Promise<FsReadResult>;
  write(path: string, content: Buffer, mode: number): Promise<FsWriteResult>;
  list(path: string): Promise<{ path: string; entries: FsEntry[] }>;
  search(path: string, pattern: string, maxResults: number): Promise<{ hits: FsSearchHit[]; truncated: boolean }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<FsWriteResult>;
  upload(path: string, source: Readable, maxBytes: number, deliveryId: string): Promise<{ path: string; bytes: number; sha256: string }>;
  delete(path: string): Promise<{ path: string }>;
  pack(path: string): Promise<Readable>;
}

/** root 时把文件操作交给降权子进程；测试和非 root 进程就地执行。 */
export function createFsClient(): FsClient {
  if (process.getuid?.() === 0) return new WorkerFs();
  return new LocalFs();
}

/** 生产 root 走的同一条降权子进程。非 root 测试用它覆盖上传管道，不改 uid 选择。 */
export function createWorkerFsClient(): FsClient {
  return new WorkerFs();
}

class LocalFs implements FsClient {
  read(path: string, maxBytes: number, encoding?: "utf8" | "base64"): Promise<FsReadResult> {
    return settle(readConfined(path, maxBytes, encoding));
  }
  write(path: string, content: Buffer, mode: number): Promise<FsWriteResult> {
    return settle(writeConfined(path, content, mode));
  }
  list(path: string): Promise<{ path: string; entries: FsEntry[] }> {
    return settle(listConfined(path));
  }
  search(path: string, pattern: string, maxResults: number): Promise<{ hits: FsSearchHit[]; truncated: boolean }> {
    return settle(searchConfined(path, pattern, maxResults));
  }
  async readFile(path: string): Promise<Buffer> {
    const result = await settle(readRaw(path));
    return result.data;
  }
  writeFile(path: string, data: Buffer): Promise<FsWriteResult> {
    return settle(writeConfined(path, data, 0o644));
  }
  upload(path: string, source: Readable, maxBytes: number, deliveryId: string): Promise<{ path: string; bytes: number; sha256: string }> {
    return settle(streamUpload(path, source, maxBytes, deliveryId));
  }
  delete(path: string): Promise<{ path: string }> {
    return settle(deleteConfined(path));
  }
  pack(path: string): Promise<Readable> {
    return settle(packConfined(path));
  }
}

function settle<T>(work: Promise<T>): Promise<T> {
  return work.catch((error: unknown) => {
    throwFs(error);
  });
}

class WorkerFs implements FsClient {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: RpcOk) => void; reject: (error: Error) => void }>();

  constructor() {
    this.child = spawn(process.execPath, [workerBin()], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/home/bot",
        USER: "bot",
        LOGNAME: "bot",
        LANG: "C.UTF-8",
      },
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.take(line));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code) => this.failAll(new Error(`fs worker 退出 ${code ?? "null"}`)));
  }

  read(path: string, maxBytes: number, encoding?: "utf8" | "base64"): Promise<FsReadResult> {
    return this.call({ op: "read", path, maxBytes, ...(encoding ? { encoding } : {}) }).then((response) => {
      if (!response.read) throw new Error("fs worker 没有返回读取结果");
      return response.read;
    });
  }

  write(path: string, content: Buffer, mode: number): Promise<FsWriteResult> {
    return this.call({ op: "write", path, content: content.toString("base64"), mode }).then((response) => {
      if (!response.write) throw new Error("fs worker 没有返回写入结果");
      return response.write;
    });
  }

  list(path: string): Promise<{ path: string; entries: FsEntry[] }> {
    return this.call({ op: "list", path }).then((response) => {
      if (!response.list) throw new Error("fs worker 没有返回目录");
      return response.list;
    });
  }

  search(path: string, pattern: string, maxResults: number): Promise<{ hits: FsSearchHit[]; truncated: boolean }> {
    return this.call({ op: "search", path, pattern, maxResults }).then((response) => {
      if (!response.search) throw new Error("fs worker 没有返回搜索结果");
      return response.search;
    });
  }

  readFile(path: string): Promise<Buffer> {
    return this.call({ op: "readFile", path }).then((response) => {
      if (response.file === undefined) throw new Error("fs worker 没有返回文件");
      return Buffer.from(response.file, "base64");
    });
  }

  writeFile(path: string, data: Buffer): Promise<FsWriteResult> {
    return this.call({ op: "writeFile", path, data: data.toString("base64") }).then((response) => {
      if (!response.write) throw new Error("fs worker 没有返回写入结果");
      return response.write;
    });
  }

  upload(path: string, source: Readable, maxBytes: number, deliveryId: string): Promise<{ path: string; bytes: number; sha256: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerBin(), "--upload", path, String(maxBytes), deliveryId], {
        stdio: ["pipe", "pipe", "inherit"],
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: "/home/bot",
          USER: "bot",
          LOGNAME: "bot",
          LANG: "C.UTF-8",
        },
      });
      const chunks: Buffer[] = [];
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", fail);
      child.stdin.on("error", () => {
        source.unpipe(child.stdin);
      });
      source.on("error", (error) => {
        child.kill();
        fail(error);
      });
      source.pipe(child.stdin);
      child.on("exit", (code) => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: { ok?: boolean; path?: string; bytes?: number; sha256?: string; error?: string; statusCode?: number } = {};
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          fail(new Error(text || `upload failed ${code ?? "null"}`));
          return;
        }
        if (code !== 0 || body.ok !== true || body.path === undefined || body.bytes === undefined || body.sha256 === undefined) {
          fail(Object.assign(new Error(body.error || `upload failed ${code ?? "null"}`), { statusCode: body.statusCode ?? 500 }));
          return;
        }
        if (settled) return;
        settled = true;
        resolve({ path: body.path, bytes: body.bytes, sha256: body.sha256 });
      });
    });
  }

  delete(path: string): Promise<{ path: string }> {
    return this.call({ op: "delete", path }).then((response) => {
      if (!response.delete) throw new Error("fs worker 没有返回删除结果");
      return response.delete;
    });
  }

  pack(path: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [WORKER_BIN, "--pack", path], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: "/home/bot",
          USER: "bot",
          LOGNAME: "bot",
          LANG: "C.UTF-8",
        },
      });
      const out = new PassThrough({ highWaterMark: 64 * 1024 });
      let errorText = "";
      let delivered = false;
      child.stdout.pipe(out, { end: false });
      out.once("readable", () => { delivered = true; resolve(out); });
      out.once("close", () => { if (child.exitCode === null) child.kill(); });
      child.stderr.on("data", (chunk: Buffer) => { errorText = (errorText + chunk.toString("utf8")).slice(0, 4096); });
      const fail = (error: Error) => {
        if (delivered) out.destroy(error);
        else { out.destroy(); reject(error); }
      };
      child.on("error", fail);
      child.on("close", (code) => {
        if (code === 0) {
          if (!delivered) { delivered = true; resolve(out); }
          out.end();
          return;
        }
        fail(Object.assign(new Error(errorText.trim() || "打包失败"), { statusCode: 400 }));
      });
    });
  }

  private call(request: Omit<RpcRequest, "id">): Promise<RpcOk> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  private take(line: string): void {
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if (!parsed.ok) {
      const error = new Error(parsed.error);
      error.name = parsed.name;
      pending.reject(Object.assign(error, { statusCode: parsed.statusCode }));
      return;
    }
    pending.resolve(parsed);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function throwFs(error: unknown): never {
  const failure = fsFailure(error);
  const wrapped = new Error(failure.error);
  wrapped.name = failure.name;
  throw Object.assign(wrapped, { statusCode: failure.statusCode });
}
