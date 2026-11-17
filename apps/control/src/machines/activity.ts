import { chatRepository } from "../db/chat.js";
import type { AppDatabase } from "../db/index.js";
import { hasAttachedViewer } from "../screen/gateway.js";
import { hasRoutineSoon } from "../routines/service.js";
import type { ActivityProbe } from "./reconcile.js";

/** 有排队、运行或等待中的任务时，这台机器不算空闲。屏幕观众也算。 */
export function taskActivityProbe(db: AppDatabase): ActivityProbe {
  const chat = chatRepository(db);
  return {
    hasActiveTask: (userId) => chat.hasActiveForUser(userId),
    hasAttachedViewer,
    hasRoutineSoon: (userId) => hasRoutineSoon(db, userId, new Date()),
  };
}
