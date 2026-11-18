import { describe, expect, it } from "vitest";
import { LENGTH_FAIL, NO_CONCLUSION, lengthAction, terminalOutcome } from "./length.js";

describe("length continuation", () => {
  it("continues text twice and fails on the third length", () => {
    const first = lengthAction(0, { stopReason: "length", toolCalls: 0 });
    expect(first).toEqual({ action: "continue_text", continuations: 1 });
    const second = lengthAction(first.continuations, { stopReason: "length", toolCalls: 0 });
    expect(second).toEqual({ action: "continue_text", continuations: 2 });
    expect(lengthAction(second.continuations, { stopReason: "length", toolCalls: 0 })).toEqual({
      action: "fail",
      continuations: 3,
    });
  });

  it("counts a truncated tool call toward the same budget", () => {
    const first = lengthAction(0, { stopReason: "length", toolCalls: 2 });
    expect(first.action).toBe("continue_tools");
    expect(lengthAction(2, { stopReason: "length", toolCalls: 1 }).action).toBe("fail");
  });

  it("ignores a normal stop", () => {
    expect(lengthAction(1, { stopReason: "stop", toolCalls: 0 })).toEqual({ action: "ignore", continuations: 1 });
  });
});

describe("terminal outcome", () => {
  it("succeeds only on stop", () => {
    expect(terminalOutcome({ stopRequested: false, stopReason: "stop" }).state).toBe("succeeded");
    expect(terminalOutcome({ stopRequested: false, stopReason: "toolUse" })).toEqual({
      state: "failed",
      error: NO_CONCLUSION,
    });
    expect(terminalOutcome({ stopRequested: false, stopReason: "length" }).error).toBe(LENGTH_FAIL);
    expect(terminalOutcome({ stopRequested: false }).error).toBe(NO_CONCLUSION);
    expect(terminalOutcome({ stopRequested: true, stopReason: "stop" }).state).toBe("cancelled");
    expect(terminalOutcome({ failReason: "等待用户输入超时", stopRequested: false, stopReason: "stop" }).error).toBe(
      "等待用户输入超时",
    );
  });
});
