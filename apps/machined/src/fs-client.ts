import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { FsEntry, FsSearchHit } from "@viate-bot/protocol";
import {
  fsFailure,
  listConfined,
  readConfined,
  readRaw,
  searchConfined,
  writeConfined,
  type FsReadResult,
  type FsWriteResult,
} from "./fs-ops.js";

const WORKER_BIN = process.env.VB_FS_WORKER_BIN || "/opt/viate/fs-worker.mjs";

interface RpcOk {
  id: number;
  ok: true;
  read?: FsReadResult;
  write?: FsWriteResult;
  list?: { path: string; entries: FsEntry[] };
  search?: { hits: FsSearchHit[]; truncated: boolean };
  file?: string;
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
  op: "read" | "write" | "list" | "search" | "readFile" | "writeFile";
  path: string;
  maxBytes?: number;
  content?: string;
  mode?: number;
  pattern?: string;
  maxResults?: number;
  data?: string;
}

export interface FsClient {
  read(path: string, maxBytes: number): Promise<FsReadResult>;
  write(path: string, content: Buffer, mode: number): Promise<FsWriteResult>;
  list(path: string): Promise<{ path: string; entries: FsEntry[] }>;
  search(path: string, pattern: string, maxResults: number): Promise<{ hits: FsSearchHit[]; truncated: boolean }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<FsWriteResult>;
}

/** root 时把文件操作交给降权子进程；测试和非 root 进程就地执行。 */
export function createFsClient(): FsClient {
  if (process.getuid?.() === 0) return new WorkerFs();
  return new LocalFs();
}

class LocalFs implements FsClient {
  read(path: string, maxBytes: number): Promise<FsReadResult> {
    return settle(readConfined(path, maxBytes));
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
    this.child = spawn(process.execPath, [WORKER_BIN], {
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

  read(path: string, maxBytes: number): Promise<FsReadResult> {
    return this.call({ op: "read", path, maxBytes }).then((response) => {
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
