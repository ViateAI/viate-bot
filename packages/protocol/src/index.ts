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

/** POST /displays/:n/ensure — 屏幕分区或共用显示器。n 是 bot 的 display_no。 */
export interface DisplayEnsureRequest {
  width: number;
  height: number;
}

export interface DisplayEnsureResponse {
  display: number;
  /** shared：全部 bot 共用一块屏幕。tiled：同一 Xvfb 上按区域裁剪。 */
  mode: "shared" | "tiled";
  clip: { x: number; y: number; width: number; height: number };
}

/** POST /displays/:n/input — 坐标相对该 bot 的 clip，不是整块帧缓冲。 */
export type DisplayInput =
  | { type: "key"; key: string; down: boolean }
  | { type: "text"; text: string }
  | { type: "mouse"; x: number; y: number; button: 0 | 1 | 2; action: "move" | "down" | "up" }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number };

export interface DisplayScreenshotResponse {
  mime: "image/png";
  /** base64，不进入管理端指标。 */
  pngBase64: string;
  width: number;
  height: number;
}

export interface SkillListEntry {
  name: string;
  description: string;
}

export interface SkillListResponse {
  skills: SkillListEntry[];
}

export interface SkillReadResponse {
  name: string;
  content: string;
  truncated: boolean;
}

export interface AppArchiveResponse {
  name: string;
  version: string;
  sha256: string;
  bytes: number;
}

export interface AppInstallRequest {
  name: string;
  version: string;
  sha256: string;
}

export interface AppInstallResponse {
  name: string;
  version: string;
  state: "installed";
}

export interface AppListEntry {
  name: string;
  version: string | null;
  state: "installed" | "absent";
}

export interface AppListResponse {
  apps: AppListEntry[];
}

/** 控制面注入的环境变量。敏感值只出现在这里，不写进包内文件。 */
export interface McpStdioStartRequest {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpRemoteStartRequest {
  url: string;
  headers?: Record<string, string>;
}

export interface McpStartResponse {
  server: string;
  running: true;
}
