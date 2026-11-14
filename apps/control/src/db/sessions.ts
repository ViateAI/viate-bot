import { eq } from "drizzle-orm";
import type { AppDatabase } from "./index.js";
import { sessions } from "./schema.js";

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  csrf: string;
  refreshTokenEnc: string;
  expiresAt: string;
  lastSeenAt: string;
  lastValidatedAt: string;
  createdAt: string;
}

export interface SessionDraft {
  id: string;
  userId: string;
  tokenHash: string;
  csrf: string;
  refreshTokenEnc: string;
  expiresAt: string;
  lastSeenAt: string;
  lastValidatedAt: string;
}

/** 按 cookie 哈希找会话。此时还没有 UserScope。 */
export function sessionRepository(db: AppDatabase) {
  return {
    insert(draft: SessionDraft): void {
      db.insert(sessions)
        .values({
          id: draft.id,
          userId: draft.userId,
          tokenHash: draft.tokenHash,
          csrf: draft.csrf,
          idpRefreshTokenEnc: draft.refreshTokenEnc,
          expiresAt: draft.expiresAt,
          lastSeenAt: draft.lastSeenAt,
          lastValidatedAt: draft.lastValidatedAt,
          createdAt: draft.lastSeenAt,
        })
        .run();
    },
    findByTokenHash(tokenHash: string): SessionRecord | undefined {
      const row = db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get();
      return row ? toRecord(row) : undefined;
    },
    findById(id: string): SessionRecord | undefined {
      const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
      return row ? toRecord(row) : undefined;
    },
    listByUser(userId: string): SessionRecord[] {
      return db.select().from(sessions).where(eq(sessions.userId, userId)).all().map(toRecord);
    },
    touch(id: string, lastSeenAt: string, expiresAt: string): void {
      db.update(sessions).set({ lastSeenAt, expiresAt }).where(eq(sessions.id, id)).run();
    },
    saveRefresh(id: string, refreshTokenEnc: string, lastValidatedAt: string): void {
      db.update(sessions)
        .set({ idpRefreshTokenEnc: refreshTokenEnc, lastValidatedAt })
        .where(eq(sessions.id, id))
        .run();
    },
    /** 测试把上次校验时间拨回去，让下一次请求走 refresh。 */
    setLastValidatedAt(id: string, lastValidatedAt: string): void {
      db.update(sessions).set({ lastValidatedAt }).where(eq(sessions.id, id)).run();
    },
    replaceRefreshToken(id: string, refreshTokenEnc: string): void {
      db.update(sessions).set({ idpRefreshTokenEnc: refreshTokenEnc }).where(eq(sessions.id, id)).run();
    },
    delete(id: string): void {
      db.delete(sessions).where(eq(sessions.id, id)).run();
    },
  };
}

function toRecord(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    csrf: row.csrf,
    refreshTokenEnc: row.idpRefreshTokenEnc,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    lastValidatedAt: row.lastValidatedAt,
    createdAt: row.createdAt,
  };
}
