import { and, eq, isNull } from "drizzle-orm";
import type { UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { bots } from "./schema.js";

export interface BotRecord {
  id: string;
  userId: string;
  name: string;
  model: string;
  instructions: string;
  modelCredentialId: string | null;
}

export interface BotDraft {
  id: string;
  name: string;
  model: string;
  instructions?: string;
}

export interface BotPatch {
  name?: string;
  model?: string;
  instructions?: string;
}

export interface BotStore {
  list(scope: UserScope): BotRecord[];
  findById(scope: UserScope, id: string): BotRecord | undefined;
  insert(scope: UserScope, draft: BotDraft): BotRecord;
  update(scope: UserScope, id: string, patch: BotPatch): boolean;
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
    insert(scope, draft) {
      const now = new Date().toISOString();
      db.insert(bots)
        .values({
          id: draft.id,
          userId: scope.userId,
          name: draft.name,
          model: draft.model,
          instructions: draft.instructions ?? "",
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
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(bots.id, id), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .run();
      return result.changes > 0;
    },
  };
}

function toRecord(row: typeof bots.$inferSelect): BotRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    model: row.model,
    instructions: row.instructions,
    modelCredentialId: row.modelCredentialId,
  };
}
