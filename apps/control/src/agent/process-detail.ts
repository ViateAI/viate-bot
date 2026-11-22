import type { AppDatabase } from "../db/index.js";
import type { UserScope } from "../scope.js";
import type { MessageView, StepView, TaskView } from "./view.js";

const FULL_TOOLS = new Set(["request_secret", "request_takeover", "install_mcp"]);

const TOOL_LABELS: Record<string, string> = {
  shell_exec: "正在执行命令",
  fs_read: "正在读取文件",
  fs_write: "正在写入文件",
  fs_list: "正在列出文件",
  fs_search: "正在搜索文件",
  browser_open: "正在打开网页",
  browser_snapshot: "正在查看网页",
  browser_click: "正在点击",
  browser_type: "正在输入",
  browser_select: "正在选择",
  browser_scroll: "正在滚动",
  browser_wait: "正在等待页面",
  browser_screenshot: "正在截图",
  browser_tabs: "正在查看标签页",
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
  package_app: "正在打包应用",
  request_app_publish: "正在申请公开应用",
  update_bot_profile: "正在修改资料",
  propose_approval_rule: "正在提议自动审批规则",
  bulk_delete_action: "正在删除文件",
  send_file: "正在发送文件",
};

export function userShowsProcess(db: AppDatabase, scope: UserScope): boolean {
  const row = db.$client.prepare("select show_process as showProcess from users where id=?").get(scope.userId) as
    | { showProcess: number }
    | undefined;
  return row?.showProcess === 1;
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? "正在处理";
}

export function redactStep(step: StepView, detail: boolean): StepView {
  if (detail) return step;
  const request = record(step.request);
  const name = typeof request?.name === "string" ? request.name : "";
  if (FULL_TOOLS.has(name)) return { ...step, response: null };
  if (step.kind === "compact") {
    return { ...step, request: { label: "已压缩较早的上下文" }, response: null };
  }
  if (step.kind === "model") return { ...step, request: { label: "正在回复" }, response: null };
  if (step.kind === "mcp") return { ...step, request: { label: "应用工具当前不可用" }, response: null };
  return { ...step, request: { name, label: toolLabel(name) }, response: null };
}

export function redactMessages(messages: MessageView[], tasks: TaskView[], detail: boolean): MessageView[] {
  if (detail) return messages;
  const terminal = new Set(
    tasks.filter((task) => task.state === "succeeded" || task.state === "failed" || task.state === "cancelled" || task.state === "interrupted").map((task) => task.id),
  );
  const finalIds = new Set<string>();
  const byTask = new Map<string, MessageView[]>();
  for (const message of messages) {
    const key = message.taskId ?? "";
    const list = byTask.get(key) ?? [];
    list.push(message);
    byTask.set(key, list);
  }
  for (const [taskId, list] of byTask) {
    if (!terminal.has(taskId)) continue;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (message?.role === "assistant") {
        if (!message.toolCalls?.length) finalIds.add(message.id);
        break;
      }
    }
  }
  return messages.flatMap((message) => {
    if (message.role === "assistant" && (message.attachments?.length ?? 0) > 0) return [stripReasoning(message)];
    if (message.role === "user" || (message.role === "assistant" && message.taskId === null)) return [stripReasoning(message)];
    if (message.role === "assistant" && finalIds.has(message.id)) {
      const copy = stripReasoning(message);
      delete copy.toolCalls;
      return [copy];
    }
    return [];
  });
}

export function redactMessage(message: MessageView, messages: MessageView[], tasks: TaskView[], detail: boolean): MessageView | undefined {
  if (detail) return message;
  return redactMessages(messages, tasks, false).find((item) => item.id === message.id);
}

function stripReasoning(message: MessageView): MessageView {
  const copy: MessageView = { ...message };
  if (copy.toolCalls) copy.toolCalls = copy.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: {} }));
  return copy;
}

function record(value: unknown): { name?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as { name?: string };
}
