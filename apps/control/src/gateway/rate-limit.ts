export interface RateClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RateLimits {
  userPerMin: number;
  botPerMin: number;
}

export interface RateRequest {
  userKey: string;
  botKey: string;
  /** 每次循环都重新读。0 表示这个窗口不限制。 */
  limits(): RateLimits;
  /** 绝对时间。到点仍没有空位就返回，不记这一次。 */
  deadline: number;
  signal?: AbortSignal;
}

export type RateWait = { ok: true } | { ok: false; reason: "aborted" | "deadline" };

interface Sleeper {
  remaining: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

interface Ticket {
  userKey: string;
  botKey: string;
  wake(): void;
  poked(): Promise<void>;
}

const WINDOW_MS = 60_000;

export function systemRateClock(): RateClock {
  return {
    now: () => Date.now(),
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(new Error("aborted"));
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        timer.unref?.();
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export function manualRateClock(start = 0): RateClock & {
  advance(ms: number): void;
  untilSleeping(): Promise<void>;
} {
  let now = start;
  const sleepers: Sleeper[] = [];
  const waiting: Array<() => void> = [];
  const notify = () => {
    const pending = waiting.splice(0);
    for (const resolve of pending) resolve();
  };
  return {
    now: () => now,
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(new Error("aborted"));
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const entry: Sleeper = { remaining: ms, resolve, reject, onAbort: () => {} };
        if (signal) entry.signal = signal;
        entry.onAbort = () => {
          const index = sleepers.indexOf(entry);
          if (index >= 0) sleepers.splice(index, 1);
          reject(new Error("aborted"));
        };
        sleepers.push(entry);
        signal?.addEventListener("abort", entry.onAbort, { once: true });
        notify();
      });
    },
    advance(ms) {
      now += ms;
      for (const entry of [...sleepers]) {
        entry.remaining -= ms;
        if (entry.remaining > 0) continue;
        const index = sleepers.indexOf(entry);
        if (index >= 0) sleepers.splice(index, 1);
        entry.signal?.removeEventListener("abort", entry.onAbort);
        entry.resolve();
      }
    },
    untilSleeping() {
      if (sleepers.length > 0) return Promise.resolve();
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

export function createRateLimiter(clock: RateClock): {
  acquire(request: RateRequest): Promise<RateWait>;
  poke(): void;
  readonly trackedKeyCount: number;
} {
  const hits = new Map<string, number[]>();
  const queue: Ticket[] = [];
  let cleanupTimer: AbortController | undefined;
  let cleanupAt = Infinity;

  function prune(key: string, now: number): number[] {
    const recent = hits.get(key) ?? [];
    let expired = 0;
    while (expired < recent.length && recent[expired]! <= now - WINDOW_MS) expired += 1;
    if (expired > 0) recent.splice(0, expired);
    if (recent.length === 0 && !queue.some((ticket) => ticket.userKey === key || ticket.botKey === key)) hits.delete(key);
    return recent;
  }

  function scheduleCleanup(at: number): void {
    if (cleanupTimer && cleanupAt <= at) return;
    cleanupTimer?.abort();
    const controller = new AbortController();
    cleanupTimer = controller;
    cleanupAt = at;
    void clock.sleep(Math.max(0, at - clock.now()), controller.signal).then(() => {
      if (controller.signal.aborted) return;
      cleanupTimer = undefined;
      cleanupAt = Infinity;
      const now = clock.now();
      let next = Infinity;
      for (const key of hits.keys()) {
        const oldest = prune(key, now)[0];
        if (oldest !== undefined) next = Math.min(next, oldest + WINDOW_MS);
      }
      if (next < Infinity) scheduleCleanup(next);
    }, () => { /* Replaced cleanup sleepers are aborted. */ });
  }

  function waitMs(key: string, limit: number, now: number): number {
    if (limit <= 0) return 0;
    const recent = prune(key, now);
    if (recent.length < limit) return 0;
    const blocking = recent[recent.length - limit];
    if (blocking === undefined) return 0;
    return Math.max(0, blocking + WINDOW_MS - now);
  }

  function record(key: string, limit: number, now: number): void {
    if (limit <= 0) return;
    const recent = prune(key, now);
    recent.push(now);
    hits.set(key, recent);
    scheduleCleanup(recent[0]! + WINDOW_MS);
  }

  function poke(): void {
    for (const ticket of queue) ticket.wake();
  }

  async function acquire(request: RateRequest): Promise<RateWait> {
    const ticket = createTicket(request.userKey, request.botKey);
    queue.push(ticket);
    try {
      for (;;) {
        if (request.signal?.aborted) return { ok: false, reason: "aborted" };
        const now = clock.now();
        if (now >= request.deadline) return { ok: false, reason: "deadline" };
        // Only shared windows impose FIFO. A later bot cannot steal its user's
        // capacity from an earlier blocked bot; disjoint users proceed independently.
        let preceded = false;
        for (const earlier of queue) {
          if (earlier === ticket) break;
          if (earlier.userKey === request.userKey || earlier.botKey === request.botKey) {
            preceded = true;
            break;
          }
        }
        if (preceded) {
          const outcome = await waitFor(clock, request.deadline - now, request.signal, ticket.poked());
          if (outcome === "abort") return { ok: false, reason: "aborted" };
          continue;
        }
        const limits = request.limits();
        const userWait = waitMs(request.userKey, limits.userPerMin, now);
        const botWait = waitMs(request.botKey, limits.botPerMin, now);
        if (userWait === 0 && botWait === 0) {
          record(request.userKey, limits.userPerMin, now);
          record(request.botKey, limits.botPerMin, now);
          return { ok: true };
        }
        const delay = Math.min(...[userWait, botWait].filter((item) => item > 0), request.deadline - now);
        const outcome = await waitFor(clock, delay, request.signal, ticket.poked());
        if (outcome === "abort") return { ok: false, reason: "aborted" };
      }
    } finally {
      const index = queue.indexOf(ticket);
      if (index >= 0) queue.splice(index, 1);
      const now = clock.now();
      prune(request.userKey, now);
      prune(request.botKey, now);
      for (const later of queue) {
        if (later.userKey === request.userKey || later.botKey === request.botKey) later.wake();
      }
    }
  }

  return { acquire, poke, get trackedKeyCount() { return hits.size; } };
}

function createTicket(userKey: string, botKey: string): Ticket {
  let latched = false;
  let resolver: (() => void) | undefined;
  return {
    userKey,
    botKey,
    wake() {
      latched = true;
      const resolve = resolver;
      resolver = undefined;
      resolve?.();
    },
    poked() {
      if (latched) {
        latched = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        resolver = () => {
          latched = false;
          resolver = undefined;
          resolve();
        };
      });
    },
  };
}

function waitFor(
  clock: RateClock,
  ms: number,
  signal: AbortSignal | undefined,
  poke: Promise<void>,
): Promise<"sleep" | "poke" | "abort"> {
  if (signal?.aborted) return Promise.resolve("abort");
  if (ms <= 0) return Promise.resolve("sleep");
  return new Promise((resolve) => {
    let settled = false;
    const sleeper = new AbortController();
    const onAbort = () => finish("abort");
    const finish = (reason: "sleep" | "poke" | "abort") => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      sleeper.abort();
      resolve(reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    clock.sleep(ms, sleeper.signal).then(
      () => finish(signal?.aborted ? "abort" : "sleep"),
      () => finish("abort"),
    );
    void poke.then(() => finish("poke"));
  });
}
