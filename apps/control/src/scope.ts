/** 一次用户请求或任务。仓储层用它强制查询条件里的 user_id。 */
export interface UserScope {
  readonly kind: "user";
  readonly userId: string;
}

/**
 * 管理端或控制面自己的维护任务。
 * 不能代替用户范围：按 id 读写时仍然要同时给出 user_id。
 */
export interface AdminScope {
  readonly kind: "admin";
  readonly actorUserId: string;
}

export function userScope(userId: string): UserScope {
  if (userId.length === 0) throw new Error("userId 不能为空");
  return { kind: "user", userId };
}

export function adminScope(actorUserId: string): AdminScope {
  if (actorUserId.length === 0) throw new Error("actorUserId 不能为空");
  return { kind: "admin", actorUserId };
}

/** 对账循环没有管理员会话，用这个范围列出机器，再按每台机器自己的 user_id 读写。 */
export const schedulerScope: AdminScope = { kind: "admin", actorUserId: "scheduler" };
