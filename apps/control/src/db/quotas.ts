import { eq } from "drizzle-orm";
import type { MachineSpec } from "../machines/policy.js";
import type { AdminScope, UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { quotas } from "./schema.js";

export interface QuotaRecord {
  userId: string;
  maxBots: number;
  spec: MachineSpec | undefined;
  maxConcurrentTasks: number;
  maxRoutines: number;
}

/** ensureDevUser 写入的默认配额。已有测试靠这一行继续能建 bot。 */
export const SEEDED_QUOTA = {
  maxBots: 5,
  spec: { cpu: 1, memMb: 1024, diskGb: 10 },
  maxConcurrentTasks: 2,
  maxRoutines: 0,
} as const;

export interface QuotaDraft {
  maxBots: number;
  spec: MachineSpec;
  maxConcurrentTasks: number;
  maxRoutines: number;
}

export function quotaRepository(db: AppDatabase) {
  return {
    find(scope: UserScope): QuotaRecord | undefined {
      const row = db.select().from(quotas).where(eq(quotas.userId, scope.userId)).get();
      return row ? toRecord(row) : undefined;
    },
    /** 开发种子。没有这一行时用户算未开通。已有行不覆盖。 */
    seed(userId: string, patch: Partial<QuotaDraft> = {}): void {
      if (db.select().from(quotas).where(eq(quotas.userId, userId)).get()) return;
      const draft = { ...SEEDED_QUOTA, ...patch };
      db.insert(quotas)
        .values({
          userId,
          maxBots: draft.maxBots,
          specJson: JSON.stringify(draft.spec),
          maxConcurrentTasks: draft.maxConcurrentTasks,
          maxRoutines: draft.maxRoutines,
        })
        .run();
    },
    insert(scope: AdminScope, userId: string, draft: QuotaDraft): boolean {
      void scope;
      try {
        db.insert(quotas)
          .values({
            userId,
            maxBots: draft.maxBots,
            specJson: JSON.stringify(draft.spec),
            maxConcurrentTasks: draft.maxConcurrentTasks,
            maxRoutines: draft.maxRoutines,
          })
          .run();
        return true;
      } catch (error) {
        if (isUnique(error)) return false;
        throw error;
      }
    },
    update(scope: AdminScope, userId: string, patch: Partial<QuotaDraft>): boolean {
      void scope;
      const result = db
        .update(quotas)
        .set({
          ...(patch.maxBots !== undefined ? { maxBots: patch.maxBots } : {}),
          ...(patch.spec !== undefined ? { specJson: JSON.stringify(patch.spec) } : {}),
          ...(patch.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: patch.maxConcurrentTasks } : {}),
          ...(patch.maxRoutines !== undefined ? { maxRoutines: patch.maxRoutines } : {}),
        })
        .where(eq(quotas.userId, userId))
        .run();
      return result.changes > 0;
    },
    remove(scope: AdminScope, userId: string): boolean {
      void scope;
      const result = db.delete(quotas).where(eq(quotas.userId, userId)).run();
      return result.changes > 0;
    },
  };
}

function toRecord(row: typeof quotas.$inferSelect): QuotaRecord {
  return {
    userId: row.userId,
    maxBots: row.maxBots,
    spec: parseSpec(row.specJson),
    maxConcurrentTasks: row.maxConcurrentTasks,
    maxRoutines: row.maxRoutines,
  };
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message);
}

function parseSpec(json: string): MachineSpec | undefined {
  try {
    const value = JSON.parse(json) as Partial<MachineSpec>;
    if (typeof value.cpu !== "number" || typeof value.memMb !== "number" || typeof value.diskGb !== "number") {
      return undefined;
    }
    return { cpu: value.cpu, memMb: value.memMb, diskGb: value.diskGb };
  } catch {
    return undefined;
  }
}
