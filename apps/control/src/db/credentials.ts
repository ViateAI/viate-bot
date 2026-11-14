import { and, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import type { UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { bots, modelCredentials } from "./schema.js";

export interface CredentialRecord {
  id: string;
  userId: string | null;
  botId: string | null;
  provider: string;
  externalId: string | null;
  secretEnc: string;
  policyRef: string | null;
  revokedAt: string | null;
}

export interface OwnedCredentialDraft {
  id: string;
  botId: string;
  provider: string;
  externalId: string | null;
  secretEnc: string;
  policyRef: string | null;
}

export interface UsageCredential {
  externalId: string;
  botId: string;
  userId: string;
}

export function credentialRepository(db: AppDatabase) {
  return {
    findById(scope: UserScope, id: string): CredentialRecord | undefined {
      const row = db
        .select()
        .from(modelCredentials)
        .where(and(eq(modelCredentials.id, id), eq(modelCredentials.userId, scope.userId)))
        .get();
      return row ? toRecord(row) : undefined;
    },
    findShared(): CredentialRecord | undefined {
      const row = db
        .select()
        .from(modelCredentials)
        .where(
          and(
            eq(modelCredentials.provider, "shared"),
            isNull(modelCredentials.userId),
            isNull(modelCredentials.botId),
            isNull(modelCredentials.revokedAt),
          ),
        )
        .get();
      return row ? toRecord(row) : undefined;
    },
    insertOwned(scope: UserScope, draft: OwnedCredentialDraft): CredentialRecord {
      const now = new Date().toISOString();
      db.insert(modelCredentials)
        .values({
          id: draft.id,
          userId: scope.userId,
          botId: draft.botId,
          provider: draft.provider,
          externalId: draft.externalId,
          secretEnc: draft.secretEnc,
          policyRef: draft.policyRef,
          createdAt: now,
        })
        .run();
      const created = this.findById(scope, draft.id);
      if (!created) throw new Error("写入凭据后读不回来");
      return created;
    },
    insertShared(id: string, secretEnc: string): CredentialRecord {
      const now = new Date().toISOString();
      db.insert(modelCredentials)
        .values({
          id,
          provider: "shared",
          secretEnc,
          createdAt: now,
        })
        .run();
      const created = this.findShared();
      if (!created || created.id !== id) throw new Error("写入共享凭据后读不回来");
      return created;
    },
    updateSecret(id: string, secretEnc: string): void {
      db.update(modelCredentials).set({ secretEnc }).where(eq(modelCredentials.id, id)).run();
    },
    markRevoked(scope: UserScope, id: string, revokedAt: string): boolean {
      const result = db
        .update(modelCredentials)
        .set({ revokedAt })
        .where(
          and(
            eq(modelCredentials.id, id),
            eq(modelCredentials.userId, scope.userId),
            isNull(modelCredentials.revokedAt),
          ),
        )
        .run();
      return result.changes > 0;
    },
    /** 还没吊销、bot 也还在的外部 key。已删除的 bot 不在这里。 */
    listActiveExternal(): UsageCredential[] {
      const rows = db
        .select({
          externalId: modelCredentials.externalId,
          botId: modelCredentials.botId,
          userId: modelCredentials.userId,
        })
        .from(modelCredentials)
        .innerJoin(bots, eq(bots.id, modelCredentials.botId))
        .where(
          and(
            isNull(modelCredentials.revokedAt),
            isNull(bots.deletedAt),
            isNotNull(modelCredentials.externalId),
            isNotNull(modelCredentials.botId),
            isNotNull(modelCredentials.userId),
          ),
        )
        .all();
      return usageCredentials(rows);
    },
    /**
     * 扣费回看。未吊销的 key 都要拉；已经吊销的，只要 revokedAt 还落在回看窗口里也要拉。
     * 软删除的 bot 不能排除，否则删除前没同步的用量和延迟结算会漏掉。
     */
    listBillableExternal(revokedAfter: string): UsageCredential[] {
      const rows = db
        .select({
          externalId: modelCredentials.externalId,
          botId: modelCredentials.botId,
          userId: modelCredentials.userId,
        })
        .from(modelCredentials)
        .where(
          and(
            or(isNull(modelCredentials.revokedAt), gte(modelCredentials.revokedAt, revokedAfter)),
            isNotNull(modelCredentials.externalId),
            isNotNull(modelCredentials.botId),
            isNotNull(modelCredentials.userId),
          ),
        )
        .all();
      return usageCredentials(rows);
    },
  };
}

function usageCredentials(
  rows: Array<{ externalId: string | null; botId: string | null; userId: string | null }>,
): UsageCredential[] {
  const credentials: UsageCredential[] = [];
  for (const row of rows) {
    if (!row.externalId || !row.botId || !row.userId) continue;
    credentials.push({ externalId: row.externalId, botId: row.botId, userId: row.userId });
  }
  return credentials;
}

function toRecord(row: typeof modelCredentials.$inferSelect): CredentialRecord {
  return {
    id: row.id,
    userId: row.userId,
    botId: row.botId,
    provider: row.provider,
    externalId: row.externalId,
    secretEnc: row.secretEnc,
    policyRef: row.policyRef,
    revokedAt: row.revokedAt,
  };
}
