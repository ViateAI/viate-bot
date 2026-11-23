import { and, asc, eq, isNull } from "drizzle-orm";
import type { UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { bots } from "./schema.js";

export interface BotRecord {
  id: string;
  userId: string;
  name: string;
  bio: string;
  avatar: string | null;
  model: string;
  instructions: string;
  modelCredentialId: string | null;
  noticeReady: boolean;
  updatedAt: string;
}

export interface BotDraft {
  id: string;
  name: string;
  model: string;
  instructions?: string;
  modelCredentialId?: string | null;
  noticeReady?: boolean;
}

export interface BotPatch {
  name?: string;
  bio?: string;
  avatar?: string | null;
  model?: string;
  instructions?: string;
}

export interface BotStore {
  list(scope: UserScope): BotRecord[];
  findById(scope: UserScope, id: string): BotRecord | undefined;
  /** 未删除 bot 中 created_at 最早的一个；同刻按 id。 */
  primaryId(scope: UserScope): string | undefined;
  insert(scope: UserScope, draft: BotDraft): BotRecord;
  update(scope: UserScope, id: string, patch: BotPatch): boolean;
  setCredential(scope: UserScope, id: string, credentialId: string): boolean;
  markNoticeReady(scope: UserScope, id: string): boolean;
  softDelete(scope: UserScope, id: string): boolean;
  /** 签发凭据失败时删掉刚插入、还没有凭据的 bot。 */
  remove(scope: UserScope, id: string): boolean;
  /** 对账用：按 bot id 判断是否还存在，不返回其他用户的数据。 */
  isActive(id: string): boolean;
}

export function botRepository(db: AppDatabase): BotStore {
  return {
    list(scope) {
      return db
        .select()
        .from(bots)
        .where(and(eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .all()
        .map(toRecord);
    },
    findById(scope, id) {
      const row = db
        .select()
        .from(bots)
        .where(and(eq(bots.id, id), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .get();
      return row ? toRecord(row) : undefined;
    },
    primaryId(scope) {
      return db
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .orderBy(asc(bots.createdAt), asc(bots.id))
        .limit(1)
        .get()?.id;
    },
    insert(scope, draft) {
      const now = new Date().toISOString();
      db.insert(bots)
        .values({
          id: draft.id,
          userId: scope.userId,
          name: draft.name,
          model: draft.model,
          instructions: draft.instructions ?? "",
          modelCredentialId: draft.modelCredentialId ?? null,
          noticeReady: draft.noticeReady ?? true,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const created = db
        .select()
        .from(bots)
        .where(and(eq(bots.id, draft.id), eq(bots.userId, scope.userId)))
        .get();
      if (!created) throw new Error("写入 bot 后读不回来");
      return toRecord(created);
    },
    update(scope, id, patch) {
      const result = db
        .update(bots)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
          ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(bots.id, id), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .run();
      return result.changes > 0;
    },
    setCredential(scope, id, credentialId) {
      const result = db
        .update(bots)
        .set({ modelCredentialId: credentialId, updatedAt: new Date().toISOString() })
        .where(and(eq(bots.id, id), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .run();
      return result.changes > 0;
    },
    markNoticeReady(scope, id) {
      return db.update(bots).set({ noticeReady: true })
        .where(and(eq(bots.userId, scope.userId), eq(bots.id, id), isNull(bots.deletedAt)))
        .run().changes > 0;
    },
    softDelete(scope, id) {
      const now = new Date().toISOString();
      const result = db
        .update(bots)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(bots.id, id), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .run();
      return result.changes > 0;
    },
    remove(scope, id) {
      const result = db
        .delete(bots)
        .where(and(eq(bots.id, id), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .run();
      return result.changes > 0;
    },
    isActive(id) {
      return (
        db
          .select({ id: bots.id })
          .from(bots)
          .where(and(eq(bots.id, id), isNull(bots.deletedAt)))
          .get() !== undefined
      );
    },
  };
}

function toRecord(row: typeof bots.$inferSelect): BotRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    bio: row.bio,
    avatar: row.avatar,
    model: row.model,
    instructions: row.instructions,
    modelCredentialId: row.modelCredentialId,
    noticeReady: row.noticeReady,
    updatedAt: row.updatedAt,
  };
}
