import type { AppDatabase } from "./db/index.js";
import { settingsRepository } from "./db/settings.js";

export const MODEL_RATE_KEY = "model_rate";

export interface ModelRate {
  userPerMin: number;
  botPerMin: number;
}

const listeners = new Set<() => void>();
const waitingRate = new Set<string>();

export class ModelRateRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRateRejected";
  }
}

export function subscribeModelRate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyModelRate(): void {
  for (const listener of listeners) listener();
}

export function readModelRate(db: AppDatabase, fallback: ModelRate): ModelRate {
  const stored = settingsRepository(db).getJson(MODEL_RATE_KEY);
  if (!isModelRate(stored)) return fallback;
  return { userPerMin: stored.userPerMin, botPerMin: stored.botPerMin };
}

export function saveModelRate(db: AppDatabase, value: ModelRate): ModelRate {
  if (!isModelRate(value)) throw new ModelRateRejected("限流必须是非负整数");
  const saved = { userPerMin: value.userPerMin, botPerMin: value.botPerMin };
  settingsRepository(db).setJson(MODEL_RATE_KEY, saved);
  notifyModelRate();
  return saved;
}

export function markRateWait(taskId: string, waiting: boolean): void {
  if (waiting) waitingRate.add(taskId);
  else waitingRate.delete(taskId);
}

export function taskRateWaiting(taskId: string): boolean {
  return waitingRate.has(taskId);
}

function isModelRate(value: unknown): value is ModelRate {
  if (!value || typeof value !== "object") return false;
  const rate = value as Partial<ModelRate>;
  return nonNegative(rate.userPerMin) && nonNegative(rate.botPerMin);
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
