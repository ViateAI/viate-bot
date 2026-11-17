import { and, eq, lt } from "drizzle-orm";
import type { AppDatabase } from "../db/index.js";
import { eventRepository } from "../db/events.js";
import { events, machineSamples, statsMinute } from "../db/schema.js";
import { sanitizeAttrs } from "./sanitize.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OpsEvent {
  id: string;
  ts: string;
  type: string;
  userId?: string | null;
  botId?: string | null;
  machineId?: string | null;
  attrs?: unknown;
}

interface Bucket {
  bucket: string;
  metric: string;
  dimsKey: string;
  sum: number;
  count: number;
  max: number;
}

export function minuteBucket(iso: string): string {
  return iso.slice(0, 16);
}

export class MinuteAccumulator {
  private readonly rows = new Map<string, Bucket>();

  add(ts: string, metric: string, dimsKey: string, value: number): void {
    const bucket = minuteBucket(ts);
    const key = `${bucket}\0${metric}\0${dimsKey}`;
    const current = this.rows.get(key);
    if (!current) {
      this.rows.set(key, { bucket, metric, dimsKey, sum: value, count: 1, max: value });
      return;
    }
    current.sum += value;
    current.count += 1;
    current.max = Math.max(current.max, value);
  }

  drain(): Bucket[] {
    const rows = [...this.rows.values()];
    this.rows.clear();
    return rows;
  }
}

export const opsMinutes = new MinuteAccumulator();

export function emitOps(db: AppDatabase, acc: MinuteAccumulator, event: OpsEvent): void {
  const attrs = sanitizeAttrs(event.attrs);
  eventRepository(db).insert({
    id: event.id,
    ts: event.ts,
    type: event.type,
    ...(event.userId !== undefined ? { userId: event.userId } : {}),
    ...(event.botId !== undefined ? { botId: event.botId } : {}),
    ...(event.machineId !== undefined ? { machineId: event.machineId } : {}),
    attrs,
  });
  const dims = typeof attrs.errorClass === "string" ? attrs.errorClass : "_";
  acc.add(event.ts, event.type, dims, 1);
}

export function flushMinutes(db: AppDatabase, acc: MinuteAccumulator): number {
  const rows = acc.drain();
  for (const row of rows) {
    const existing = db
      .select()
      .from(statsMinute)
      .where(and(eq(statsMinute.bucket, row.bucket), eq(statsMinute.metric, row.metric), eq(statsMinute.dimsKey, row.dimsKey)))
      .get();
    if (!existing) {
      db.insert(statsMinute)
        .values({
          bucket: row.bucket,
          metric: row.metric,
          dimsKey: row.dimsKey,
          valueSum: row.sum,
          valueCount: row.count,
          valueMax: row.max,
        })
        .run();
      continue;
    }
    db.update(statsMinute)
      .set({
        valueSum: existing.valueSum + row.sum,
        valueCount: existing.valueCount + row.count,
        valueMax: Math.max(existing.valueMax, row.max),
      })
      .where(and(eq(statsMinute.bucket, row.bucket), eq(statsMinute.metric, row.metric), eq(statsMinute.dimsKey, row.dimsKey)))
      .run();
  }
  return rows.length;
}

export function applyRetention(db: AppDatabase, now: Date): { events: number; stats: number; samples: number } {
  const eventsBefore = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const statsBefore = minuteBucket(new Date(now.getTime() - 365 * DAY_MS).toISOString());
  const samplesBefore = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const removedEvents = db.delete(events).where(lt(events.ts, eventsBefore)).run().changes;
  const removedStats = db.delete(statsMinute).where(lt(statsMinute.bucket, statsBefore)).run().changes;
  const removedSamples = db.delete(machineSamples).where(lt(machineSamples.ts, samplesBefore)).run().changes;
  return { events: removedEvents, stats: removedStats, samples: removedSamples };
}
