import type { AppDatabase } from "../db/index.js";
import { chatRepository } from "../db/chat.js";
import { emitOps, opsMinutes } from "../ops/rollup.js";
import { auditRepository } from "../db/audit.js";
import { settingsRepository } from "../db/settings.js";
import { ulid } from "../id.js";
import { AUDIT_ACTIONS, M2_EVENTS } from "../m2/events.js";
import { adminScope } from "../scope.js";
import { ROUTINE_LOOP_SEEN_KEY, ROUTINE_ON_TIME_MS, slotCoveredByLoop } from "./punctuality.js";
import { nextCron, parseCron } from "./cron.js";

type Routine = { id: string; botId: string; userId: string; cron: string; timezone: string; prompt: string; enabled: number; state: string; nextRunAt: string | null; createdAt: string };
export type RoutineWork = { routineId: string; runId: string; botId: string; userId: string; prompt: string; scheduledAt: string; missedCount: number };
export type RoutineDeps = {
  userStatus: (userId: string) => Promise<string> | string;
  systemBotBusy?: (botId: string) => boolean;
  /** user_network 且 pause 且桌面客户端不在线。 */
  egressPaused?: (userId: string) => boolean;
};
const selection = `select r.id, r.bot_id as botId, b.user_id as userId, r.cron, r.timezone, r.prompt, r.enabled, r.state, r.next_run_at as nextRunAt, r.created_at as createdAt from routines r join bots b on b.id=r.bot_id`;

export class RoutineError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export function routineService(db: AppDatabase) {
  const sql = db.$client;
  const audit = (userId: string, id: string, state: string) => auditRepository(db).write(adminScope(userId), AUDIT_ACTIONS.routineChange, id, { state });
  const find = (userId: string, id: string) => sql.prepare(`${selection} where r.id=? and b.user_id=? and b.deleted_at is null`).get(id, userId) as Routine | undefined;
  return {
    list(userId: string, botId: string): Routine[] | undefined {
      if (!sql.prepare("select 1 from bots where id=? and user_id=? and deleted_at is null").get(botId, userId)) return undefined;
      return sql.prepare(`${selection} where r.bot_id=? and b.user_id=? and r.state!='deleted' order by r.created_at desc`).all(botId, userId) as Routine[];
    },
    propose(userId: string, botId: string, input: { cron: string; timezone: string; prompt: string }, now = new Date()): string {
      if (!sql.prepare("select 1 from bots where id=? and user_id=? and deleted_at is null").get(botId, userId)) throw new RoutineError("找不到 bot", 404);
      if (!input.prompt.trim()) throw new RoutineError("需要提示词", 400);
      const id = ulid();
      sql.prepare("insert into routines (id,bot_id,cron,timezone,prompt,enabled,state,next_run_at,created_at) values (?,?,?,?,?,0,'draft',null,?)").run(id, botId, input.cron, input.timezone, input.prompt, now.toISOString());
      audit(userId, id, "draft");
      return id;
    },
    confirm(userId: string, id: string, now = new Date()): void {
      sql.transaction(() => {
        const row = find(userId, id);
        if (!row || row.state !== "draft") throw new RoutineError("找不到草稿", 404);
        let next: string;
        try { next = nextCron(row.cron, row.timezone, now).toISOString(); } catch { throw new RoutineError("无效的 cron 或时区", 400); }
        const quota = sql.prepare("select max_routines as max from quotas where user_id=?").get(userId) as { max: number } | undefined;
        const count = sql.prepare("select count(*) as n from routines r join bots b on b.id=r.bot_id where b.user_id=? and r.state='active'").get(userId) as { n: number };
        if (!quota || count.n >= quota.max) throw new RoutineError("定时任务已达到配额", 409);
        sql.prepare("update routines set state='active',enabled=1,next_run_at=? where id=?").run(next, id);
        audit(userId, id, "active");
      })();
    },
    pause(userId: string, id: string, paused: boolean, now = new Date()): void {
      const row = find(userId, id);
      if (!row || row.state !== "active") throw new RoutineError("找不到定时任务", 404);
      const next = paused ? row.nextRunAt : nextCron(row.cron, row.timezone, now).toISOString();
      sql.prepare("update routines set enabled=?,next_run_at=? where id=?").run(paused ? 0 : 1, next, id);
      audit(userId, id, paused ? "paused" : "active");
    },
    remove(userId: string, id: string): void {
      const row = find(userId, id);
      if (!row || row.state === "deleted") throw new RoutineError("找不到定时任务", 404);
      sql.prepare("update routines set state='deleted',enabled=0,next_run_at=null where id=?").run(id);
      audit(userId, id, "deleted");
    },
    history(userId: string, id: string) {
      if (!find(userId, id)) throw new RoutineError("找不到定时任务", 404);
      return sql.prepare("select id, task_id as taskId, scheduled_at as scheduledAt, state, error from routine_runs where routine_id=? order by scheduled_at desc").all(id);
    },
    manual(userId: string, id: string, now = new Date()): RoutineWork {
      const row = find(userId, id);
      if (!row || row.state !== "active") throw new RoutineError("找不到定时任务", 404);
      const scheduledAt = now.toISOString();
      const runId = ulid();
      try { sql.prepare("insert into routine_runs (id,routine_id,scheduled_at,state,source) values (?,?,?,'claimed','manual')").run(runId, id, scheduledAt); }
      catch (error) { if (error instanceof Error && error.message.includes("UNIQUE")) throw new RoutineError("该时间已触发", 409); throw error; }
      return { routineId: id, runId, botId: row.botId, userId, prompt: row.prompt, scheduledAt, missedCount: 1 };
    },
    attachTask(runId: string, taskId: string): boolean {
      return sql.prepare("update routine_runs set task_id=? where id=? and state='claimed' and (task_id is null or task_id=?)").run(taskId, runId, taskId).changes === 1;
    },
  };
}

