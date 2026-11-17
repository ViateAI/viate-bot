import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "../db/index.js";
import { bots, takeoverLeases, tasks } from "../db/schema.js";
import { ulid } from "../id.js";
import type { UserFlights } from "./flight.js";

type Lease = typeof takeoverLeases.$inferSelect;
type Waiter = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout; cleanup: () => void };

export interface TakeoverLeases {
  arm(): void;
  isActive(botId: string): boolean;
  pending(botId: string): Lease[];
  attach(socketId: string, botId: string, sessionId: string): void;
  canControl(socketId: string): boolean;
  grant(leaseId: string, socketId: string, userId: string, sessionId: string): boolean;
  release(leaseId: string, userId: string, sessionId: string): boolean;
  revoke(leaseId: string, userId: string): boolean;
  detach(socketId: string): void;
  stop(botId: string): void;
  request(input: { botId: string; userId: string; taskId: string; signal?: AbortSignal }): Promise<void>;
}

export function createTakeoverLeases(deps: {
  db: AppDatabase;
  quiesce: (botId: string) => Promise<void>;
  secretWaitMs: number;
  now?: () => Date;
  onWaiting?: (taskId: string) => void;
  flights?: UserFlights;
  /** 远端是否已停止还不确定时，不允许发放接管。 */
  writesBlocked?: (userId: string) => boolean;
  /** 交还、撤销或过期后，先停掉并排空人类输入，再唤醒等待中的代理。 */
  drainInput?: (botId: string) => Promise<void>;
}): TakeoverLeases {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const waiters = new Map<string, Waiter>();
  const ready = new Set<string>();
  const sockets = new Map<string, { botId: string; sessionId: string }>();
  const socketOwners = new Map<string, string>();
  const inputHeld = new Set<string>();
  const byId = (id: string) => deps.db.select().from(takeoverLeases).where(eq(takeoverLeases.id, id)).get();
  const transition = (lease: Lease, state: string) => {
    deps.db.update(takeoverLeases).set({ state, updatedAt: now() }).where(eq(takeoverLeases.id, lease.id)).run();
    if (state !== "active") ready.delete(lease.id);
    const waiter = waiters.get(lease.id);
    if (state === "active") return;
    if (waiter) {
      waiters.delete(lease.id);
      clearTimeout(waiter.timer);
      waiter.cleanup();
    } else if (!inputHeld.has(lease.userId)) return;
    void Promise.resolve(deps.drainInput?.(lease.botId)).then(() => {
      if (inputHeld.delete(lease.userId)) deps.flights?.resume(lease.userId);
      if (!waiter) return;
      if (state === "released" && lease.state === "active") waiter.resolve();
      else waiter.reject(new Error("接管已取消或过期"));
    }, () => {
      inputHeld.add(lease.userId);
      deps.db.update(takeoverLeases).set({ state: "active", updatedAt: now() }).where(eq(takeoverLeases.id, lease.id)).run();
      waiter?.reject(new Error("接管输入未能关闭"));
    });
  };
  const current = (botId: string) => deps.db.select().from(takeoverLeases)
    .where(and(eq(takeoverLeases.botId, botId), inArray(takeoverLeases.state, ["requested", "active"]))).all();

  return {
    arm() {
      deps.db.update(takeoverLeases).set({ state: "expired", updatedAt: now() }).where(eq(takeoverLeases.state, "active")).run();
      const waiting = deps.db.select().from(tasks).where(eq(tasks.state, "waiting_takeover")).all();
      for (const task of waiting) {
        if (current(task.botId).some((lease) => lease.taskId === task.id)) continue;
        const previous = deps.db.select().from(takeoverLeases).where(eq(takeoverLeases.taskId, task.id)).all().at(-1);
        if (previous) deps.db.insert(takeoverLeases).values({ id: ulid(), botId: task.botId, userId: previous.userId, taskId: task.id, state: "requested", createdAt: now(), updatedAt: now() }).run();
      }
    },
    isActive(botId: string) {
      const bot = deps.db.select({ userId: bots.userId }).from(bots).where(eq(bots.id, botId)).get();
      return !!bot && !!deps.db.select({ id: takeoverLeases.id }).from(takeoverLeases).where(and(eq(takeoverLeases.userId, bot.userId), eq(takeoverLeases.state, "active"))).get();
    },
    pending(botId: string) { return current(botId); },
    attach(socketId: string, botId: string, sessionId: string) { sockets.set(socketId, { botId, sessionId }); },
    canControl(socketId: string) {
      const socket = sockets.get(socketId);
      return !!socket && current(socket.botId).some((lease) => lease.state === "active" && lease.sessionId === socket.sessionId && lease.id === socketOwners.get(socketId));
    },
    grant(leaseId: string, socketId: string, userId: string, sessionId: string) {
      const lease = byId(leaseId);
      const socket = sockets.get(socketId);
      if (!lease || lease.userId !== userId || lease.state !== "requested" || !ready.has(lease.id) || !socket || socket.botId !== lease.botId || socket.sessionId !== sessionId || this.isActive(lease.botId) || inputHeld.has(userId) || deps.writesBlocked?.(userId)) return false;
      deps.db.update(takeoverLeases).set({ state: "active", sessionId: socket.sessionId, updatedAt: now() }).where(eq(takeoverLeases.id, lease.id)).run();
      socketOwners.set(socketId, lease.id);
      return true;
    },
    release(leaseId: string, userId: string, sessionId: string) {
      const lease = byId(leaseId);
      if (!lease || lease.userId !== userId || lease.sessionId !== sessionId || lease.state !== "active") return false;
      transition(lease, "released");
      return true;
    },
    revoke(leaseId: string, userId: string) {
      const lease = byId(leaseId);
      if (!lease || lease.userId !== userId || !["requested", "active"].includes(lease.state)) return false;
      transition(lease, "revoked");
      return true;
    },
    detach(socketId: string) {
      const socket = sockets.get(socketId);
      sockets.delete(socketId);
      const leaseId = socketOwners.get(socketId);
      socketOwners.delete(socketId);
      const lease = leaseId ? byId(leaseId) : undefined;
      if (lease?.state === "active") transition(lease, "revoked");
      if (!socket) return;
      const bot = deps.db.select({ userId: bots.userId }).from(bots).where(eq(bots.id, socket.botId)).get();
      if (bot) deps.flights?.bump(bot.userId);
      for (const pending of current(socket.botId)) {
        if (pending.state === "requested") transition(pending, "revoked");
      }
    },
    stop(botId: string) {
      const bot = deps.db.select({ userId: bots.userId }).from(bots).where(eq(bots.id, botId)).get();
      if (bot) deps.flights?.bump(bot.userId);
      for (const lease of current(botId)) transition(lease, "revoked");
    },
    async request(input: { botId: string; userId: string; taskId: string; signal?: AbortSignal }) {
      deps.flights?.pause(input.userId);
      const stamp = deps.flights?.epoch(input.userId) ?? 0;
      const voided = () => (input.signal?.aborted ?? false) || (deps.flights?.epoch(input.userId) ?? 0) !== stamp;
      try {
        deps.flights?.cancel(input.userId);
        await deps.quiesce(input.botId);
        if (deps.flights) await deps.flights.barrier(input.userId, input.signal);
        if (voided()) throw new Error("接管已取消");
        let lease = current(input.botId).find((row) => row.taskId === input.taskId && row.state === "requested");
        if (!lease) {
          if (current(input.botId).length) throw new Error("已有接管请求");
          const id = ulid();
          deps.db.insert(takeoverLeases).values({ id, botId: input.botId, userId: input.userId, taskId: input.taskId, state: "requested", createdAt: now(), updatedAt: now() }).run();
          lease = byId(id)!;
        }
        if (voided()) {
          transition(lease, "revoked");
          throw new Error("接管已取消");
        }
        if (waiters.has(lease.id)) throw new Error("接管请求已在等待");
        deps.db.update(tasks).set({ state: "waiting_takeover" }).where(and(eq(tasks.id, input.taskId), eq(tasks.state, "running"))).run();
        deps.onWaiting?.(input.taskId);
        if (voided()) {
          transition(lease, "revoked");
          deps.db.update(tasks).set({ state: "running" }).where(and(eq(tasks.id, input.taskId), eq(tasks.state, "waiting_takeover"))).run();
          throw new Error("接管已取消");
        }
        const id = lease.id;
        try {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          const cancel = () => { const row = byId(id); if (row && ["requested", "active"].includes(row.state)) transition(row, "revoked"); };
          const timer = setTimeout(() => { const row = byId(id); if (row && ["requested", "active"].includes(row.state)) transition(row, "expired"); }, deps.secretWaitMs);
          input.signal?.addEventListener("abort", cancel, { once: true });
          waiters.set(id, { resolve, reject, timer, cleanup: () => input.signal?.removeEventListener("abort", cancel) });
          if (voided()) {
            clearTimeout(timer);
            input.signal?.removeEventListener("abort", cancel);
            waiters.delete(id);
            transition(lease, "revoked");
            throw new Error("接管已取消");
          }
          ready.add(id);
          await promise;
        } finally {
          if (!inputHeld.has(input.userId)) {
            deps.db.update(tasks).set({ state: "running" }).where(and(eq(tasks.id, input.taskId), eq(tasks.state, "waiting_takeover"))).run();
          }
        }
      } finally {
        if (!inputHeld.has(input.userId)) {
          if ((deps.flights?.inflight(input.userId) ?? 0) > 0) await deps.flights?.barrier(input.userId);
          deps.flights?.resume(input.userId);
        }
      }
    },
  };
}

