import { and, eq } from "drizzle-orm";
import type { RuleCategory, RuleMatch } from "../approvals/rules.js";
import { parseRuleMatch } from "../approvals/rules.js";
import { ulid } from "../id.js";
import type { UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { approvalRules, bots } from "./schema.js";

export interface ApprovalRuleRecord {
  id: string;
  botId: string;
  category: RuleCategory;
  match: RuleMatch;
  expiresAt: string | null;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
}

export function approvalRuleRepository(db: AppDatabase) {
  return {
    list(scope: UserScope, botId: string): ApprovalRuleRecord[] | undefined {
      if (!owns(db, scope, botId)) return undefined;
      return db.select().from(approvalRules).where(eq(approvalRules.botId, botId)).all().map(toRecord).filter((row): row is ApprovalRuleRecord => row !== undefined);
    },
    create(scope: UserScope, botId: string, category: string, match: unknown, expiresAt: string | null, now: Date): ApprovalRuleRecord | undefined {
      if (!owns(db, scope, botId)) return undefined;
      const parsed = parseRuleMatch(category, match);
      if ("error" in parsed) throw new Error(parsed.error);
      const id = ulid(now.getTime());
      db.insert(approvalRules).values({
        id,
        userId: scope.userId,
        botId,
        category: parsed.category,
        matchJson: JSON.stringify(parsed.match),
        expiresAt,
        hitCount: 0,
        createdAt: now.toISOString(),
      }).run();
      const row = db.select().from(approvalRules).where(and(eq(approvalRules.id, id), eq(approvalRules.userId, scope.userId))).get();
      const record = row ? toRecord(row) : undefined;
      if (!record) throw new Error("写入规则后读不回来");
      return record;
    },
    remove(scope: UserScope, botId: string, ruleId: string): boolean {
      const result = db.delete(approvalRules).where(and(eq(approvalRules.id, ruleId), eq(approvalRules.botId, botId), eq(approvalRules.userId, scope.userId))).run();
      return result.changes > 0 && owns(db, scope, botId);
    },
    active(scope: UserScope, botId: string): ApprovalRuleRecord[] {
      return this.list(scope, botId)?.filter((row) => row.expiresAt === null || Date.parse(row.expiresAt) > Date.now()) ?? [];
    },
    recordHit(scope: UserScope, ruleId: string, now: Date): void {
      db.$client.prepare("update approval_rules set hit_count = hit_count + 1, last_hit_at = ? where id = ? and user_id = ?").run(now.toISOString(), ruleId, scope.userId);
    },
  };
}

/** 默认永久。只有显式给出未过期的 expiresAt 才设置过期时间。 */
export function ruleExpiry(now: Date, input: { expiresAt?: string }): string | null {
  if (!input.expiresAt) return null;
  const time = Date.parse(input.expiresAt);
  if (!Number.isFinite(time) || time <= now.getTime()) throw new Error("过期时间无效");
  return new Date(time).toISOString();
}

function owns(db: AppDatabase, scope: UserScope, botId: string): boolean {
  return db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, botId), eq(bots.userId, scope.userId))).get() !== undefined;
}

function toRecord(row: typeof approvalRules.$inferSelect): ApprovalRuleRecord | undefined {
  let match: unknown;
  try {
    match = JSON.parse(row.matchJson) as unknown;
  } catch {
    return undefined;
  }
  const parsed = parseRuleMatch(row.category, match);
  if ("error" in parsed) return undefined;
  return {
    id: row.id,
    botId: row.botId,
    category: parsed.category,
    match: parsed.match,
    expiresAt: row.expiresAt,
    hitCount: row.hitCount,
    lastHitAt: row.lastHitAt,
    createdAt: row.createdAt,
  };
}
