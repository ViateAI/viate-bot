import type { FastifyInstance } from "fastify";
import { authenticated } from "../auth.js";
import type { AppDatabase } from "../db/index.js";
import { ulid } from "../id.js";

export type NotificationKind = "task_finished" | "task_failed" | "needs_user";
export function notifyTaskSettled(db: AppDatabase, input: { userId: string; botId: string; taskId: string; outcome: "succeeded" | "failed" | "cancelled" | "interrupted" | "needs_user" }): void {
  const kind: NotificationKind = input.outcome === "succeeded" ? "task_finished" : input.outcome === "needs_user" ? "needs_user" : "task_failed";
  db.$client.prepare("insert into notifications (id,user_id,bot_id,task_id,kind,created_at) values (?,?,?,?,?,?)").run(ulid(), input.userId, input.botId, input.taskId, kind, new Date().toISOString());
}

export function registerNotificationRoutes(app: FastifyInstance, deps: { db: AppDatabase }): void {
  app.get("/api/notifications", async (request, reply) => {
    const session = authenticated.get(request);
    if (!session) return reply.code(401).send({ error: "未登录" });
    const notifications = deps.db.$client.prepare("select id,bot_id as botId,task_id as taskId,kind,created_at as createdAt from notifications where user_id=? and read_at is null order by created_at desc").all(session.user.id);
    return { notifications };
  });
  app.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (request, reply) => {
    const session = authenticated.get(request);
    if (!session) return reply.code(401).send({ error: "未登录" });
    const result = deps.db.$client.prepare("update notifications set read_at=coalesce(read_at,?) where id=? and user_id=?").run(new Date().toISOString(), request.params.id, session.user.id);
    if (!result.changes) return reply.code(404).send({ error: "找不到通知" });
    return { ok: true };
  });
}
