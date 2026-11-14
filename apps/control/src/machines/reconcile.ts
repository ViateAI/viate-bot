/** 期望状态。error 是对账发现无法自行恢复后写入的，不由调用方直接设置。 */
export type DesiredState = "running" | "stopped" | "deleted";

export type ActualState = "missing" | "stopped" | "running";

export interface ReconcileObservation {
  desired: DesiredState;
  actual: ActualState;
  /** machined 连续心跳失败次数。容器不在运行时无意义。 */
  heartbeatFailures: number;
  /** 连续重启失败次数。 */
  restartFailures: number;
  /** stopped 且容器仍在运行时，等待任务结束已经用掉的秒数。 */
  stopWaitedSec: number;
}

export type ReconcileAction =
  | { type: "create" }
  | { type: "start" }
  | { type: "restart" }
  | { type: "mark-error" }
  | { type: "stop" }
  | { type: "wait-stop" }
  | { type: "delete" }
  | { type: "none" };

const HEARTBEAT_FAILURES_BEFORE_RESTART = 3;
const RESTART_FAILURES_BEFORE_ERROR = 3;
const STOP_WAIT_SEC = 60;

/** 第 6.6 节对账表。纯函数，不碰 Docker。 */
export function decideReconcile(observation: ReconcileObservation): ReconcileAction {
  const { desired, actual } = observation;
  if (desired === "deleted") return actual === "missing" ? { type: "none" } : { type: "delete" };
  if (desired === "stopped") {
    if (actual !== "running") return { type: "none" };
    return observation.stopWaitedSec >= STOP_WAIT_SEC ? { type: "stop" } : { type: "wait-stop" };
  }
  if (actual === "missing") return { type: "create" };
  if (actual === "stopped") return { type: "start" };
  if (observation.restartFailures >= RESTART_FAILURES_BEFORE_ERROR) return { type: "mark-error" };
  if (observation.heartbeatFailures >= HEARTBEAT_FAILURES_BEFORE_RESTART) return { type: "restart" };
  return { type: "none" };
}

export interface IdleInput {
  now: Date;
  /** 有运行中或等待中的任务。由任务模块提供，第一步用占位实现。 */
  hasActiveTask: boolean;
  /** 有人打开屏幕或终端。由会话模块提供，第一步用占位实现。 */
  hasAttachedViewer: boolean;
  /** 最近 15 分钟内有要执行的定时任务。由定时任务模块提供，第一步用占位实现。 */
  hasRoutineSoon: boolean;
  idleSince: Date | null;
  idleStopMinutes: number;
}

export interface WakeInput {
  reason: "message" | "panel" | "routine";
  /** 定时任务距离执行的分钟数。非 routine 原因时忽略。 */
  routineInMinutes?: number;
}

export function shouldAutoSleep(input: IdleInput): boolean {
  if (input.hasActiveTask || input.hasAttachedViewer || input.hasRoutineSoon) return false;
  if (!input.idleSince) return false;
  const idleMs = input.now.getTime() - input.idleSince.getTime();
  return idleMs >= input.idleStopMinutes * 60_000;
}

export function shouldAutoWake(input: WakeInput): boolean {
  if (input.reason === "message" || input.reason === "panel") return true;
  return (input.routineInMinutes ?? Number.POSITIVE_INFINITY) <= 2;
}

/**
 * 任务、屏幕和定时任务还没实现。对账循环通过这个接口询问，
 * 现在的实现恒定返回“空闲且无人观看、没有即将执行的定时任务”。
 */
export interface ActivityProbe {
  hasActiveTask(userId: string): boolean;
  hasAttachedViewer(userId: string): boolean;
  hasRoutineSoon(userId: string): boolean;
}

export const idleActivityProbe: ActivityProbe = {
  hasActiveTask: () => false,
  hasAttachedViewer: () => false,
  hasRoutineSoon: () => false,
};
