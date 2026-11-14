import { and, eq } from "drizzle-orm";
import type { UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { secrets } from "./schema.js";

export interface SecretRecord {
  id: string;
  name: string;
  valueEnc: string;
  scope: string;
}

/** 只按当前用户读写。同名覆盖，不保留旧值。 */
export function secretRepository(db: AppDatabase) {
  return {
    list(scope: UserScope): SecretRecord[] {
      return db
        .select({ id: secrets.id, name: secrets.name, valueEnc: secrets.valueEnc, scope: secrets.scope })
        .from(secrets)
        .where(eq(secrets.userId, scope.userId))
        .all();
    },
    find(scope: UserScope, name: string): SecretRecord | undefined {
      return db
        .select({ id: secrets.id, name: secrets.name, valueEnc: secrets.valueEnc, scope: secrets.scope })
        .from(secrets)
        .where(and(eq(secrets.userId, scope.userId), eq(secrets.name, name)))
        .get();
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
