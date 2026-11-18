import { settingsRepository } from "./db/settings.js";
import { quotaRepository } from "./db/quotas.js";
import type { AppDatabase } from "./db/index.js";
import { userScope } from "./scope.js";

export interface ActiveRun {
  /** Completed running time. Waits and downtime are not included. */
  activeMs: number;
  /** Wall clock of the open running segment. Null while paused. */
  segmentStartedAt: number | null;
}

export function elapsedActiveMs(run: ActiveRun, nowMs: number): number {
  if (run.segmentStartedAt === null) return run.activeMs;
  return run.activeMs + Math.max(0, nowMs - run.segmentStartedAt);
}

/** Null when the cap is off. Otherwise the active milliseconds still left, never negative. */
export function remainingActiveMs(run: ActiveRun, nowMs: number, maxDurationSec: number): number | null {
  if (maxDurationSec <= 0) return null;
  return Math.max(0, maxDurationSec * 1000 - elapsedActiveMs(run, nowMs));
}

/**
 * Calls onLimit when active time reaches the cap.
 * A paused segment does not count, and 0 disables the watch.
 * The poll notices an injected clock jump; stop() ends it.
 */
export function watchActiveLimit(
  read: () => ActiveRun,
  now: () => number,
  maxDurationSec: number,
  onLimit: () => void,
): () => void {
  if (maxDurationSec <= 0) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const left = remainingActiveMs(read(), now(), maxDurationSec);
    if (left === null || stopped) return;
    if (left <= 0) {
      stopped = true;
      onLimit();
      return;
    }
    timer = setTimeout(arm, Math.min(left, 50));
    timer.unref?.();
  };
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Live clock wins. Otherwise the persisted active time, which does not include downtime. */
export function reportedElapsedMs(usageJson: string | null, live: ActiveRun | undefined, nowMs: number): number {
  if (live) return elapsedActiveMs(live, nowMs);
  if (!usageJson) return 0;
  try {
    const parsed = JSON.parse(usageJson) as { activeMs?: unknown };
    if (typeof parsed.activeMs === "number" && Number.isFinite(parsed.activeMs)) return Math.max(0, parsed.activeMs);
  } catch {
    return 0;
  }
  return 0;
}

export function pauseActive(run: ActiveRun, nowMs: number): ActiveRun {
  if (run.segmentStartedAt === null) return run;
  return { activeMs: elapsedActiveMs(run, nowMs), segmentStartedAt: null };
}

export function resumeActive(run: ActiveRun, nowMs: number): ActiveRun {
  if (run.segmentStartedAt !== null) return run;
  return { activeMs: run.activeMs, segmentStartedAt: nowMs };
}

/** Keep flushed running time and open a new segment. The gap since the last flush is not added. */
export function restoreActive(activeMs: number, nowMs: number): ActiveRun {
  return { activeMs, segmentStartedAt: nowMs };
}

export function formatActiveDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds === 0) return `${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function durationLimitText(activeMs: number): string {
  return `已运行 ${formatActiveDuration(activeMs)}，达到时长上限。回复“继续”可以接着做。`;
}

export function stepLimitText(used: number): string {
  return `已用 ${used} 步，达到步数上限。回复“继续”可以接着做。`;
}

export function isRunLimitError(error: string | null | undefined): boolean {
  if (!error) return false;
  return error.includes("达到时长上限") || error.includes("达到步数上限");
}

/** Latest task only. Detail-visibility does not hide this; callers render it beside the task error. */
export function showContinueButton(tasks: Array<{ state: string; error: string | null }>): boolean {
  const latest = tasks[0];
  return latest?.state === "failed" && isRunLimitError(latest.error);
}

export const TASK_MAX_STEPS_KEY = "task_max_steps";
export const TASK_MAX_DURATION_KEY = "task_max_duration_sec";

export class TaskLimitRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskLimitRejected";
  }
}

export function runLimitFailure(input: {
  modelCalls: number;
  activeMs: number;
  segmentStartedAt: number | null;
  nowMs: number;
  maxSteps: number;
  maxDurationSec: number;
}): string | undefined {
  if (input.maxSteps > 0 && input.modelCalls >= input.maxSteps) return stepLimitText(input.modelCalls);
  const elapsed = elapsedActiveMs(input, input.nowMs);
  if (input.maxDurationSec > 0 && elapsed >= input.maxDurationSec * 1000) return durationLimitText(elapsed);
  return undefined;
}

function parseLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

export function readGlobalTaskMaxSteps(db: AppDatabase): number | undefined {
  return parseLimit(settingsRepository(db).getJson(TASK_MAX_STEPS_KEY));
}

export function readGlobalTaskMaxDurationSec(db: AppDatabase): number | undefined {
  return parseLimit(settingsRepository(db).getJson(TASK_MAX_DURATION_KEY));
}

export function saveGlobalTaskMaxSteps(db: AppDatabase, value: number): number {
  const parsed = parseLimit(value);
  if (parsed === undefined) throw new TaskLimitRejected("步数上限必须是非负整数");
  settingsRepository(db).setJson(TASK_MAX_STEPS_KEY, parsed);
  return parsed;
}

export function saveGlobalTaskMaxDurationSec(db: AppDatabase, value: number): number {
  const parsed = parseLimit(value);
  if (parsed === undefined) throw new TaskLimitRejected("时长上限必须是非负整数");
  settingsRepository(db).setJson(TASK_MAX_DURATION_KEY, parsed);
  return parsed;
}

/** 用户覆盖优先（含 0=不限制）。没有覆盖时用全局设置，再没有用环境默认。 */
export function resolveTaskMaxSteps(db: AppDatabase, userId: string, envDefault: number): number {
  const quota = quotaRepository(db).find(userScope(userId));
  if (quota && quota.taskMaxSteps !== null) return quota.taskMaxSteps;
  return readGlobalTaskMaxSteps(db) ?? envDefault;
}

/** 用户覆盖优先（含 0=不限制）。没有覆盖时用全局设置，再没有用环境默认。 */
export function resolveTaskMaxDurationSec(db: AppDatabase, userId: string, envDefault: number): number {
  const quota = quotaRepository(db).find(userScope(userId));
  if (quota && quota.taskMaxDurationSec !== null) return quota.taskMaxDurationSec;
  return readGlobalTaskMaxDurationSec(db) ?? envDefault;
}
