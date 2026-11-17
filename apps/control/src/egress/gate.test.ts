import { afterEach, expect, it, vi } from "vitest";
import { createEgressGate } from "./gate.js";

afterEach(() => vi.useRealTimers());

it("cancels a recovered wait whose deadline has already expired", () => {
  vi.useFakeTimers();
  const failed = vi.fn();
  const gate = createEgressGate({ blocked: () => true, waitMs: 1, now: () => new Date(1000), onResume: () => undefined, onFail: failed });
  gate.hold("user", "task", new Date(0).toISOString());
  gate.cancel("task");
  vi.runAllTimers();
  expect(failed).not.toHaveBeenCalled();
});
