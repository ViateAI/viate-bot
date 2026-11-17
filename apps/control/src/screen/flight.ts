import type { AgentTool } from "@earendil-works/pi-agent-core";
import { READ_ONLY_TOOLS } from "../m2/risk.js";

/**
 * 同一用户的写工具计数。接管先 pause，排空后暂停一直保持到 lease 进入 ready 或这次交接作废。
 * 取消、断连、stop 通过 bump 作废；barrier 返回后不得再发布 lease。
 * 等待不拿浏览器锁：在途工具靠 finally 里的 leave 退出。
 */
export interface UserFlights {
  pause(userId: string): void;
  resume(userId: string): void;
  paused(userId: string): boolean;
  tryEnter(userId: string, controller?: AbortController): boolean;
  leave(userId: string, controller?: AbortController): void;
  cancel(userId: string): void;
  bump(userId: string): void;
  epoch(userId: string): number;
  inflight(userId: string): number;
  barrier(userId: string, signal?: AbortSignal): Promise<void>;
}

export function createUserFlights(): UserFlights {
  const paused = new Map<string, number>();
  const inflight = new Map<string, number>();
  const epoch = new Map<string, number>();
  const cancels = new Map<string, Set<AbortController>>();
  const waiters = new Map<string, Array<() => void>>();

  function wake(userId: string): void {
    const list = waiters.get(userId);
    if (!list) return;
    waiters.delete(userId);
    for (const resolve of list) resolve();
  }

  return {
    pause(userId) {
      paused.set(userId, (paused.get(userId) ?? 0) + 1);
    },
    resume(userId) {
      const next = (paused.get(userId) ?? 0) - 1;
      if (next <= 0) paused.delete(userId);
      else paused.set(userId, next);
    },
    paused(userId) {
      return (paused.get(userId) ?? 0) > 0;
    },
    tryEnter(userId, controller?: AbortController) {
      if ((paused.get(userId) ?? 0) > 0) return false;
      inflight.set(userId, (inflight.get(userId) ?? 0) + 1);
      if (controller) {
        const group = cancels.get(userId) ?? new Set<AbortController>();
        group.add(controller);
        cancels.set(userId, group);
      }
      return true;
    },
    leave(userId, controller?: AbortController) {
      if (controller) cancels.get(userId)?.delete(controller);
      const next = (inflight.get(userId) ?? 0) - 1;
      if (next <= 0) inflight.delete(userId);
      else inflight.set(userId, next);
      if (next <= 0) wake(userId);
    },
    cancel(userId) {
      for (const controller of cancels.get(userId) ?? []) controller.abort();
    },
    bump(userId) {
      epoch.set(userId, (epoch.get(userId) ?? 0) + 1);
    },
    epoch(userId) {
      return epoch.get(userId) ?? 0;
    },
    inflight(userId) {
      return inflight.get(userId) ?? 0;
    },
    async barrier(userId, signal) {
      const cancelled = () => signal?.aborted === true;
      const fail = () => {
        throw new Error("接管已取消");
      };
      const drop = (resolve: () => void) => {
        const current = waiters.get(userId);
        if (!current) return;
        const next = current.filter((item) => item !== resolve);
        if (next.length === 0) waiters.delete(userId);
        else waiters.set(userId, next);
      };
      for (;;) {
        if (cancelled()) fail();
        if ((inflight.get(userId) ?? 0) === 0) return;
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const list = waiters.get(userId) ?? [];
        list.push(resolve);
        waiters.set(userId, list);
        if (cancelled()) {
          drop(resolve);
          fail();
        }
        if ((inflight.get(userId) ?? 0) === 0) {
          drop(resolve);
          resolve();
        }
        const onAbort = () => {
          drop(resolve);
          reject(new Error("接管已取消"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          await promise;
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      }
    },
  };
}

export function trackExecution<T extends AgentTool>(userId: string, tool: T, flights: UserFlights): T {
  if (tool.name === "request_takeover" || READ_ONLY_TOOLS[tool.name]) return tool;
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const controller = new AbortController();
      if (!flights.tryEnter(userId, controller)) throw new Error("用户正在接管，已拒绝执行");
      const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        return await execute(toolCallId, params, linked, onUpdate);
      } finally {
        flights.leave(userId, controller);
      }
    },
  } as T;
}
