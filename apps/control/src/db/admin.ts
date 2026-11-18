import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import type { AdminScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { bots, tasks, users } from "./schema.js";

const ACTIVE = ["queued", "running", "waiting_approval", "waiting_takeover", "waiting_input"];

export interface AdminUserRecord {
  id: string;
  email: string;
  name: string;
  status: string;
  isAdmin: boolean;
  showProcess: boolean;
}

/** 管理端统计。只返回数量，不返回对话、记忆或密钥。 */
export function adminRepository(db: AppDatabase) {
  return {
    listUsers(scope: AdminScope): AdminUserRecord[] {
      void scope;
      return db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          status: users.status,
          isAdmin: users.isAdmin,
          showProcess: users.showProcess,
        })
        .from(users)
        .all();
    },
    findUser(scope: AdminScope, id: string): AdminUserRecord | undefined {
      void scope;
      const row = db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          status: users.status,
          isAdmin: users.isAdmin,
          showProcess: users.showProcess,
        })
        .from(users)
        .where(eq(users.id, id))
        .get();
      return row ?? undefined;
    },
    countBots(scope: AdminScope, userId: string): number {
      void scope;
      return db
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.userId, userId), isNull(bots.deletedAt)))
        .all().length;
    },
    countTasksSince(scope: AdminScope, userId: string, sinceIso: string): number {
      void scope;
      return db
        .select({ id: tasks.id })
        .from(tasks)
        .innerJoin(bots, eq(bots.id, tasks.botId))
        .where(and(eq(bots.userId, userId), gte(tasks.startedAt, sinceIso)))
        .all().length;
    },
    countActiveTasks(scope: AdminScope, userId: string): number {
      void scope;
      return db
        .select({ id: tasks.id })
        .from(tasks)
        .innerJoin(bots, eq(bots.id, tasks.botId))
        .where(and(eq(bots.userId, userId), inArray(tasks.state, ACTIVE)))
        .all().length;
    },
  };
}
