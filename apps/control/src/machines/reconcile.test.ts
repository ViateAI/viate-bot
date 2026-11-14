import { describe, expect, it } from "vitest";
import { decideReconcile, shouldAutoSleep, shouldAutoWake } from "./reconcile.js";

const base = {
  desired: "running" as const,
  actual: "running" as const,
  heartbeatFailures: 0,
  restartFailures: 0,
  stopWaitedSec: 0,
};

describe("reconcile table", () => {
  it("creates a missing container that should be running", () => {
    expect(decideReconcile({ ...base, actual: "missing" })).toEqual({ type: "create" });
  });

  it("starts a stopped container that should be running", () => {
    expect(decideReconcile({ ...base, actual: "stopped" })).toEqual({ type: "start" });
  });

  it("restarts after three missed heartbeats and gives up after three restarts", () => {
    expect(decideReconcile({ ...base, heartbeatFailures: 2 })).toEqual({ type: "none" });
    expect(decideReconcile({ ...base, heartbeatFailures: 3 })).toEqual({ type: "restart" });
    expect(decideReconcile({ ...base, heartbeatFailures: 3, restartFailures: 3 })).toEqual({
      type: "mark-error",
    });
  });

  it("waits up to 60 seconds before stopping a container with work in flight", () => {
    expect(decideReconcile({ ...base, desired: "stopped", stopWaitedSec: 59 })).toEqual({
      type: "wait-stop",
    });
    expect(decideReconcile({ ...base, desired: "stopped", stopWaitedSec: 60 })).toEqual({
      type: "stop",
    });
    expect(decideReconcile({ ...base, desired: "stopped", actual: "stopped" })).toEqual({
      type: "none",
    });
  });

  it("deletes whatever is left when the machine is deleted", () => {
    expect(decideReconcile({ ...base, desired: "deleted", actual: "running" })).toEqual({
      type: "delete",
    });
    expect(decideReconcile({ ...base, desired: "deleted", actual: "missing" })).toEqual({
      type: "none",
    });
  });
});

describe("idle sleep and wake", () => {
  const now = new Date("2026-11-14T00:00:00Z");

  it("sleeps only after every idle condition holds for the configured duration", () => {
    const idle = {
      now,
      hasActiveTask: false,
      hasAttachedViewer: false,
      hasRoutineSoon: false,
      idleSince: new Date(now.getTime() - 120 * 60_000),
      idleStopMinutes: 120,
    };
    expect(shouldAutoSleep(idle)).toBe(true);
    expect(shouldAutoSleep({ ...idle, hasActiveTask: true })).toBe(false);
    expect(shouldAutoSleep({ ...idle, hasAttachedViewer: true })).toBe(false);
    expect(shouldAutoSleep({ ...idle, hasRoutineSoon: true })).toBe(false);
    expect(shouldAutoSleep({ ...idle, idleSince: new Date(now.getTime() - 119 * 60_000) })).toBe(
      false,
    );
  });

  it("wakes on a message, the computer panel, or a routine due within two minutes", () => {
    expect(shouldAutoWake({ reason: "message" })).toBe(true);
    expect(shouldAutoWake({ reason: "panel" })).toBe(true);
    expect(shouldAutoWake({ reason: "routine", routineInMinutes: 2 })).toBe(true);
    expect(shouldAutoWake({ reason: "routine", routineInMinutes: 3 })).toBe(false);
  });
});
