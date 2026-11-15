import { desc } from "drizzle-orm";
import { ulid } from "../id.js";
import type { AdminScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { auditLog } from "./schema.js";

export interface AuditRecord {
  id: string;
  ts: string;
  actorUserId: string | null;
  action: string;
  target: string;
  attrs: unknown;
}

export function auditRepository(db: AppDatabase) {
  return {
    write(scope: AdminScope, action: string, target: string, attrs: Record<string, unknown> = {}): void {
      db.insert(auditLog)
        .values({
          id: ulid(),
          ts: new Date().toISOString(),
          actorUserId: scope.actorUserId,
          action,
          target,
          attrsJson: JSON.stringify(attrs),
        })
        .run();
    },
    list(scope: AdminScope, limit: number): AuditRecord[] {
      void scope;
      return db
        .select()
        .from(auditLog)
        .orderBy(desc(auditLog.ts))
        .limit(limit)
        .all()
        .map((row) => ({
          id: row.id,
          ts: row.ts,
          actorUserId: row.actorUserId,
          action: row.action,
          target: row.target,
          attrs: parse(row.attrsJson),
        }));
    },
  };
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}
