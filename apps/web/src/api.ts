let csrf = "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function rememberCsrf(token: string): void {
  csrf = token;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const method = init.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && csrf) headers.set("x-vb-csrf", csrf);
  const response = await fetch(path, { ...init, method, headers, credentials: "same-origin" });
  if (response.status === 401) {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
    throw new ApiError("未登录", 401);
  }
  const text = await response.text();
  const body = text ? (JSON.parse(text) as { error?: string }) : {};
  if (!response.ok) throw new ApiError(typeof body.error === "string" ? body.error : "请求失败", response.status);
  return body as T;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  provisioned: boolean;
  csrf: string;
}

export interface MemoryItem {
  id: string;
  content: string;
  updatedAt: string;
}

export interface Bot {
  id: string;
  name: string;
  bio: string;
  avatar: string | null;
  model: string;
  instructions: string;
}

export interface Conversation {
  id: string;
  botId: string;
  title: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  text: string;
  taskId: string | null;
  createdAt: string;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  toolName?: string;
  isError?: boolean;
}

export interface Task {
  id: string;
  state: string;
  error: string | null;
  conversationId: string | null;
  remoteUncertain?: boolean;
}

export interface Step {
  id: string;
  seq: number;
  kind: string;
  status: string;
  request: unknown;
  response: unknown;
}

export function taskLabel(state: string, machine: "starting" | "ready" | "idle", error?: string | null): string {
  if (error === "remote_unconfirmed") return "本地等待已结束，远端未确认";
  if (machine === "starting" && (state === "queued" || state === "running")) return "机器启动中";
  switch (state) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "waiting_approval":
      return "等待批准";
    case "waiting_takeover":
      return "等待接管";
    case "waiting_input":
      return "等待输入";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "本地已停止";
    case "interrupted":
      return "已中断";
    default:
      return "空闲";
  }
}
