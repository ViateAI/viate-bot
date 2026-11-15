import type { FastifyInstance } from "fastify";
import {
  actorScope,
  createTemplate,
  deleteMachine,
  deleteTemplate,
  listAdminUsers,
  listMachines,
  machineStats,
  provisionUser,
  rebuildMachine,
  restartMachine,
  startMachine,
  stopMachine,
  updateQuota,
  updateSettings,
  updateTemplate,
  AdminRejected,
  type MachineControl,
  type ProvisionDeps,
} from "../admin/service.js";
import { auditRepository } from "../db/audit.js";
import { settingsRepository } from "../db/settings.js";
import { authenticated } from "../auth.js";
import { BotRejected } from "../bot-service.js";
import type { MachineSpec } from "../machines/policy.js";

export function registerAdminRoutes(app: FastifyInstance, deps: ProvisionDeps & { machineControl: MachineControl }): void {
  app.addHook("preHandler", async (request, reply) => {
    const path = request.routeOptions.url ?? "";
    if (!path.startsWith("/api/admin")) return;
    const resolved = authenticated.get(request);
    if (!resolved?.user.isAdmin) return reply.code(404).send({ error: "找不到" });
  });

  app.get<{ Querystring: { limit?: string } }>("/api/admin/users", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      return await listAdminUsers(deps, scope, limitOf(request.query.limit));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/admin/users/provision", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    const body = record(request.body);
    const spec = readSpec(body.spec);
    try {
      const result = await provisionUser(deps, scope, {
        ...(typeof body.userId === "string" ? { userId: body.userId } : {}),
        ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
        ...(typeof body.email === "string" ? { email: body.email } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        templateId: typeof body.templateId === "string" ? body.templateId : "",
        ...(typeof body.channelId === "string" ? { channelId: body.channelId } : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(spec ? { spec } : {}),
        ...(typeof body.maxBots === "number" ? { maxBots: body.maxBots } : {}),
        ...(typeof body.maxConcurrentTasks === "number" ? { maxConcurrentTasks: body.maxConcurrentTasks } : {}),
        ...(typeof body.maxRoutines === "number" ? { maxRoutines: body.maxRoutines } : {}),
      });
      return reply.code(201).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/admin/users/:id/quota", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    const body = record(request.body);
    const spec = readSpec(body.spec);
    try {
      updateQuota(deps.db, scope, request.params.id, {
        ...(typeof body.maxBots === "number" ? { maxBots: body.maxBots } : {}),
        ...(typeof body.maxConcurrentTasks === "number" ? { maxConcurrentTasks: body.maxConcurrentTasks } : {}),
        ...(typeof body.maxRoutines === "number" ? { maxRoutines: body.maxRoutines } : {}),
        ...(spec ? { spec } : {}),
      });
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/admin/templates", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    return { templates: settingsRepository(deps.db).templates() };
  });

  app.post("/api/admin/templates", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      const template = createTemplate(deps.db, scope, templateBody(request.body));
      return reply.code(201).send({ template });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/admin/templates/:id", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      return { template: updateTemplate(deps.db, scope, request.params.id, templateBody(request.body)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/admin/templates/:id", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      deleteTemplate(deps.db, scope, request.params.id);
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/admin/machines", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    return { machines: await listMachines(deps.db, scope) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/machines/:id/stats", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      return await machineStats(deps.machineControl, deps.db, scope, request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/admin/machines/:id/start", async (request, reply) => {
    return act(request, reply, (scope) => startMachine(deps.machineControl, deps.db, scope, request.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/admin/machines/:id/stop", async (request, reply) => {
    return act(request, reply, (scope) => stopMachine(deps.machineControl, deps.db, scope, request.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/admin/machines/:id/restart", async (request, reply) => {
    return act(request, reply, (scope) => restartMachine(deps.machineControl, deps.db, scope, request.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/admin/machines/:id/rebuild", async (request, reply) => {
    return act(request, reply, (scope) => rebuildMachine(deps.machineControl, deps.db, scope, request.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/admin/machines/:id/delete", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    const body = record(request.body);
    const email = typeof body.email === "string" ? body.email : "";
    try {
      await deleteMachine(deps.machineControl, deps.db, scope, request.params.id, email);
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/admin/settings", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    const settings = settingsRepository(deps.db);
    return {
      integration: deps.config.integration,
      defaultChannel: settings.defaultChannel(),
      platformPrompt: settings.platformPrompt(),
    };
  });

  app.patch("/api/admin/settings", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    const body = record(request.body);
    try {
      return updateSettings(deps.db, scope, {
        ...(body.defaultChannel === null || typeof body.defaultChannel === "string" ? { defaultChannel: body.defaultChannel } : {}),
        ...(typeof body.platformPrompt === "string" ? { platformPrompt: body.platformPrompt } : {}),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/admin/audit", async (request, reply) => {
    const scope = actor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    return { audit: auditRepository(deps.db).list(scope, limitOf(request.query.limit)) };
  });
}

function actor(request: { id?: string }) {
  const resolved = authenticated.get(request as never);
  if (!resolved?.user.isAdmin) return undefined;
  return actorScope(resolved.user.id);
}

async function act(
  request: { id?: string; params: { id: string } },
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  run: (scope: ReturnType<typeof actorScope>) => Promise<void>,
) {
  const scope = actor(request);
  if (!scope) return reply.code(404).send({ error: "找不到" });
  try {
    await run(scope);
    return { ok: true };
  } catch (error) {
    return sendError(reply, error);
  }
}

function templateBody(body: unknown) {
  const recordBody = record(body);
  return {
    ...(typeof recordBody.name === "string" ? { name: recordBody.name } : {}),
    ...(typeof recordBody.description === "string" ? { description: recordBody.description } : {}),
    ...(typeof recordBody.instructions === "string" ? { instructions: recordBody.instructions } : {}),
    ...(typeof recordBody.defaultModel === "string" ? { defaultModel: recordBody.defaultModel } : {}),
    ...(typeof recordBody.welcome === "string" ? { welcome: recordBody.welcome } : {}),
    ...(Array.isArray(recordBody.initialMemories) ? { initialMemories: recordBody.initialMemories.filter((item) => typeof item === "string") } : {}),
  };
}

function readSpec(value: unknown): MachineSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const spec = value as { cpu?: unknown; memMb?: unknown; diskGb?: unknown };
  if (typeof spec.cpu !== "number" || typeof spec.memMb !== "number" || typeof spec.diskGb !== "number") return undefined;
  return { cpu: spec.cpu, memMb: spec.memMb, diskGb: spec.diskGb };
}

function limitOf(raw: string | undefined): number {
  const value = raw ? Number(raw) : 50;
  if (!Number.isInteger(value) || value < 1) return 50;
  return Math.min(value, 200);
}

function record(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function sendError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof AdminRejected || error instanceof BotRejected) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  console.error("管理请求失败", error instanceof Error ? error.message : "unknown");
  return reply.code(500).send({ error: "请求失败" });
}
