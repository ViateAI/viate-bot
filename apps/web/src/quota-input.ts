/** Blank means inherit. Anything else must be a non-negative safe integer, or the form must not submit. */
export function readQuotaField(text: string, blank: "null" | "reject"): number | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    if (blank === "null") return null;
    throw new Error("必须是非负整数");
  }
  if (!/^\d+$/.test(trimmed)) throw new Error("必须是非负整数");
  const value = Number(trimmed);
  const canonical = trimmed.replace(/^0+(?=\d)/, "");
  if (!Number.isSafeInteger(value) || String(value) !== canonical) throw new Error("必须是非负整数");
  return value;
}

export interface QuotaFormInput {
  maxBots: string;
  maxConcurrentTasks: string;
  maxRoutines: string;
  taskTokenBudget: string;
  taskMaxSteps: string;
  taskMaxDurationSec: string;
}

export interface QuotaFormValues {
  maxBots: number;
  maxConcurrentTasks: number;
  maxRoutines: number;
  taskTokenBudget: number | null;
  taskMaxSteps: number | null;
  taskMaxDurationSec: number | null;
}

/** Illegal input throws and the caller must not submit. Blank optional fields become null. */
export function readQuotaForm(input: QuotaFormInput): QuotaFormValues {
  const maxBots = readQuotaField(input.maxBots, "reject");
  const maxConcurrentTasks = readQuotaField(input.maxConcurrentTasks, "reject");
  const maxRoutines = readQuotaField(input.maxRoutines, "reject");
  if (maxBots === null || maxConcurrentTasks === null || maxRoutines === null) throw new Error("必须是非负整数");
  return {
    maxBots,
    maxConcurrentTasks,
    maxRoutines,
    taskTokenBudget: readQuotaField(input.taskTokenBudget, "null"),
    taskMaxSteps: readQuotaField(input.taskMaxSteps, "null"),
    taskMaxDurationSec: readQuotaField(input.taskMaxDurationSec, "null"),
  };
}
