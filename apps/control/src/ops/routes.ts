import type { FastifyInstance } from "fastify";
import { authenticated } from "../auth.js";
import type { AppDatabase } from "../db/index.js";
import { adminScope } from "../scope.js";
import { adminOverview, authorizeMetrics, metricsSnapshot, renderMetrics } from "./report.js";

export function registerOpsRoutes(
  app: FastifyInstance,
  deps: { db: AppDatabase; now: () => Date; metricsToken: string },
): void {
  app.get("/metrics", async (request, reply) => {
    if (!authorizeMetrics(header(request.headers.authorization), deps.metricsToken)) {
      return reply.code(401).send({ error: "未认证" });
    }
    reply.header("content-type", "text/plain; version=0.0.4");
    return renderMetrics(metricsSnapshot(deps.db, deps.now()));
  });

  app.get("/api/admin/overview", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth?.user.isAdmin) return reply.code(404).send({ error: "\u627e\u4e0d\u5230" });
    return adminOverview(deps.db, deps.now(), adminScope(auth.user.id));
  });
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
