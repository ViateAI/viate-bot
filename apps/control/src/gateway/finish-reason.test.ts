import { describe, expect, it } from "vitest";
import { classifyFinish } from "./finish-reason.js";

describe("classifyFinish", () => {
  it("keeps a normal stop", () => {
    expect(classifyFinish("stop", false)).toEqual({ stopReason: "stop" });
  });

  it("marks length even when tool calls were streamed", () => {
    expect(classifyFinish("length", true)).toEqual({ stopReason: "length" });
  });

  it("marks complete tool calls as toolUse", () => {
    expect(classifyFinish("tool_calls", true).stopReason).toBe("toolUse");
    expect(classifyFinish("stop", true).stopReason).toBe("toolUse");
  });

  it("does not treat other finish reasons as stop", () => {
    expect(classifyFinish("content_filter", false).stopReason).toBe("error");
    expect(classifyFinish("content_filter", true).stopReason).toBe("error");
    expect(classifyFinish("missing", true).stopReason).toBe("error");
  });
});
