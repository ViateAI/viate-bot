/**
 * 运维事件名。attrs 只能有 id、状态、工具名、计数和错误类别。
 * 不许写入对话正文、提示词、截图、密钥、配置值或命令输出。
 */
export const M2_EVENTS = {
  taskFinished: "task.finished",
  taskFailed: "task.failed",
  taskCancelled: "task.cancelled",
  approvalDecided: "approval.decided",
  takeoverRequested: "takeover.requested",
  takeoverActive: "takeover.active",
  takeoverReleased: "takeover.released",
  takeoverRevoked: "takeover.revoked",
  screenAttached: "screen.attached",
  screenDetached: "screen.detached",
  routineFired: "routine.fired",
  routineSkipped: "routine.skipped",
  routineFailed: "routine.failed",
  appInstalled: "app.installed",
  appInstallFailed: "app.install_failed",
  appUninstalled: "app.uninstalled",
  appPushed: "app.pushed",
  appPublishReviewed: "app.publish_reviewed",
  secretFormUsed: "secret.form_used",
  machineState: "machine.state",
} as const;

export type M2EventType = (typeof M2_EVENTS)[keyof typeof M2_EVENTS];

/** 终端事件只记类别，不记错误原文。原文可能含命令、路径或密钥。 */
export function terminalErrorClass(error: string | null): string {
  const text = error ?? "";
  if (/timeout|timed out|超时/i.test(text)) return "timeout";
  if (/rate.?limit|429|过于频繁/i.test(text)) return "rate_limit";
  if (text.includes("审批")) return "approval";
  if (text.includes("接管")) return "takeover";
  return text.length === 0 ? "unknown" : "error";
}

export const AUDIT_ACTIONS = {
  approvalDecided: "approval.decided",
  takeover: "takeover",
  secretForm: "secret.form",
  secretSavedFromMachine: "secret.saved_from_machine",
  secretLinkApp: "secret.link_app",
  appInstall: "app.install",
  /** bot 发起的安装。attrs 只有来源、版本、bot、任务和审批人，没有配置值。 */
  appInstallByBot: "app_install",
  appUninstall: "app.uninstall",
  appPublish: "app.publish",
  appPush: "app.push",
  appRetire: "app.retire",
  appImportant: "app.important",
  appPublishReview: "app.publish_review",
  machineLifecycle: "machine.lifecycle",
  routineChange: "routine.change",
} as const;
