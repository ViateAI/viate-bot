import { describe, expect, it } from "vitest";
import { classifyTool } from "./risk.js";

describe("mcp_call risk is per app and tool", () => {
  it("does not treat another app's risky tool name as risky, and does not miss the owning app", () => {
    const risky = new Set(["delete", "other:delete"]);
    expect(classifyTool("mcp_call", { app: "safe", tool: "delete" }, risky)).toBe("mcp");
    expect(classifyTool("mcp_call", { app: "other", tool: "delete" }, risky)).toBe("risky_tool");
    expect(classifyTool("mcp_call", { app: "other", tool: "export" }, risky)).toBe("mcp");
  });
});
