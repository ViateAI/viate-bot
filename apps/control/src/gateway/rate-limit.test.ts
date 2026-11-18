import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createRateLimiter, manualRateClock, systemRateClock, type RateRequest } from "./rate-limit.js";

function request(
  clock: ReturnType<typeof manualRateClock>,
  limits: { userPerMin: number; botPerMin: number },
  userKey: string,
  botKey: string,
  signal?: AbortSignal,
  deadline = 1_000_000,
): RateRequest {
  void clock;
  return {
    userKey,
    botKey,
    limits: () => limits,
    deadline,
    ...(signal ? { signal } : {}),
  };
}

describe("model rate wait", () => {
  it("releases timers and abort listeners when settings wake a waiter", async () => {
    vi.useFakeTimers();
    try {
      const clock = systemRateClock();
      const limiter = createRateLimiter(clock);
      const limits = { userPerMin: 1, botPerMin: 1 };
      const controller = new AbortController();
      const input = {
        userKey: "user:a", botKey: "bot:a", limits: () => limits,
        deadline: clock.now() + 600_000, signal: controller.signal,
      };
      await limiter.acquire(input);
      const maintenanceTimers = vi.getTimerCount();
      const waiting = limiter.acquire(input);
      expect(vi.getTimerCount()).toBe(maintenanceTimers + 1);
      limits.userPerMin = 0;
      limits.botPerMin = 0;
      limiter.poke();
      await expect(waiting).resolves.toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(maintenanceTimers);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up a queued deadline timer when the earlier waiter is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const clock = systemRateClock();
      const limiter = createRateLimiter(clock);
      const limits = { userPerMin: 2, botPerMin: 1 };
      const controller = new AbortController();
      const input = { userKey: "user:a", botKey: "bot:a", limits: () => limits, deadline: clock.now() + 600_000 };
      await limiter.acquire(input);
      const maintenanceTimers = vi.getTimerCount();
      const blocked = limiter.acquire({ ...input, signal: controller.signal });
      const queued = limiter.acquire({ ...input, botKey: "bot:b" });
      expect(vi.getTimerCount()).toBe(maintenanceTimers + 2);
      controller.abort();
      await expect(blocked).resolves.toEqual({ ok: false, reason: "aborted" });
      await expect(queued).resolves.toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(maintenanceTimers);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits an unrelated user immediately while another bot window is full", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 2, botPerMin: 1 };
    const controller = new AbortController();
    await limiter.acquire(request(clock, limits, "user:a", "bot:a"));
    const blocked = limiter.acquire(request(clock, limits, "user:a", "bot:a", controller.signal));
    const order: string[] = [];
    const independent = limiter.acquire(request(clock, limits, "user:b", "bot:b", controller.signal)).then((result) => {
      if (result.ok) order.push("independent");
      return result;
    });
    try {
      await Promise.resolve();
      expect(order).toEqual(["independent"]);
      await expect(independent).resolves.toEqual({ ok: true });
      expect(clock.now()).toBe(0);
    } finally {
      controller.abort();
      await Promise.all([blocked, independent]);
    }
  });

  it("keeps same-user bots in arrival order without exceeding the user window", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 2, botPerMin: 1 };
    await limiter.acquire(request(clock, limits, "user:a", "bot:a"));
    const order: string[] = [];
    const controller = new AbortController();
    const earlier = limiter.acquire(request(clock, limits, "user:a", "bot:a", controller.signal)).then((result) => {
      if (result.ok) order.push("earlier");
      return result;
    });
    const later = limiter.acquire(request(clock, limits, "user:a", "bot:b", controller.signal)).then((result) => {
      if (result.ok) order.push("later");
      return result;
    });
    const last = limiter.acquire(request(clock, limits, "user:a", "bot:c", controller.signal)).then((result) => {
      if (result.ok) order.push("last");
      return result;
    });
    try {
      await Promise.resolve();
      expect(order).toEqual([]);
      clock.advance(60_000);
      await expect(earlier).resolves.toEqual({ ok: true });
      await expect(later).resolves.toEqual({ ok: true });
      expect(order).toEqual(["earlier", "later"]);
      clock.advance(60_000);
      await expect(last).resolves.toEqual({ ok: true });
      expect(order).toEqual(["earlier", "later", "last"]);
    } finally {
      controller.abort();
      await Promise.all([earlier, later, last]);
    }
  });

  it("keeps requests sharing only a bot window in arrival order", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 1, botPerMin: 1 };
    await limiter.acquire(request(clock, limits, "user:seed", "bot:a"));
    const order: string[] = [];
    const controller = new AbortController();
    const earlier = limiter.acquire(request(clock, limits, "user:a", "bot:a", controller.signal)).then((result) => {
      if (result.ok) order.push("earlier");
      return result;
    });
    const later = limiter.acquire(request(clock, limits, "user:b", "bot:a", controller.signal)).then((result) => {
      if (result.ok) order.push("later");
      return result;
    });
    try {
      clock.advance(60_000);
      await expect(earlier).resolves.toEqual({ ok: true });
      expect(order).toEqual(["earlier"]);
      clock.advance(60_000);
      await expect(later).resolves.toEqual({ ok: true });
      expect(order).toEqual(["earlier", "later"]);
    } finally {
      controller.abort();
      await Promise.all([earlier, later]);
    }
  });

  it("reclaims inactive keys at expiry without another request or an idle timer", async () => {
    vi.useFakeTimers();
    try {
      const clock = systemRateClock();
      const limiter = createRateLimiter(clock);
      const input = {
        userKey: "user:a", botKey: "bot:a", limits: () => ({ userPerMin: 1, botPerMin: 1 }),
        deadline: clock.now() + 600_000,
      };
      await limiter.acquire(input);
      expect(limiter.trackedKeyCount).toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(limiter.trackedKeyCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes an empty key after its last waiter cancels without forgetting live windows", async () => {
    vi.useFakeTimers();
    try {
      const clock = systemRateClock();
      const limiter = createRateLimiter(clock);
      const input = {
        userKey: "user:a", botKey: "bot:a", limits: () => ({ userPerMin: 1, botPerMin: 1 }),
        deadline: clock.now() + 600_000,
      };
      await limiter.acquire(input);
      await vi.advanceTimersByTimeAsync(30_000);
      await limiter.acquire({ ...input, userKey: "user:b", botKey: "bot:b" });
      const controller = new AbortController();
      const waiting = limiter.acquire({ ...input, botKey: "bot:b", signal: controller.signal });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(limiter.trackedKeyCount).toBe(3);
      controller.abort();
      await expect(waiting).resolves.toEqual({ ok: false, reason: "aborted" });
      expect(limiter.trackedKeyCount).toBe(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(limiter.trackedKeyCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes an independently eligible waiter after settings change even if the oldest remains blocked", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 0, botPerMin: 2 };
    await limiter.acquire(request(clock, limits, "user:a", "bot:a"));
    await limiter.acquire(request(clock, limits, "user:a", "bot:a"));
    await limiter.acquire(request(clock, limits, "user:b", "bot:b"));
    limits.botPerMin = 1;
    const controller = new AbortController();
    let firstAdmitted = false;
    const first = limiter.acquire(request(clock, limits, "user:a", "bot:a", controller.signal)).then((result) => {
      firstAdmitted = result.ok;
      return result;
    });
    const second = limiter.acquire(request(clock, limits, "user:b", "bot:b", controller.signal));
    try {
      limits.botPerMin = 2;
      limiter.poke();
      await expect(second).resolves.toEqual({ ok: true });
      expect(firstAdmitted).toBe(false);
      expect(clock.now()).toBe(0);
    } finally {
      controller.abort();
      await Promise.all([first, second]);
    }
  });

  it("retains unexpired history while reclaiming unrelated inactive keys", async () => {
    vi.useFakeTimers();
    try {
      const clock = systemRateClock();
      const limiter = createRateLimiter(clock);
      const input = {
        userKey: "user:a", botKey: "bot:a", limits: () => ({ userPerMin: 1, botPerMin: 1 }),
        deadline: clock.now() + 600_000,
      };
      await limiter.acquire(input);
      await vi.advanceTimersByTimeAsync(30_000);
      await limiter.acquire({ ...input, userKey: "user:b", botKey: "bot:b" });
      expect(limiter.trackedKeyCount).toBe(4);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(limiter.trackedKeyCount).toBe(2);
      const controller = new AbortController();
      const waiting = limiter.acquire({ ...input, userKey: "user:b", botKey: "bot:b", signal: controller.signal });
      let admitted = false;
      void waiting.then((result) => { admitted = result.ok; });
      await Promise.resolve();
      expect(admitted).toBe(false);
      controller.abort();
      await expect(waiting).resolves.toEqual({ ok: false, reason: "aborted" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(limiter.trackedKeyCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the window and then admits in arrival order", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 1, botPerMin: 1 };
    const first = await limiter.acquire(request(clock, limits, "user:a", "bot:a"));
    expect(first).toEqual({ ok: true });
    const order: string[] = [];
    const second = limiter.acquire(request(clock, limits, "user:a", "bot:a")).then((result) => {
      order.push("second");
      return result;
    });
    await clock.untilSleeping();
    const third = limiter.acquire(request(clock, limits, "user:a", "bot:a")).then((result) => {
      order.push("third");
      return result;
    });
    clock.advance(60_000);
    await expect(second).resolves.toEqual({ ok: true });
    expect(order).toEqual(["second"]);
    clock.advance(60_000);
    await expect(third).resolves.toEqual({ ok: true });
    expect(order).toEqual(["second", "third"]);
  });

  it("does not record a hit when the wait is aborted", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 2, botPerMin: 1 };
    await limiter.acquire(request(clock, limits, "user:a", "bot:a"));
    const controller = new AbortController();
    const waiting = limiter.acquire(request(clock, limits, "user:a", "bot:a", controller.signal));
    await clock.untilSleeping();
    controller.abort();
    await expect(waiting).resolves.toEqual({ ok: false, reason: "aborted" });
    const otherBot = await limiter.acquire(request(clock, limits, "user:a", "bot:b"));
    expect(otherBot).toEqual({ ok: true });
  });

  it("records one successful call on both the user and bot windows", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 1, botPerMin: 1 };
    await limiter.acquire(request(clock, limits, "user:a", "bot:a"));
    const userAbort = new AbortController();
    const sameUser = limiter.acquire(request(clock, limits, "user:a", "bot:b", userAbort.signal));
    await clock.untilSleeping();
    userAbort.abort();
    await expect(sameUser).resolves.toEqual({ ok: false, reason: "aborted" });
    const botAbort = new AbortController();
    const sameBot = limiter.acquire(request(clock, limits, "user:b", "bot:a", botAbort.signal));
    await clock.untilSleeping();
    botAbort.abort();
    await expect(sameBot).resolves.toEqual({ ok: false, reason: "aborted" });
    const open = await limiter.acquire(request(clock, limits, "user:c", "bot:c"));
    expect(open).toEqual({ ok: true });
  });

  it("treats 0 as unlimited", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 0, botPerMin: 0 };
    for (let index = 0; index < 5; index += 1) {
      const result = await limiter.acquire(request(clock, limits, "user:a", "bot:a"));
      expect(result).toEqual({ ok: true });
    }
    expect(clock.now()).toBe(0);
  });

  it("applies a limit change without waiting out the window", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 1, botPerMin: 1 };
    await limiter.acquire(request(clock, limits, "user:a", "bot:a"));
    const waiting = limiter.acquire(request(clock, limits, "user:a", "bot:a"));
    await clock.untilSleeping();
    limits.userPerMin = 0;
    limits.botPerMin = 0;
    limiter.poke();
    await expect(waiting).resolves.toEqual({ ok: true });
    expect(clock.now()).toBe(0);
  });

  it("stops at the deadline without taking a slot", async () => {
    const clock = manualRateClock(0);
    const limiter = createRateLimiter(clock);
    const limits = { userPerMin: 1, botPerMin: 1 };
    await limiter.acquire(request(clock, limits, "user:a", "bot:a", undefined, 10_000));
    const waiting = limiter.acquire(request(clock, limits, "user:a", "bot:a", undefined, 500));
    await clock.untilSleeping();
    clock.advance(500);
    await expect(waiting).resolves.toEqual({ ok: false, reason: "deadline" });
    const freed = await limiter.acquire(request(clock, limits, "user:b", "bot:b", undefined, 10_000));
    expect(freed).toEqual({ ok: true });
  });
});
