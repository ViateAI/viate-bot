import { describe, expect, it } from "vitest";
import { botAvatarUrl } from "./avatar-url.js";

describe("avatar cache key", () => {
  it("stays stable for the same version and changes when the avatar version changes", () => {
    const first = botAvatarUrl("bot-1", "image/png", "2026-01-01T00:00:00.000Z");
    expect(first).toBe(botAvatarUrl("bot-1", "image/png", "2026-01-01T00:00:00.000Z"));
    expect(first).not.toBe(botAvatarUrl("bot-1", "image/png", "2026-01-02T00:00:00.000Z"));
    expect(botAvatarUrl("bot-1", null, "2026-01-02T00:00:00.000Z")).toBeUndefined();
    expect(botAvatarUrl("bot-1", "image/png", "2026-01-01T00:00:00.000Z")).not.toContain("dataUpdatedAt");
  });
});