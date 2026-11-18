export const LENGTH_CONTINUE_LIMIT = 2;
export const LENGTH_CONTINUE_TEXT = "继续";
export const TRUNCATED_TOOL_TEXT = "上一条输出被截断，工具参数不完整，请缩短后重试";
export const LENGTH_FAIL = "模型输出达到上限";
export const NO_CONCLUSION = "模型没有给出结论";

export type LengthAction = "ignore" | "continue_text" | "continue_tools" | "fail";

/** 同一任务最多续写 2 次。第三次 length 失败。有工具调用和没有工具调用共用这个次数。 */
export function lengthAction(
  continuationsSoFar: number,
  turn: { stopReason: string; toolCalls: number },
): { action: LengthAction; continuations: number } {
  if (turn.stopReason !== "length") return { action: "ignore", continuations: continuationsSoFar };
  const continuations = continuationsSoFar + 1;
  if (continuations > LENGTH_CONTINUE_LIMIT) return { action: "fail", continuations };
  return { action: turn.toolCalls > 0 ? "continue_tools" : "continue_text", continuations };
}

export function terminalOutcome(input: {
  failReason?: string | undefined;
  stopRequested: boolean;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
}): { state: "failed" | "cancelled" | "succeeded"; error: string | null } {
  if (input.failReason) return { state: "failed", error: input.failReason };
  if (input.stopRequested || input.stopReason === "aborted") return { state: "cancelled", error: null };
  if (input.stopReason === "stop") return { state: "succeeded", error: null };
  if (input.stopReason === "length") return { state: "failed", error: LENGTH_FAIL };
  if (input.stopReason === "error") return { state: "failed", error: input.errorMessage?.trim() || "模型请求失败" };
  return { state: "failed", error: NO_CONCLUSION };
}
