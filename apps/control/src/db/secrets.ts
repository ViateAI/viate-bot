import { and, asc, eq, ne, notLike } from "drizzle-orm";
import type { UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { secrets } from "./schema.js";

export interface SecretRecord {
  id: string;
  name: string;
  valueEnc: string;
  scope: string;
  createdAt: string;
}

export interface SecretMeta {
  id: string;
  name: string;
  createdAt: string;
}

/** 只按当前用户读写。同名覆盖，不保留旧值。 */
export function secretRepository(db: AppDatabase) {
  return {
    list(scope: UserScope): SecretRecord[] {
      return db
        .select({
          id: secrets.id,
          name: secrets.name,
          valueEnc: secrets.valueEnc,
          scope: secrets.scope,
          createdAt: secrets.createdAt,
        })
        .from(secrets)
        .where(eq(secrets.userId, scope.userId))
        .all();
    },
    find(scope: UserScope, name: string): SecretRecord | undefined {
      return db
        .select({
          id: secrets.id,
          name: secrets.name,
          valueEnc: secrets.valueEnc,
          scope: secrets.scope,
          createdAt: secrets.createdAt,
        })
        .from(secrets)
        .where(and(eq(secrets.userId, scope.userId), eq(secrets.name, name)))
        .get();
    },
    /** 用户级密钥元数据。不含 scope=app 和 app: 前缀，也不返回密文。 */
    listUser(scope: UserScope): SecretMeta[] {
      return db
        .select({ id: secrets.id, name: secrets.name, createdAt: secrets.createdAt })
        .from(secrets)
        .where(userLevel(scope))
        .orderBy(asc(secrets.name))
        .all();
    },
    /** 只删当前用户的非应用独立密钥。返回是否删掉了行。 */
    remove(scope: UserScope, name: string): boolean {
      const result = db
        .delete(secrets)
        .where(and(userLevel(scope), eq(secrets.name, name)))
        .run();
      return result.changes > 0;
    },
    upsert(scope: UserScope, draft: { id: string; name: string; valueEnc: string; scope: "browser" }): void {
      const now = new Date().toISOString();
      const existing = db
        .select({ id: secrets.id })
        .from(secrets)
        .where(and(eq(secrets.userId, scope.userId), eq(secrets.name, draft.name)))
        .all();
      if (existing.length === 0) {
        db.insert(secrets)
          .values({
            id: draft.id,
            userId: scope.userId,
            name: draft.name,
            valueEnc: draft.valueEnc,
            scope: draft.scope,
            createdAt: now,
          })
          .run();
        return;
      }
      db.update(secrets)
        .set({ valueEnc: draft.valueEnc, scope: draft.scope, createdAt: now })
        .where(and(eq(secrets.userId, scope.userId), eq(secrets.name, draft.name)))
        .run();
    },
  };
}

function userLevel(scope: UserScope) {
  return and(eq(secrets.userId, scope.userId), ne(secrets.scope, "app"), notLike(secrets.name, "app:%"));
}