export async function claimDue(db: AppDatabase, now: Date, deps: RoutineDeps): Promise<RoutineWork[]> {
  const sql = db.$client;
  sql.prepare("update routine_runs set task_id=(select t.id from tasks t where t.routine_run_id=routine_runs.id limit 1) where state='claimed' and task_id is null and exists(select 1 from tasks t where t.routine_run_id=routine_runs.id)").run();
  const seenAt = readLoopSeen(db);
  const insertRun = sql.prepare("insert into routine_runs (id,routine_id,scheduled_at,state,error,source) values (?,?,?,?,?,'schedule') on conflict(routine_id,scheduled_at) do nothing");
  const advance = sql.prepare("update routines set next_run_at=? where id=? and state='active' and enabled=1 and next_run_at=?");
  const busy = deps.systemBotBusy ?? ((botId: string) => chatRepository(db).systemBotBusy(botId));
  const pending = sql.prepare(`${selection} where r.state='active' and (exists(select 1 from routine_runs rr where rr.routine_id=r.id and rr.state='claimed' and rr.task_id is null) or (r.enabled=1 and r.next_run_at<=?)) and b.deleted_at is null`).all(now.toISOString()) as Routine[];
  const work: RoutineWork[] = [];
  const reserved = new Set<string>();
  for (const row of pending) {
    if (reserved.has(row.botId) || busy(row.botId)) continue;
    let status: string;
    try { status = await deps.userStatus(row.userId); } catch { status = "unknown"; }
    if (status !== "active" && status !== "disabled") {
      closeUncovered(sql, insertRun, advance, row, now, seenAt);
      continue;
    }
    const offline = status === "active" && deps.egressPaused?.(row.userId) === true;
    const skipReason = status === "disabled" ? "用户已停用" : offline ? "桌面客户端离线" : null;
    const outstanding = sql.prepare("select id,scheduled_at as scheduledAt from routine_runs where routine_id=? and state='claimed' and task_id is null order by scheduled_at limit 1").get(row.id) as { id: string; scheduledAt: string } | undefined;
    if (outstanding) {
      if (skipReason) {
        sql.prepare("update routine_runs set state='skipped',error=? where id=? and task_id is null").run(skipReason, outstanding.id);
        emitOps(db, opsMinutes, { id: ulid(), ts: now.toISOString(), userId: row.userId, botId: row.botId, type: M2_EVENTS.routineSkipped, attrs: { routineId: row.id, runId: outstanding.id } });
      } else {
        reserved.add(row.botId);
        work.push({ routineId: row.id, runId: outstanding.id, botId: row.botId, userId: row.userId, prompt: row.prompt, scheduledAt: outstanding.scheduledAt, missedCount: 1 });
      }
      continue;
    }
    if (!row.enabled || !row.nextRunAt || row.nextRunAt > now.toISOString()) continue;
    const slots = dueSlots(row.cron, row.timezone, row.nextRunAt, now);
    if (slots.length === 0 || !row.nextRunAt) continue;
    const latest = slots[slots.length - 1]!;
    const next = nextCron(row.cron, row.timezone, new Date(latest)).toISOString();
    if (skipReason) {
      const runId = ulid();
      const saved = sql.transaction(() => {
        if (advance.run(next, row.id, row.nextRunAt).changes !== 1) return false;
        for (const slot of slots) insertRun.run(slot === latest ? runId : ulid(), row.id, slot, "skipped", skipReason);
        return true;
      })();
      if (saved) emitOps(db, opsMinutes, { id: ulid(), ts: now.toISOString(), userId: row.userId, botId: row.botId, type: M2_EVENTS.routineSkipped, attrs: { routineId: row.id, runId } });
      continue;
    }
    const earlier = slots.slice(0, -1);
    const runId = ulid();
    const inserted = sql.transaction(() => {
      if (advance.run(next, row.id, row.nextRunAt).changes !== 1) return false;
      for (const slot of earlier) insertRun.run(ulid(), row.id, slot, "missed", null);
      return insertRun.run(runId, row.id, latest, "claimed", null).changes === 1;
    })();
    if (!inserted) continue;
    emitOps(db, opsMinutes, { id: ulid(), ts: now.toISOString(), userId: row.userId, botId: row.botId, type: M2_EVENTS.routineFired, attrs: { routineId: row.id, runId, missedCount: earlier.length } });
    reserved.add(row.botId);
    work.push({ routineId: row.id, runId, botId: row.botId, userId: row.userId, prompt: row.prompt, scheduledAt: latest, missedCount: earlier.length });
  }
  settingsRepository(db).setJson(ROUTINE_LOOP_SEEN_KEY, now.toISOString());
  return work;
}

