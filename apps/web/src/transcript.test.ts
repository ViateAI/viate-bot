import { describe, expect, it } from "vitest";
import { transcriptNearBottom } from "./transcript.js";

describe("transcript follow", () => {
  it("follows only when the reader is already near the bottom", () => {
    expect(transcriptNearBottom(900, 1000, 100)).toBe(true);
    expect(transcriptNearBottom(852, 1000, 100)).toBe(true);
    expect(transcriptNearBottom(851, 1000, 100)).toBe(false);
    expect(transcriptNearBottom(0, 1000, 100)).toBe(false);
  });
});
