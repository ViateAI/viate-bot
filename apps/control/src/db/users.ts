import { eq, sql } from "drizzle-orm";
import type { AppDatabase } from "./index.js";
import { quotaRepository, type QuotaDraft } from "./quotas.js";
import { identities, users } from "./schema.js";

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  status: string;
  isAdmin: boolean;
}

export interface UserDraft {
  id: string;
  email: string;
  name: string;
  status: string;
  isAdmin: boolean;
}

/** 用户行是身份来源，本身不带 UserScope。开发脚本在创建机器前写入它。 */
export function ensureDevUser(db: AppDatabase, userId: string, quota?: Partial<QuotaDraft>): void {
  if (db.select().from(users).where(eq(users.id, userId)).get()) {
    quotaRepository(db).seed(userId, quota);
    return;
  }
  db.insert(users)
    .values({
      id: userId,
      email: `${userId}@dev.local`,
      name: userId,
      status: "active",
      isAdmin: false,
      createdAt: new Date().toISOString(),
    })
    .run();
  quotaRepository(db).seed(userId, quota);
}

export function userRepository(db: AppDatabase) {
  return {
    findById(id: string): UserRecord | undefined {
      const row = db.select().from(users).where(eq(users.id, id)).get();
      return row ? toUser(row) : undefined;
    },
    findByEmail(email: string): UserRecord[] {
      const normalized = email.trim().toLowerCase();
      const rows = db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${normalized}`)
        .all();
      return rows.map(toUser);
    },
    /** 邮箱相同、且还没有任何外部身份的本地用户。 */
    findUnboundByEmail(email: string): UserRecord[] {
      return this.findByEmail(email).filter((row) => !hasIdentity(db, row.id));
    },
    insert(draft: UserDraft): UserRecord {
      const now = new Date().toISOString();
      db.insert(users)
        .values({
          id: draft.id,
          email: draft.email,
          name: draft.name,
          status: draft.status,
          isAdmin: draft.isAdmin,
          createdAt: now,
        })
        .run();
      const created = this.findById(draft.id);
      if (!created) throw new Error("写入用户后读不回来");
      return created;
    },
    updateProfile(id: string, patch: { email?: string; name?: string; isAdmin: boolean }): void {
      db.update(users)
        .set({
          ...(patch.email !== undefined ? { email: patch.email } : {}),
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          isAdmin: patch.isAdmin,
        })
        .where(eq(users.id, id))
        .run();
    },
    setStatus(id: string, status: string): void {
      db.update(users).set({ status }).where(eq(users.id, id)).run();
    },
  };
}

function hasIdentity(db: AppDatabase, userId: string): boolean {
  return db.select({ userId: identities.userId }).from(identities).where(eq(identities.userId, userId)).get() !== undefined;
}

function toUser(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    isAdmin: row.isAdmin,
  };
}
