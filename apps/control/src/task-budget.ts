import { settingsRepository } from "./db/settings.js";
import { quotaRepository } from "./db/quotas.js";
import type { AppDatabase } from "./db/index.js";
import { userScope } from "./scope.js";

export const TASK_TOKEN_BUDGET_KEY = "task_token_budget";

export class TaskBudgetRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskBudgetRejected";
  }
}

/** 输入和输出计入预算。缓存读、缓存写只记用量，不计入。0 表示不限制。 */
export function budgetFailureText(used: number, limit: number): string {
  return `已达到单任务 token 预算（已用 ${used} / 上限 ${limit}）`;
}

export function budgetFailure(task: { tokensUsed: number; tokenBudget?: number }, fallbackBudget?: number): string | undefined {
  const limit = task.tokenBudget ?? fallbackBudget;
  if (limit === undefined || limit <= 0) return undefined;
  if (task.tokensUsed < limit) return undefined;
  return budgetFailureText(task.tokensUsed, limit);
}

export function parseTaskTokenBudget(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

export function readGlobalTaskTokenBudget(db: AppDatabase): number | undefined {
  return parseTaskTokenBudget(settingsRepository(db).getJson(TASK_TOKEN_BUDGET_KEY));
}

export function saveGlobalTaskTokenBudget(db: AppDatabase, value: number): number {
  const parsed = parseTaskTokenBudget(value);
  if (parsed === undefined) throw new TaskBudgetRejected("token 预算必须是非负整数");
  settingsRepository(db).setJson(TASK_TOKEN_BUDGET_KEY, parsed);
  return parsed;
}

/** 用户覆盖优先（含 0=不限制）。没有覆盖时用全局设置，再没有用环境默认。 */
export function resolveTaskTokenBudget(db: AppDatabase, userId: string, envDefault: number): number {
  const quota = quotaRepository(db).find(userScope(userId));
  if (quota && quota.taskTokenBudget !== null) return quota.taskTokenBudget;
  const stored = readGlobalTaskTokenBudget(db);
  if (stored !== undefined) return stored;
  return envDefault;
}
