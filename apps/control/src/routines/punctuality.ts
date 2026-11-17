/** 计划时刻之后这么久内开始执行算按时。调度周期 30 秒，cron 粒度 1 分钟。 */
export const ROUTINE_ON_TIME_MS = 2 * 60 * 1000;

/** 控制面上次跑完一轮调度的时间。用来区分停机错过和在线时的上游跳过。 */
export const ROUTINE_LOOP_SEEN_KEY = "routine_loop_seen_at";

export const ROUTINE_PUNCTUALITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 计划时刻不晚于上次调度心跳，说明控制面那时是在跑的。没有心跳则视为停机。 */
export function slotCoveredByLoop(seenAtMs: number | null, scheduledMs: number): boolean {
  return seenAtMs !== null && scheduledMs <= seenAtMs;
}

export type RoutineOutcome = "on_time" | "late" | "missed" | "skipped" | "pending";

/** 已认领但还没有 started_at 的仍算进行中，不计入按时率。显式 missed/skipped 行才是已经结案的结果。 */
export function routineOutcome(row: { state: string; scheduledAt: string; startedAt: string | null }): RoutineOutcome {
  if (row.state === "skipped") return "skipped";
  if (row.state === "missed") return "missed";
  if (row.startedAt) {
    const delta = Date.parse(row.startedAt) - Date.parse(row.scheduledAt);
    return delta <= ROUTINE_ON_TIME_MS ? "on_time" : "late";
  }
  return "pending";
}
