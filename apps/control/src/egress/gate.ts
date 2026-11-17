/** waiting_egress 复用 waiting_input 的做法：重启不把这个状态标成 interrupted，只重新武装超时。 */
export interface EgressGate {
  blocked(userId: string): boolean;
  hold(userId: string, taskId: string, startedAt: string): void;
  cancel(taskId: string): void;
  release(userId: string): void;
  arm(tasks: Array<{ id: string; userId: string; startedAt: string | null }>): void;
  close(): void;
}

const WAIT_ERROR = "等待用户网络超时";

export function createEgressGate(deps: {
  blocked: (userId: string) => boolean;
  waitMs: number;
  now: () => Date;
  onResume: (userId: string, taskId: string) => void;
  onFail: (userId: string, taskId: string, error: string) => void;
}): EgressGate {
  const timers = new Map<string, { userId: string; timer: NodeJS.Timeout }>();
  return {
    blocked: deps.blocked,
    hold(userId, taskId, startedAt) {
      this.cancel(taskId);
      const started = Date.parse(startedAt);
      const remain = deps.waitMs - (deps.now().getTime() - (Number.isFinite(started) ? started : deps.now().getTime()));
      const timer = setTimeout(() => {
        timers.delete(taskId);
        deps.onFail(userId, taskId, WAIT_ERROR);
      }, Math.max(0, remain));
      timer.unref?.();
      timers.set(taskId, { userId, timer });
    },
    cancel(taskId) {
      const existing = timers.get(taskId);
      if (!existing) return;
      clearTimeout(existing.timer);
      timers.delete(taskId);
    },
    release(userId) {
      if (deps.blocked(userId)) return;
      for (const [taskId, item] of [...timers]) {
        if (item.userId !== userId) continue;
        clearTimeout(item.timer);
        timers.delete(taskId);
        deps.onResume(userId, taskId);
      }
    },
    arm(tasks) {
      const users = new Set<string>();
      for (const task of tasks) {
        this.hold(task.userId, task.id, task.startedAt ?? deps.now().toISOString());
        users.add(task.userId);
      }
      for (const userId of users) this.release(userId);
    },
    close() {
      for (const item of timers.values()) clearTimeout(item.timer);
      timers.clear();
    },
  };
}

export function waitingEgressRows(db: { prepare: (sql: string) => { all: () => unknown[] } }): Array<{ id: string; userId: string; startedAt: string | null }> {
  return db.prepare(
    `select t.id as id, b.user_id as userId, t.started_at as startedAt
     from tasks t join bots b on b.id = t.bot_id
     where t.state = 'waiting_egress' and b.deleted_at is null`,
  ).all() as Array<{ id: string; userId: string; startedAt: string | null }>;
}