function readLoopSeen(db: AppDatabase): number | null {
  const value = settingsRepository(db).getJson(ROUTINE_LOOP_SEEN_KEY);
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dueSlots(cron: string, timezone: string, nextRunAt: string, now: Date): string[] {
  const matches = parseCron(cron, timezone);
  const slots: string[] = [];
  let cursor = new Date(nextRunAt).getTime();
  const end = now.getTime();
  if (Number.isNaN(cursor) || cursor > end) return slots;
  slots.push(new Date(cursor).toISOString());
  while ((cursor += 60_000) <= end) if (matches(new Date(cursor))) slots.push(new Date(cursor).toISOString());
  return slots;
}

function closeUncovered(
  sql: AppDatabase["$client"],
  insertRun: { run: (...args: unknown[]) => { changes: number } },
  advance: { run: (...args: unknown[]) => { changes: number } },
  row: Routine,
  now: Date,
  seenAt: number | null,
): void {
  const outstanding = sql.prepare("select id, scheduled_at as scheduledAt from routine_runs where routine_id=? and state='claimed' and task_id is null order by scheduled_at limit 1").get(row.id) as { id: string; scheduledAt: string } | undefined;
  if (outstanding) {
    const scheduledMs = Date.parse(outstanding.scheduledAt);
    if (scheduledMs + ROUTINE_ON_TIME_MS < now.getTime()) {
      const covered = slotCoveredByLoop(seenAt, scheduledMs);
      sql.prepare("update routine_runs set state=?, error=? where id=? and task_id is null").run(covered ? "skipped" : "missed", covered ? "上游不可用" : null, outstanding.id);
    }
  }
  if (!row.enabled || !row.nextRunAt || row.nextRunAt > now.toISOString()) return;
  const slots = dueSlots(row.cron, row.timezone, row.nextRunAt, now);
  const openAt = slots.findIndex((slot) => Date.parse(slot) + ROUTINE_ON_TIME_MS >= now.getTime());
  const closed = openAt === -1 ? slots : slots.slice(0, openAt);
  if (closed.length === 0) return;
  const resume = openAt === -1 ? nextCron(row.cron, row.timezone, new Date(closed[closed.length - 1]!)).toISOString() : slots[openAt]!;
  sql.transaction(() => {
    if (advance.run(resume, row.id, row.nextRunAt).changes !== 1) return;
    for (const slot of closed) {
      const covered = slotCoveredByLoop(seenAt, Date.parse(slot));
      insertRun.run(ulid(), row.id, slot, covered ? "skipped" : "missed", covered ? "上游不可用" : null);
    }
  })();
}

export function usersToWake(db: AppDatabase, now: Date): string[] {
  return (db.$client.prepare("select distinct b.user_id as id from routines r join bots b on b.id=r.bot_id where r.state='active' and r.enabled=1 and r.next_run_at<=? and b.deleted_at is null").all(new Date(now.getTime() + 120_000).toISOString()) as { id: string }[]).map((row) => row.id);
}

export function hasRoutineSoon(db: AppDatabase, userId: string, now: Date): boolean {
  return !!db.$client.prepare("select 1 from routines r join bots b on b.id=r.bot_id where b.user_id=? and b.deleted_at is null and r.state='active' and ((r.enabled=1 and r.next_run_at<=?) or exists(select 1 from routine_runs rr where rr.routine_id=r.id and rr.state='claimed')) limit 1").get(userId, new Date(now.getTime() + 900_000).toISOString());
}

const dispatching = new WeakSet<AppDatabase>();

export async function dispatchDue(db: AppDatabase, now: Date, deps: RoutineDeps & { enqueue: (work: RoutineWork) => Promise<string> | string }): Promise<RoutineWork[]> {
  if (dispatching.has(db)) return [];
  dispatching.add(db);
  try {
    const work = await claimDue(db, now, deps);
    for (const item of work) {
      const taskId = await deps.enqueue(item);
      if (!routineService(db).attachTask(item.runId, taskId)) throw new Error("定时任务运行已关联任务");
    }
    return work;
  } finally {
    dispatching.delete(db);
  }
}
