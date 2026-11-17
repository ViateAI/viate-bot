import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticated } from "../auth.js";
import type { AppDatabase } from "../db/index.js";
import { RoutineError, routineService, type RoutineWork } from "./service.js";

export function registerRoutineRoutes(app: FastifyInstance, deps: { db: AppDatabase; enqueue: (work: RoutineWork) => Promise<string> | string }): void {
  const service = routineService(deps.db);
  const user = (request: FastifyRequest, reply: FastifyReply): string | undefined => {
    const session = authenticated.get(request);
    if (!session) { reply.code(401).send({ error: "未登录" }); return undefined; }
    return session.user.id;
  };
  const error = (reply: FastifyReply, caught: unknown) => {
    if (caught instanceof RoutineError) return reply.code(caught.statusCode).send({ error: caught.message });
    throw caught;
  };
  app.get<{ Params: { botId: string } }>("/api/bots/:botId/routines", async (request, reply) => {
    const id = user(request, reply); if (!id) return;
    const routines = service.list(id, request.params.botId);
    if (!routines) return reply.code(404).send({ error: "找不到 bot" });
    return { routines };
  });
  app.get<{ Params: { id: string } }>("/api/routines/:id/runs", async (request, reply) => {
    const id = user(request, reply); if (!id) return;
    try { return { runs: service.history(id, request.params.id) }; } catch (caught) { return error(reply, caught); }
  });
  app.post<{ Params: { id: string } }>("/api/routines/:id/confirm", async (request, reply) => {
    const id = user(request, reply); if (!id) return;
    try { service.confirm(id, request.params.id); return { ok: true }; } catch (caught) { return error(reply, caught); }
  });
  app.post<{ Params: { id: string }; Body: { paused?: boolean } }>("/api/routines/:id/pause", async (request, reply) => {
    const id = user(request, reply); if (!id) return;
    if (typeof request.body?.paused !== "boolean") return reply.code(400).send({ error: "需要 paused" });
    try { service.pause(id, request.params.id, request.body.paused); return { ok: true }; } catch (caught) { return error(reply, caught); }
  });
  app.post<{ Params: { id: string } }>("/api/routines/:id/run", async (request, reply) => {
    const id = user(request, reply); if (!id) return;
    try {
      const work = service.manual(id, request.params.id);
      const taskId = await deps.enqueue(work);
      service.attachTask(work.runId, taskId);
      return { runId: work.runId, taskId };
    } catch (caught) { return error(reply, caught); }
  });
  app.delete<{ Params: { id: string } }>("/api/routines/:id", async (request, reply) => {
    const id = user(request, reply); if (!id) return;
    try { service.remove(id, request.params.id); return { ok: true }; } catch (caught) { return error(reply, caught); }
  });
}
