const PHRASES: Record<string, string> = {
  shell_exec: "正在执行命令",
  fs_read: "正在读取文件",
  fs_write: "正在写入文件",
  fs_list: "正在列出文件",
  fs_search: "正在搜索文件",
  desktop_screenshot: "正在截图",
  desktop_mouse: "正在操作桌面",
  desktop_key: "正在按键",
  desktop_type: "正在输入",
  memory_save: "正在保存记忆",
  memory_search: "正在搜索记忆",
  memory_delete: "正在删除记忆",
  request_secret: "正在请求密钥",
  request_takeover: "正在请求接管",
  install_mcp: "正在请求安装应用",
  propose_routine: "正在创建定时任务",
  search_apps: "正在搜索应用",
  update_bot_profile: "正在修改资料",
  propose_approval_rule: "正在提议自动审批规则",
  bulk_delete_action: "正在删除文件",
};

export interface ActivityInput {
  state: string;
  waitingRate?: boolean | undefined;
  stream: string;
  detail: boolean;
  elapsedMs: number;
  steps: Array<{ kind: string; status: string; request: unknown }>;
}

export function activityLine(input: ActivityInput): string | null {
  if (input.state !== "queued" && input.state !== "running") return null;
  if (input.state === "running" && input.waitingRate) return withElapsed("请求较多，等待中", input.elapsedMs);
  const tool = input.state === "running" ? runningTool(input.steps) : undefined;
  if (tool) return withElapsed(input.detail ? phrase(tool.request) : "正在操作", input.elapsedMs);
  if (input.stream.trim()) return null;
  if (input.state === "queued") return withElapsed("排队中", input.elapsedMs);
  return withElapsed("思考中", input.elapsedMs);
}

function runningTool(steps: ActivityInput["steps"]): ActivityInput["steps"][number] | undefined {
  let found: ActivityInput["steps"][number] | undefined;
  for (const step of steps) {
    if (step.kind === "tool" && step.status === "running") found = step;
  }
  return found;
}

function phrase(request: unknown): string {
  const name = request && typeof request === "object" && "name" in request && typeof request.name === "string" ? request.name : "";
  if (name.startsWith("browser_")) return "正在使用浏览器";
  return PHRASES[name] ?? "正在操作";
}

function withElapsed(label: string, elapsedMs: number): string {
  return `${label} · ${formatElapsed(elapsedMs)}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds === 0) return `${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}
