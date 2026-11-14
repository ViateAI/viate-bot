import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.js";
import { createRuntime } from "./compose.js";
import { loadConfig, type ControlConfig } from "./config.js";
import { decrypt, loadOrCreateKey } from "./crypto.js";
import { openDatabase, type AppDatabase } from "./db/index.js";
import { machineRepository } from "./db/machines.js";
import { ensureDevUser } from "./db/users.js";
import { DockerDriver } from "./machines/docker.js";
import { reconcileOnce } from "./machines/loop.js";
import { idleActivityProbe } from "./machines/reconcile.js";
import type { AppRuntime } from "./providers.js";
import { userScope } from "./scope.js";
import { createDriver, devSpec, reconcileDeps } from "./runtime.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface ControlContext {
  db: AppDatabase;
  driver: DockerDriver;
  config: ControlConfig;
  key: Buffer;
}

export interface AppOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  onDisconnect?: (userId: string) => void;
}

const runtimes = new WeakMap<FastifyInstance, AppRuntime>();

export function openContext(config: ControlConfig = loadConfig()): ControlContext {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder });
  return { db, driver: createDriver(), config, key: loadOrCreateKey(config.secretKeyPath) };
}

export function buildApp(ctx: ControlContext, options: AppOptions = {}) {
  const app = Fastify({ logger: process.env.VITEST === "true" ? false : true });
  const { db, driver, config, key } = ctx;
  const runtime = createRuntime(config, db, options);
  runtimes.set(app, runtime);
  registerAuth(app, { db, key, config, runtime, now: options.now ?? (() => new Date()) });

  app.get("/health", async () => ({ ok: true }));

  if (config.dev) {
    const machines = machineRepository(db);

    app.post<{ Params: { userId: string } }>("/dev/machines/:userId", async (request) => {
      ensureDevUser(db, request.params.userId);
      const scope = userScope(request.params.userId);
      const record = await driver.create(machines, scope, devSpec);
      return { userId: record.userId, machineId: record.id, state: record.state };
    });

    app.post<{ Params: { userId: string } }>("/dev/machines/:userId/start", async (request, reply) => {
      const scope = userScope(request.params.userId);
      if (!machines.find(scope)) return reply.code(404).send({ error: "机器不存在" });
      await driver.start(scope.userId);
      machines.update(scope, { state: "running" });
      return { state: "running" };
    });

    app.post<{ Params: { userId: string } }>("/dev/machines/:userId/stop", async (request, reply) => {
      const scope = userScope(request.params.userId);
      if (!machines.find(scope)) return reply.code(404).send({ error: "机器不存在" });
      await driver.stop(scope.userId);
      machines.update(scope, { state: "stopped" });
      return { state: "stopped" };
    });

    app.post<{ Params: { userId: string } }>("/dev/machines/:userId/rebuild", async (request, reply) => {
      const scope = userScope(request.params.userId);
      if (!machines.find(scope)) return reply.code(404).send({ error: "机器不存在" });
      const record = await driver.rebuild(machines, scope, devSpec);
      return { machineId: record.id, containerId: record.containerId, state: record.state };
    });

    app.delete<{ Params: { userId: string } }>("/dev/machines/:userId", async (request, reply) => {
      const scope = userScope(request.params.userId);
      if (!machines.find(scope)) return reply.code(404).send({ error: "机器不存在" });
      await driver.delete(machines, scope);
      return { state: "deleted" };
    });

    app.get<{ Params: { userId: string } }>("/dev/machines/:userId", async (request, reply) => {
      const scope = userScope(request.params.userId);
      const record = machines.find(scope);
      if (!record) return reply.code(404).send({ error: "机器不存在" });
      const info = await driver.inspect(scope.userId);
      return {
        state: record.state,
        running: info?.State.Running ?? false,
        address: firstAddress(info?.NetworkSettings.Networks) ?? null,
        token: decrypt(key, record.tokenEnc),
        volume: record.volumeName,
      };
    });

    app.post("/dev/reconcile", async () => reconcileOnce(reconcileDeps(db, driver, idleActivityProbe)));
  }

  return app;
}

export function startIntegrationJobs(app: FastifyInstance): () => void {
  return runtimes.get(app)?.startJobs() ?? (() => {});
}

export function startReconcileLoop(ctx: ControlContext, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    reconcileOnce(reconcileDeps(ctx.db, ctx.driver, idleActivityProbe)).catch((error: unknown) => {
      console.error("对账失败", error);
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

function firstAddress(
  networks: Record<string, { IPAddress?: string } | undefined> | undefined,
): string | undefined {
  if (!networks) return undefined;
  for (const network of Object.values(networks)) {
    if (network?.IPAddress) return network.IPAddress;
  }
  return undefined;
}
