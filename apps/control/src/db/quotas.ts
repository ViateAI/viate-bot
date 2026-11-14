import { eq } from "drizzle-orm";
import type { MachineSpec } from "../machines/policy.js";
import type { UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { quotas } from "./schema.js";

export interface QuotaRecord {
  userId: string;
  maxBots: number;
  spec: MachineSpec | undefined;
  maxConcurrentTasks: number;
  maxRoutines: number;
}

export function quotaRepository(db: AppDatabase) {
  return {
    find(scope: UserScope): QuotaRecord | undefined {
      const row = db.select().from(quotas).where(eq(quotas.userId, scope.userId)).get();
      if (!row) return undefined;
      return {
        userId: row.userId,
        maxBots: row.maxBots,
        spec: parseSpec(row.specJson),
        maxConcurrentTasks: row.maxConcurrentTasks,
        maxRoutines: row.maxRoutines,
      };
    },
  };
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
