import { eq } from "drizzle-orm";
import type { AppDatabase } from "./index.js";
import { events } from "./schema.js";

export interface EventDraft {
  id: string;
  ts: string;
  userId?: string | null;
  botId?: string | null;
  machineId?: string | null;
  type: string;
  attrs: unknown;
}

export interface EventRecord {
  id: string;
  ts: string;
  userId: string | null;
  botId: string | null;
  machineId: string | null;
  type: string;
  attrsJson: string;
}

export function eventRepository(db: AppDatabase) {
  return {
    insert(draft: EventDraft): void {
      db.insert(events)
        .values({
          id: draft.id,
          ts: draft.ts,
          userId: draft.userId ?? null,
          botId: draft.botId ?? null,
          machineId: draft.machineId ?? null,
          type: draft.type,
          attrsJson: JSON.stringify(draft.attrs ?? {}),
        })
        .run();
    },
    listByBot(botId: string): EventRecord[] {
      return db
        .select()
        .from(events)
        .where(eq(events.botId, botId))
        .all()
        .map((row) => ({
          id: row.id,
          ts: row.ts,
          userId: row.userId,
          botId: row.botId,
          machineId: row.machineId,
          type: row.type,
          attrsJson: row.attrsJson,
        }));
    },
  };
}
