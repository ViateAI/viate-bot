/**
 * 人类输入的代数。撤销、交还、过期先增加代数，等正在转发的帧退出，再关掉机器输入。
 * 代理写操作要等这一步结束，避免旧的按键帧在租约失效后仍然打开输入。
 */
export interface ScreenInputDrain {
  epoch(botId: string): number;
  begin(botId: string): number;
  end(botId: string): void;
  bind(botId: string, disable: () => Promise<void>): () => void;
  revoke(botId: string): Promise<void>;
}

export function createScreenInputDrain(): ScreenInputDrain {
  const epoch = new Map<string, number>();
  const inflight = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();
  const disarm = new Map<string, Set<() => Promise<void>>>();

  function wake(botId: string): void {
    const list = waiters.get(botId);
    if (!list) return;
    waiters.delete(botId);
    for (const resolve of list) resolve();
  }

  return {
    epoch(botId) {
      return epoch.get(botId) ?? 0;
    },
    begin(botId) {
      inflight.set(botId, (inflight.get(botId) ?? 0) + 1);
      return epoch.get(botId) ?? 0;
    },
    end(botId) {
      const next = (inflight.get(botId) ?? 1) - 1;
      if (next <= 0) inflight.delete(botId);
      else inflight.set(botId, next);
      if (next <= 0) wake(botId);
    },
    bind(botId, disable) {
      const group = disarm.get(botId) ?? new Set<() => Promise<void>>();
      group.add(disable);
      disarm.set(botId, group);
      return () => {
        group.delete(disable);
        if (group.size === 0) disarm.delete(botId);
      };
    },
    async revoke(botId) {
      epoch.set(botId, (epoch.get(botId) ?? 0) + 1);
      while ((inflight.get(botId) ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const list = waiters.get(botId) ?? [];
          list.push(resolve);
          waiters.set(botId, list);
          if ((inflight.get(botId) ?? 0) === 0) {
            const current = waiters.get(botId);
            if (current) {
              const next = current.filter((item) => item !== resolve);
              if (next.length === 0) waiters.delete(botId);
              else waiters.set(botId, next);
            }
            resolve();
          }
        });
      }
      await Promise.all([...(disarm.get(botId) ?? [])].map((disable) => disable()));
    },
  };
}
