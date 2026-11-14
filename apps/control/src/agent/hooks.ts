import type {
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";

/**
 * 第 5 步的安全表单从这里接。
 * beforeToolCall 在参数校验之后、真正执行之前；afterToolCall 在结果回到模型之前。
 * 本步不实现审批和占位符替换，只把钩子留在 Agent 上。
 */
export interface ToolHooks {
  beforeToolCall?(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined>;
  afterToolCall?(
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined>;
}

let installed: ToolHooks = {};

export function setToolHooks(hooks: ToolHooks): void {
  installed = hooks;
}

export function getToolHooks(): ToolHooks {
  return installed;
}
