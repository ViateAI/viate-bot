import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { bots, conversations, messages, taskSteps, tasks } from "./schema.js";

const ACTIVE_STATES = ["queued", "running", "waiting_approval", "waiting_takeover"];

export interface ConversationRecord {
  id: string;
  botId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: string;
  contentJson: string;
  taskId: string | null;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  botId: string;
  conversationId: string | null;
  state: string;
  trigger: string;
  stepCount: number;
  usageJson: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface StepRecord {
  id: string;
  taskId: string;
  seq: number;
  kind: string;
  requestJson: string;
  responseJson: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

/** 调度和恢复只用这些元数据，不带消息正文。 */
export interface TaskMeta {
  id: string;
  botId: string;
  userId: string;
  conversationId: string | null;
  state: string;
}

export interface TaskPatch {
  state?: string;
  error?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  stepCount?: number;
  usageJson?: string | null;
}

export function chatRepository(db: AppDatabase) {
  return {
    listConversations(scope: UserScope, botId: string): ConversationRecord[] | undefined {
      if (!ownsBot(db, scope, botId)) return undefined;
      return db
        .select()
        .from(conversations)
        .where(eq(conversations.botId, botId))
        .orderBy(desc(conversations.updatedAt))
        .all()
        .map(toConversation);
    },
    findConversation(scope: UserScope, id: string): ConversationRecord | undefined {
      const row = db
        .select({ conversation: conversations })
        .from(conversations)
        .innerJoin(bots, eq(bots.id, conversations.botId))
        .where(and(eq(conversations.id, id), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .get();
      return row ? toConversation(row.conversation) : undefined;
    },
    insertConversation(scope: UserScope, draft: { id: string; botId: string; title: string }): ConversationRecord | undefined {
      if (!ownsBot(db, scope, draft.botId)) return undefined;
      const now = new Date().toISOString();
      db.insert(conversations)
        .values({ id: draft.id, botId: draft.botId, title: draft.title, createdAt: now, updatedAt: now })
        .run();
      return this.findConversation(scope, draft.id);
    },
    touchConversation(scope: UserScope, id: string, title?: string): void {
      if (!this.findConversation(scope, id)) return;
      db.update(conversations)
        .set({
          updatedAt: new Date().toISOString(),
          ...(title !== undefined ? { title } : {}),
        })
        .where(eq(conversations.id, id))
        .run();
    },
    listMessages(scope: UserScope, conversationId: string): MessageRecord[] | undefined {
      if (!this.findConversation(scope, conversationId)) return undefined;
      const rows = db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.id))
        .limit(500)
        .all()
        .map(toMessage);
      rows.reverse();
      return rows;
    },
    findMessage(scope: UserScope, id: string): MessageRecord | undefined {
      const row = db
        .select({ message: messages })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(bots, eq(bots.id, conversations.botId))
        .where(and(eq(messages.id, id), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .get();
      return row ? toMessage(row.message) : undefined;
    },
    insertMessage(
      scope: UserScope,
      draft: { id: string; conversationId: string; role: string; contentJson: string; taskId: string | null },
    ): MessageRecord | undefined {
      if (!this.findConversation(scope, draft.conversationId)) return undefined;
      const createdAt = new Date().toISOString();
      db.insert(messages)
        .values({
          id: draft.id,
          conversationId: draft.conversationId,
          role: draft.role,
          contentJson: draft.contentJson,
          taskId: draft.taskId,
          createdAt,
        })
        .run();
      return this.findMessage(scope, draft.id);
    },
    findTask(scope: UserScope, id: string): TaskRecord | undefined {
      const row = db
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(bots, eq(bots.id, tasks.botId))
        .where(and(eq(tasks.id, id), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
        .get();
      return row ? toTask(row.task) : undefined;
    },
    listTasks(scope: UserScope, conversationId: string): TaskRecord[] | undefined {
      const conversation = this.findConversation(scope, conversationId);
      if (!conversation) return undefined;
      return db
        .select()
        .from(tasks)
        .where(eq(tasks.conversationId, conversationId))
        .orderBy(desc(tasks.id))
        .all()
        .map(toTask);
    },
    findActiveByBot(scope: UserScope, botId: string, state: "running" | "queued"): TaskRecord | undefined {
      if (!ownsBot(db, scope, botId)) return undefined;
      const row = db
        .select()
        .from(tasks)
        .where(and(eq(tasks.botId, botId), eq(tasks.state, state)))
        .orderBy(desc(tasks.id))
        .get();
      return row ? toTask(row) : undefined;
    },
    insertTask(
      scope: UserScope,
      draft: { id: string; botId: string; conversationId: string },
    ): TaskRecord | undefined {
      if (!ownsBot(db, scope, draft.botId)) return undefined;
      db.insert(tasks)
        .values({
          id: draft.id,
          botId: draft.botId,
          conversationId: draft.conversationId,
          state: "queued",
          trigger: "user",
          stepCount: 0,
        })
        .run();
      return this.findTask(scope, draft.id);
    },
    updateTask(scope: UserScope, id: string, patch: TaskPatch): boolean {
      if (!this.findTask(scope, id)) return false;
      const result = db
        .update(tasks)
        .set({
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
          ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
          ...(patch.stepCount !== undefined ? { stepCount: patch.stepCount } : {}),
          ...(patch.usageJson !== undefined ? { usageJson: patch.usageJson } : {}),
        })
        .where(eq(tasks.id, id))
        .run();
      return result.changes > 0;
    },
    listSteps(scope: UserScope, taskId: string): StepRecord[] | undefined {
      if (!this.findTask(scope, taskId)) return undefined;
      return db.select().from(taskSteps).where(eq(taskSteps.taskId, taskId)).orderBy(taskSteps.seq).all().map(toStep);
    },
    insertStep(
      scope: UserScope,
      draft: { id: string; taskId: string; seq: number; kind: string; requestJson: string; status: string },
    ): StepRecord | undefined {
      if (!this.findTask(scope, draft.taskId)) return undefined;
      db.insert(taskSteps)
        .values({
          id: draft.id,
          taskId: draft.taskId,
          seq: draft.seq,
          kind: draft.kind,
          requestJson: draft.requestJson,
          status: draft.status,
          startedAt: new Date().toISOString(),
        })
        .run();
      return this.listSteps(scope, draft.taskId)?.find((step) => step.id === draft.id);
    },
    finishStep(
      scope: UserScope,
      id: string,
      patch: { status: string; responseJson: string },
    ): boolean {
      const row = db
        .select({ step: taskSteps, userId: bots.userId })
        .from(taskSteps)
        .innerJoin(tasks, eq(tasks.id, taskSteps.taskId))
        .innerJoin(bots, eq(bots.id, tasks.botId))
        .where(and(eq(taskSteps.id, id), eq(bots.userId, scope.userId)))
        .get();
      if (!row) return false;
      const result = db
        .update(taskSteps)
        .set({ status: patch.status, responseJson: patch.responseJson, endedAt: new Date().toISOString() })
        .where(eq(taskSteps.id, id))
        .run();
      return result.changes > 0;
    },
    maxSeq(scope: UserScope, taskId: string): number {
      if (!this.findTask(scope, taskId)) return 0;
      const row = db
        .select({ seq: taskSteps.seq })
        .from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(desc(taskSteps.seq))
        .get();
      return row?.seq ?? 0;
    },
    /** 只回答有没有，不返回任务内容。给机器对账用。 */
    hasActiveForUser(userId: string): boolean {
      const row = db
        .select({ id: tasks.id })
        .from(tasks)
        .innerJoin(bots, eq(bots.id, tasks.botId))
        .where(and(eq(bots.userId, userId), inArray(tasks.state, ACTIVE_STATES), isNull(bots.deletedAt)))
        .get();
      return row !== undefined;
    },
    /** 调度器重新装载排队和运行中的任务。只有 id 和归属，没有正文。 */
    systemTaskMeta(states: string[]): TaskMeta[] {
      if (states.length === 0) return [];
      return db
        .select({
          id: tasks.id,
          botId: tasks.botId,
          userId: bots.userId,
          conversationId: tasks.conversationId,
          state: tasks.state,
        })
        .from(tasks)
        .innerJoin(bots, eq(bots.id, tasks.botId))
        .where(inArray(tasks.state, states))
        .all();
    },
  };
}

function ownsBot(db: AppDatabase, scope: UserScope, botId: string): boolean {
  return (
    db
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, scope.userId), isNull(bots.deletedAt)))
      .get() !== undefined
  );
}

function toConversation(row: typeof conversations.$inferSelect): ConversationRecord {
  return {
    id: row.id,
    botId: row.botId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: typeof messages.$inferSelect): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    contentJson: row.contentJson,
    taskId: row.taskId,
    createdAt: row.createdAt,
  };
}

function toTask(row: typeof tasks.$inferSelect): TaskRecord {
  return {
    id: row.id,
    botId: row.botId,
    conversationId: row.conversationId,
    state: row.state,
    trigger: row.trigger,
    stepCount: row.stepCount,
    usageJson: row.usageJson,
    error: row.error,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

function toStep(row: typeof taskSteps.$inferSelect): StepRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    seq: row.seq,
    kind: row.kind,
    requestJson: row.requestJson,
    responseJson: row.responseJson,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}
