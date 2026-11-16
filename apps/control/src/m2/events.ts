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
  secretFormUsed: "secret.form_used",
  machineState: "machine.state",
} as const;

export type M2EventType = (typeof M2_EVENTS)[keyof typeof M2_EVENTS];

export const AUDIT_ACTIONS = {
  approvalDecided: "approval.decided",
  takeover: "takeover",
  secretForm: "secret.form",
  appInstall: "app.install",
  appUninstall: "app.uninstall",
  appPublish: "app.publish",
  appPush: "app.push",
  appRetire: "app.retire",
  machineLifecycle: "machine.lifecycle",
  routineChange: "routine.change",
} as const;
