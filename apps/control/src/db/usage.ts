import { sql } from "drizzle-orm";
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
    /** 模型网关累加这一小时的用量。和 upsert 不同，不能覆盖已经记下的数字。 */
    add(row: UsageWrite): void {
      db.insert(usageHourly)
        .values(row)
        .onConflictDoUpdate({
          target: [usageHourly.botId, usageHourly.userId, usageHourly.model, usageHourly.hour],
          set: {
            requests: sql`${usageHourly.requests} + ${row.requests}`,
            inputTokens: sql`${usageHourly.inputTokens} + ${row.inputTokens}`,
            outputTokens: sql`${usageHourly.outputTokens} + ${row.outputTokens}`,
            cacheReadTokens: sql`${usageHourly.cacheReadTokens} + ${row.cacheReadTokens}`,
            cacheWriteTokens: sql`${usageHourly.cacheWriteTokens} + ${row.cacheWriteTokens}`,
            costUsd: row.costUsd,
            costSource: row.costSource,
          },
        })
        .run();
    },
  };
}
