import { settingsRepository } from "./db/settings.js";
import type { AppDatabase } from "./db/index.js";

export const MODEL_LIMITS_KEY = "model_limits";

export interface ModelLimit {
  contextTokens: number;
  maxTokens: number;
}

export class ModelLimitRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelLimitRejected";
  }
}

export function parseModelLimits(value: unknown): Record<string, ModelLimit> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const limits: Record<string, ModelLimit> = {};
  for (const [model, raw] of Object.entries(value)) {
    const parsed = asLimit(raw);
    if (model.trim().length > 0 && parsed) limits[model] = parsed;
  }
  return limits;
}

export function readModelLimits(db: AppDatabase): Record<string, ModelLimit> {
  return parseModelLimits(settingsRepository(db).getJson(MODEL_LIMITS_KEY));
}

export function resolveModelLimit(
  stored: Record<string, ModelLimit>,
  modelId: string,
  defaults: ModelLimit,
): ModelLimit {
  return stored[modelId] ?? defaults;
}

export function assertModelLimit(contextTokens: number, maxTokens: number): ModelLimit {
  if (!Number.isInteger(contextTokens) || contextTokens < 1) throw new ModelLimitRejected("上下文窗口必须是正整数");
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new ModelLimitRejected("输出上限必须是正整数");
  if (maxTokens > contextTokens) throw new ModelLimitRejected("输出上限不得超过上下文窗口");
  return { contextTokens, maxTokens };
}

export function saveModelLimit(db: AppDatabase, model: string, limit: ModelLimit | null): Record<string, ModelLimit> {
  const name = model.trim();
  if (name.length === 0 || name.length > 200) throw new ModelLimitRejected("模型名无效");
  const next = readModelLimits(db);
  if (limit) next[name] = limit;
  else delete next[name];
  settingsRepository(db).setJson(MODEL_LIMITS_KEY, next);
  return next;
}

function asLimit(value: unknown): ModelLimit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { contextTokens?: unknown; maxTokens?: unknown };
  if (typeof record.contextTokens !== "number" || typeof record.maxTokens !== "number") return undefined;
  try {
    return assertModelLimit(record.contextTokens, record.maxTokens);
  } catch {
    return undefined;
  }
}
