import type { FastifyInstance } from "fastify";
import { authenticated } from "../auth.js";
import { encrypt } from "../crypto.js";
import { auditRepository } from "../db/audit.js";
import type { AppDatabase } from "../db/index.js";
import { secretRepository } from "../db/secrets.js";
import { ulid } from "../id.js";
import { AUDIT_ACTIONS } from "../m2/events.js";
import { adminScope, userScope } from "../scope.js";

const SECRET_NAME = /^[a-z0-9_]{1,64}$/;
const SECRET_LIMIT = 4096;

export function registerSecretRoutes(app: FastifyInstance, deps: { db: AppDatabase; key: Buffer }): void {
  const store = secretRepository(deps.db);

  app.get("/api/secrets", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    return {
      secrets: store.listUser(userScope(auth.user.id)).map((row) => ({
        name: row.name,
        updatedAt: row.createdAt,
      })),
    };
  });

  app.put("/api/secrets", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    return reply.code(400).send({ error: "密钥名不合法" });
  });

  app.put<{ Params: { name: string } }>("/api/secrets/:name", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const name = request.params.name;
    if (!validName(name)) return reply.code(400).send({ error: "密钥名不合法" });
    const value = (request.body as { value?: unknown } | null)?.value;
    if (typeof value !== "string") return reply.code(400).send({ error: "密钥内容不合法" });
    if (value.length === 0) return reply.code(400).send({ error: "密钥内容不能为空" });
    if (value.length > SECRET_LIMIT) return reply.code(400).send({ error: "密钥不能超过 4096 个字符" });
    const scope = userScope(auth.user.id);
    const rows = store.list(scope).filter((row) => row.name === name);
    if (rows.some((row) => row.scope === "app" || row.name.startsWith("app:"))) {
      return reply.code(400).send({ error: "不能覆盖应用独立密钥" });
    }
    const created = rows.length === 0;
    store.upsert(scope, { id: ulid(), name, valueEnc: encrypt(deps.key, value), scope: "browser" });
    const saved = store.find(scope, name);
    if (!saved) return reply.code(500).send({ error: "保存失败" });
    auditRepository(deps.db).write(adminScope(auth.user.id), AUDIT_ACTIONS.secretSaved, name, {
      name,
      length: value.length,
      created,
    });
    return reply.code(created ? 201 : 200).send({ secret: { name, updatedAt: saved.createdAt } });
  });

  app.delete<{ Params: { name: string } }>("/api/secrets/:name", async (request, reply) => {
    const auth = authenticated.get(request);
    if (!auth) return reply.code(401).send({ error: "未登录" });
    const name = request.params.name;
    if (!validName(name)) return reply.code(400).send({ error: "密钥名不合法" });
    if (!store.remove(userScope(auth.user.id), name)) return reply.code(404).send({ error: "找不到密钥" });
    auditRepository(deps.db).write(adminScope(auth.user.id), AUDIT_ACTIONS.secretDeleted, name, { name });
    return { ok: true };
  });
}

function validName(name: string): boolean {
  return SECRET_NAME.test(name) && !name.startsWith("app:");
}
