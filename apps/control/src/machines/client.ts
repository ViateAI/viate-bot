import type {
  DisplayEnsureResponse,
  DisplayInput,
  DisplayScreenshotResponse,
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
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** 只连创建时绑定的那一台机器。调用方没有“换一台”的参数。 */
export class MachinedClient {
  constructor(
    private readonly endpoint: MachineEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async exec(input: ExecInput): Promise<ExecResult> {
    const controller = new AbortController();
    let stopConfirmed = false;
    let stopping: Promise<void> | undefined;
    let execId: string | null = null;
    let rejected = false;
    // 响应头到达前没有 exec id，调用方的 abort 只能断开这次 POST。
    // 有 id 之后先等 /exec/cancel，再断开，避免把未确认的停止当成已取消。
    const stop = () => {
      if (!execId) {
        controller.abort();
        return;
      }
      stopping ??= this.acknowledgeExecStop(execId).then(() => {
        stopConfirmed = true;
      }).finally(() => controller.abort());
    };
    if (input.signal?.aborted) stop();
    else input.signal?.addEventListener("abort", stop, { once: true });
    try {
      const response = await this.post("/exec", {
        cmd: input.cmd,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
      }, controller.signal);
      if (!response.ok) {
        rejected = true;
        throw new Error(await readError(response));
      }
      if (!response.body) throw new Error("exec 没有返回内容");
      execId = response.headers.get("x-exec-id");
      if (input.signal?.aborted) stop();
      const result = await readExecBody(response);
      if (stopping) await stopping.catch(() => undefined);
      if (input.signal?.aborted) throw new Error(stopConfirmed ? "exec 已取消" : "remote_unconfirmed");
      return result;
    } catch (error) {
      if (!stopping && input.signal?.aborted) stop();
      if (stopping) await stopping.catch(() => undefined);
      if (input.signal?.aborted) throw new Error(stopConfirmed ? "exec 已取消" : "remote_unconfirmed");
      if (rejected) throw error;
      throw new Error("remote_unconfirmed", { cause: error });
    } finally {
      input.signal?.removeEventListener("abort", stop);
    }
  }

  private async acknowledgeExecStop(id: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.post("/exec/cancel", { id }, controller.signal);
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json() as { stopped?: unknown } | null;
      if (result?.stopped !== true) throw new Error("exec 停止未确认");
    } finally {
      clearTimeout(timer);
    }
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

  async removeFile(path: string, signal?: AbortSignal): Promise<{ path: string }> {
    const response = await this.post("/fs/delete", { path }, signal);
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as { path: string };
  }

  async ensureDisplay(display: number, signal?: AbortSignal): Promise<DisplayEnsureResponse> {
    const response = await this.post(`/displays/${display}`, { width: 1280, height: 720 }, signal);
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as DisplayEnsureResponse;
  }

  async displayInput(display: number, input: DisplayInput, signal?: AbortSignal): Promise<void> {
    const response = await this.post(`/displays/${display}/input`, input, signal);
    if (!response.ok) throw new Error(await readError(response));
  }

  async installApp(input: { name: string; version: string; sha256: string; archive: Buffer }, signal?: AbortSignal): Promise<Array<{ cron: string; timezone: string; prompt: string }>> {
    const query = new URLSearchParams({ name: input.name, version: input.version, sha256: input.sha256 });
    const response = await this.fetchImpl(`${this.url("/apps/install")}?${query}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.endpoint.token}`,
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array(input.archive),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(await readError(response));
    const body: unknown = await response.json();
    const listed = body && typeof body === "object" && "routines" in body ? body.routines : undefined;
    if (!Array.isArray(listed)) return [];
    return listed.filter((item): item is { cron: string; timezone: string; prompt: string } => {
      if (!item || typeof item !== "object") return false;
      const routine = item as { cron?: unknown; timezone?: unknown; prompt?: unknown };
      return typeof routine.cron === "string" && typeof routine.timezone === "string" && typeof routine.prompt === "string";
    });
  }

  async uninstallApp(name: string, signal?: AbortSignal): Promise<void> {
    const response = await this.post("/apps/uninstall", { name }, signal);
    if (!response.ok) throw new Error(await readError(response));
  }

  async inspectApp(name: string, signal?: AbortSignal): Promise<{ mcpServers: string[] }> {
    const response = await this.fetchImpl(this.url(`/apps/${encodeURIComponent(name)}`), {
      headers: { authorization: `Bearer ${this.endpoint.token}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(await readError(response));
    const body: unknown = await response.json();
    const listed = body && typeof body === "object" && "mcpServers" in body ? body.mcpServers : undefined;
    const mcpServers = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : [];
    return { mcpServers };
  }

  async displayShot(display: number, signal?: AbortSignal): Promise<DisplayScreenshotResponse> {
    const response = await this.post(`/displays/${display}/screenshot`, {}, signal);
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as DisplayScreenshotResponse;
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

async function readExecBody(response: Response): Promise<ExecResult> {
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
