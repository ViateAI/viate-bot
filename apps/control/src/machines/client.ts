import type {
  ExecEvent,
  FsListResponse,
  FsReadResponse,
  FsSearchResponse,
  FsWriteResponse,
  MachineEndpoint,
} from "@viate-bot/protocol";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface ExecInput {
  cmd: string;
  cwd?: string;
  timeoutSec?: number;
  signal?: AbortSignal;
}

/** 只连创建时绑定的那一台机器。调用方没有“换一台”的参数。 */
export class MachinedClient {
  constructor(
    private readonly endpoint: MachineEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async exec(input: ExecInput): Promise<ExecResult> {
    const response = await this.post("/exec", {
      cmd: input.cmd,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {}),
    }, input.signal);
    if (!response.ok) throw new Error(await readError(response));
    if (!response.body) throw new Error("exec 没有返回内容");
    let stdout = "";
    let stderr = "";
    let code: number | null = null;
    let signal: string | null = null;
    let timedOut = false;
    let sawExit = false;
    for await (const event of readSse(response.body)) {
      const parsed = JSON.parse(event) as ExecEvent;
      if (parsed.type === "stdout") stdout += parsed.data;
      else if (parsed.type === "stderr") stderr += parsed.data;
      else if (parsed.type === "truncated") {
        const note = `\n…[省略 ${parsed.droppedBytes} 字节]…\n`;
        if (parsed.stream === "stdout") stdout += note;
        else stderr += note;
      } else if (parsed.type === "exit") {
        code = parsed.code;
        signal = parsed.signal;
        timedOut = parsed.timedOut;
        sawExit = true;
      }
    }
    if (!sawExit) throw new Error("exec 流在结束前断开了");
    return { stdout, stderr, code, signal, timedOut };
  }

  async read(path: string, maxBytes: number, signal?: AbortSignal): Promise<FsReadResponse> {
    const response = await this.post("/fs/read", { path, maxBytes }, signal);
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as FsReadResponse;
  }

  async write(path: string, content: string, signal?: AbortSignal): Promise<FsWriteResponse> {
    const response = await this.post("/fs/write", { path, content }, signal);
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as FsWriteResponse;
  }

  async list(path: string, signal?: AbortSignal): Promise<FsListResponse> {
    const response = await this.post("/fs/list", { path }, signal);
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as FsListResponse;
  }

  async search(path: string, pattern: string, maxResults: number, signal?: AbortSignal): Promise<FsSearchResponse> {
    const response = await this.post("/fs/search", { path, pattern, maxResults }, signal);
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as FsSearchResponse;
  }

  private post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.endpoint.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  private url(path: string): string {
    return `http://${this.endpoint.host}:${this.endpoint.port}${path}`;
  }
}

export async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error === "object" && "message" in body.error) {
      const message = (body.error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // 不是 JSON 就用原文。
  }
  return text || `HTTP ${response.status}`;
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const data = sseData(part);
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sseData(part: string): string | undefined {
  const lines = part
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}
