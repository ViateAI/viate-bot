export type MappedStop = "stop" | "length" | "toolUse" | "error";

/** 只有上游明确的 stop 是正常结束。length 优先于工具调用，避免执行被截断的参数。 */
export function classifyFinish(
  finish: string,
  hasToolCalls: boolean,
): { stopReason: MappedStop; errorMessage?: string } {
  if (finish === "length") return { stopReason: "length" };
  if (finish === "tool_calls" || finish === "function_call") return { stopReason: "toolUse" };
  if (finish === "stop") return { stopReason: hasToolCalls ? "toolUse" : "stop" };
  return { stopReason: "error", errorMessage: `模型没有正常结束: ${finish}` };
}
