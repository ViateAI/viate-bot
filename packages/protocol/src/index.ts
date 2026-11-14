/**
 * 控制面和 machined 之间的消息。
 * 应用代码、脚本和 MCP 连接都在用户机器里发生（设计第 7.3 节）。
 * 这里不描述“控制面去连接某个应用地址”：远程 MCP 由 machined 从机器内发起，
 * 控制面只接收工具定义和调用结果这类数据。
 */

/** machined 监听端口。只对控制面所在的 Docker 网络开放。 */
export const MACHINED_PORT = 7070;

/** 容器内 Chromium 远程调试端口。只绑定 127.0.0.1，不向容器外发布。 */
export const BROWSER_DEBUG_PORT = 9222;

/** GET /browser/status */
export interface BrowserStatusResponse {
  running: boolean;
  /** CDP /json/version 的 Browser 字段。未运行时为 null。 */
  version: string | null;
}

/** POST /browser/restart */
export interface BrowserRestartResponse {
  ok: true;
}

export interface HealthResponse {
  ok: true;
  version: string;
}

export interface MetricsResponse {
  cpuPct: number;
  memMb: number;
  diskMb: number;
  processCount: number;
}

export interface ExecRequest {
  /** 以 bot 用户执行的命令。通过 shell 解释，不经额外转义。 */
  cmd: string;
  cwd?: string;
  /** 超时秒数。缺省由 machined 取默认值。 */
  timeoutSec?: number;
  env?: Record<string, string>;
}

export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "truncated"; stream: "stdout" | "stderr"; droppedBytes: number }
  | { type: "exit"; code: number | null; signal: string | null; timedOut: boolean };

export interface FsReadRequest {
  path: string;
  /** 最多读取的字节数。缺省由 machined 取默认值。 */
  maxBytes?: number;
}

export interface FsReadResponse {
  path: string;
  content: string;
  truncated: boolean;
}

export interface FsWriteRequest {
  path: string;
  content: string;
  /** 缺省 0o644。 */
  mode?: number;
}

export interface FsWriteResponse {
  path: string;
  bytes: number;
}

export interface FsListRequest {
  path: string;
}

export interface FsEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
}

export interface FsListResponse {
  path: string;
  entries: FsEntry[];
}

export interface FsSearchRequest {
  path: string;
  /** ripgrep 正则。 */
  pattern: string;
  maxResults?: number;
}

export interface FsSearchHit {
  path: string;
  line: number;
  text: string;
}

export interface FsSearchResponse {
  hits: FsSearchHit[];
  truncated: boolean;
}

export interface ErrorResponse {
  error: string;
}

/** 控制面调用 machined 时使用的来源地址。开发模式下由控制面进程填入。 */
export interface MachineEndpoint {
  host: string;
  port: number;
  token: string;
}
