import type { AppDatabase } from "./index.js";
import { usageHourly } from "./schema.js";

export interface UsageWrite {
  botId: string;
  userId: string;
  model: string;
  hour: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: string | null;
  costSource: string;
}

export function usageRepository(db: AppDatabase) {
  return {
    upsert(rows: UsageWrite[]): void {
      for (const row of rows) {
        db.insert(usageHourly)
          .values(row)
          .onConflictDoUpdate({
            target: [usageHourly.botId, usageHourly.userId, usageHourly.model, usageHourly.hour],
            set: {
              requests: row.requests,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              cacheReadTokens: row.cacheReadTokens,
              cacheWriteTokens: row.cacheWriteTokens,
              costUsd: row.costUsd,
              costSource: row.costSource,
            },
          })
          .run();
      }
    },
  };
}
