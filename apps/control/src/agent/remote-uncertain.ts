import { ulid } from "../id.js";
import { auditRepository } from "../db/audit.js";
import type { AppDatabase } from "../db/index.js";
import { adminScope } from "../scope.js";

const MARK = "mcp.remote_unconfirmed";
const ACCEPT = "mcp.remote_uncertain_accepted";

/** 停止只结束本地等待。这条记录挡住后续写操作和接管，直到用户单独确认。 */
export function markRemoteUncertain(db: AppDatabase, input: { userId: string; botId: string; taskId: string }): void {
  db.$client
    .prepare("insert into events (id, ts, user_id, bot_id, type, attrs_json) values (?,?,?,?,?,?)")
    .run(ulid(), new Date().toISOString(), input.userId, input.botId, MARK, JSON.stringify({ taskId: input.taskId }));
}

function openMark(db: AppDatabase, userId: string, taskId?: string): { rowid: number } | undefined {
  const taskClause = taskId === undefined ? "" : " and json_extract(m.attrs_json, '$.taskId') = ?";
  const params = taskId === undefined ? [userId, MARK, ACCEPT] : [userId, MARK, taskId, ACCEPT];
  return db.$client
    .prepare(
      `select m.rowid as rowid from events m
       where m.user_id = ? and m.type = ?${taskClause}
         and not exists (
           select 1 from events a
           where a.user_id = m.user_id and a.type = ? and a.rowid > m.rowid
             and json_extract(a.attrs_json, '$.taskId') = json_extract(m.attrs_json, '$.taskId')
         )
       limit 1`,
    )
    .get(...params) as { rowid: number } | undefined;
}

export function remoteUncertain(db: AppDatabase, userId: string): boolean {
  return openMark(db, userId) !== undefined;
}

/** 只接受这一条任务自己还没被确认的记录。不把别的任务一起放开。 */
export function acceptRemoteRisk(db: AppDatabase, userId: string, taskId: string): boolean {
  if (!openMark(db, userId, taskId)) return false;
  db.$client
    .prepare("insert into events (id, ts, user_id, type, attrs_json) values (?,?,?,?,?)")
    .run(ulid(), new Date().toISOString(), userId, ACCEPT, JSON.stringify({ taskId }));
  auditRepository(db).write(adminScope(userId), ACCEPT, taskId, { taskId });
  return true;
}
