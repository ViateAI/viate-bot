import type { AdminScope, UserScope } from "../scope.js";
import {
  ROUTINE_PUNCTUALITY_WINDOW_MS,
  routineOutcome,
  type RoutineOutcome,
} from "../routines/punctuality.js";
import type { AppDatabase } from "./index.js";

export interface RoutinePunctuality {
  planned: number;
  onTime: number;
  late: number;
  missed: number;
  skipped: number;
  /** onTime / (onTime + late + missed)。没有可计入的执行时为 null，跳过不进分母。 */
  onTimeRate: number | null;
}

interface RunRow {
  state: string;
  scheduledAt: string;
  startedAt: string | null;
}

/** 只读运行元数据。不返回提示词、错误原文或任务正文。用户范围只看该用户的 bot。 */
export function routineRunRepository(db: AppDatabase) {
  const sql = db.$client;
  const query = `
    select rr.state as state, rr.scheduled_at as scheduledAt, t.started_at as startedAt
    from routine_runs rr
    join routines r on r.id = rr.routine_id
    join bots b on b.id = r.bot_id
    left join tasks t on t.id = rr.task_id
    where rr.source = 'schedule' and rr.scheduled_at >= ? and rr.scheduled_at <= ?`;
  return {
    punctuality(scope: UserScope | AdminScope, now: Date, windowMs = ROUTINE_PUNCTUALITY_WINDOW_MS): RoutinePunctuality {
      const since = new Date(now.getTime() - windowMs).toISOString();
      const until = now.toISOString();
      const rows = scope.kind === "user"
        ? sql.prepare(`${query} and b.user_id = ?`).all(since, until, scope.userId) as RunRow[]
        : sql.prepare(query).all(since, until) as RunRow[];
      const counts: Record<RoutineOutcome, number> = { on_time: 0, late: 0, missed: 0, skipped: 0, pending: 0 };
      for (const row of rows) counts[routineOutcome(row)] += 1;
      const eligible = counts.on_time + counts.late + counts.missed;
      return {
        planned: counts.on_time + counts.late + counts.missed + counts.skipped,
        onTime: counts.on_time,
        late: counts.late,
        missed: counts.missed,
        skipped: counts.skipped,
        onTimeRate: eligible === 0 ? null : counts.on_time / eligible,
      };
    },
  };
}
