import { and, asc, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "./index.js";
import { botMessages, bots, users } from "./schema.js";

export interface BotMessageRow {
  id: string;
  userId: string;
  fromBotId: string;
  toBotId: string;
  replyToId: string | null;
  originTaskId: string | null;
  hop: number;
  body: string;
  state: string;
  taskId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BotMessageDraft {
  id: string;
  userId: string;
  fromBotId: string;
  toBotId: string;
  replyToId?: string | null;
  originTaskId?: string | null;
  hop: number;
  body: string;
  state: string;
  createdAt: string;
}

export function insertBotMessage(db: AppDatabase, draft: BotMessageDraft): void {
  db.insert(botMessages)
    .values({
      id: draft.id,
      userId: draft.userId,
      fromBotId: draft.fromBotId,
      toBotId: draft.toBotId,
      replyToId: draft.replyToId ?? null,
      originTaskId: draft.originTaskId ?? null,
      hop: draft.hop,
      body: draft.body,
      state: draft.state,
      taskId: null,
      error: null,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    })
    .run();
}

export function findBotMessage(db: AppDatabase, id: string): BotMessageRow | undefined {
  const row = db.select().from(botMessages).where(eq(botMessages.id, id)).get();
  return row ? toRow(row) : undefined;
}

export function findReplyTo(db: AppDatabase, requestId: string): BotMessageRow | undefined {
  const row = db.select().from(botMessages).where(eq(botMessages.replyToId, requestId)).get();
  return row ? toRow(row) : undefined;
}

/** 同一时刻按 id 打破平局，避免两条消息抢同一条派发。 */
export function earliestQueued(db: AppDatabase, toBotId: string): BotMessageRow | undefined {
  const row = db
    .select()
    .from(botMessages)
    .where(and(eq(botMessages.toBotId, toBotId), eq(botMessages.state, "queued")))
    .orderBy(asc(botMessages.createdAt), asc(botMessages.id))
    .limit(1)
    .get();
  return row ? toRow(row) : undefined;
}

export function queuedRecipientIds(db: AppDatabase): string[] {
  const rows = db
    .select({ toBotId: botMessages.toBotId })
    .from(botMessages)
    .where(eq(botMessages.state, "queued"))
    .orderBy(asc(botMessages.createdAt), asc(botMessages.id))
    .all();
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    if (seen.has(row.toBotId)) continue;
    seen.add(row.toBotId);
    ids.push(row.toBotId);
  }
  return ids;
}

export function markBotMessage(
  db: AppDatabase,
  id: string,
  patch: { state: string; taskId?: string | null; error?: string | null; updatedAt: string },
): void {
  db.update(botMessages)
    .set({
      state: patch.state,
      updatedAt: patch.updatedAt,
      ...(patch.taskId !== undefined ? { taskId: patch.taskId } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    })
    .where(eq(botMessages.id, id))
    .run();
}

export function taskHop(db: AppDatabase, taskId: string): number {
  const row = db.$client
    .prepare(
      `select m.hop as hop from tasks t
       left join bot_messages m on m.id = t.bot_message_id
       where t.id = ?`,
    )
    .get(taskId) as { hop: number | null } | undefined;
  return row?.hop ?? 0;
}

export function listUserBots(db: AppDatabase, userId: string): Array<{ id: string; name: string }> {
  return db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(and(eq(bots.userId, userId), isNull(bots.deletedAt)))
    .orderBy(asc(bots.createdAt), asc(bots.id))
    .all()
    .map((row) => ({ id: row.id, name: row.name }));
}

export function deliveryProblem(db: AppDatabase, message: Pick<BotMessageRow, "userId" | "fromBotId" | "toBotId">): string | undefined {
  const from = db.$client
    .prepare("select user_id as userId, deleted_at as deletedAt from bots where id = ?")
    .get(message.fromBotId) as { userId: string; deletedAt: string | null } | undefined;
  const to = db.$client
    .prepare("select user_id as userId, deleted_at as deletedAt from bots where id = ?")
    .get(message.toBotId) as { userId: string; deletedAt: string | null } | undefined;
  if (!from || from.deletedAt) return "发送方 bot 已删除";
  if (!to || to.deletedAt) return "接收方 bot 已删除";
  if (from.userId !== to.userId || from.userId !== message.userId) return "发送方和接收方不属于同一用户";
  const user = db.select({ status: users.status }).from(users).where(eq(users.id, message.userId)).get();
  if (!user || user.status !== "active") return "用户已停用";
  return undefined;
}

function toRow(row: typeof botMessages.$inferSelect): BotMessageRow {
  return {
    id: row.id,
    userId: row.userId,
    fromBotId: row.fromBotId,
    toBotId: row.toBotId,
    replyToId: row.replyToId,
    originTaskId: row.originTaskId,
    hop: row.hop,
    body: row.body,
    state: row.state,
    taskId: row.taskId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
