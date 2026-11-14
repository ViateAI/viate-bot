import type {
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";

/**
 * 审批以后从这里接。占位符替换在工具执行里做：Pi 1.5.2 的 beforeToolCall 不能改参数。
 * afterToolCall 在结果写进上下文之前，服务会先跑这里，再打码。
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
