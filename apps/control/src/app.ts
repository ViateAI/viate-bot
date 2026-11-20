import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { desc, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { deleteCreatedMachine, dockerMachineControl } from "./admin/docker-control.js";
import { ChatError, createChatService, type ChatService } from "./agent/service.js";
import type { MachineControl } from "./admin/service.js";
import { registerAuth } from "./auth.js";
import { createRuntime } from "./compose.js";
import { loadConfig, type ControlConfig } from "./config.js";
import { decrypt, loadOrCreateKey } from "./crypto.js";
import { openDatabase, type AppDatabase } from "./db/index.js";
import { identityRepository } from "./db/identities.js";
import { machineRepository } from "./db/machines.js";
import { ensureDevUser, userRepository } from "./db/users.js";
import { createGateway, holdTaskClock, taskUsageJson, type GatewayTask } from "./gateway/stream.js";
import { taskActivityProbe } from "./machines/activity.js";
import { DockerDriver } from "./machines/docker.js";
import { reconcileOnce } from "./machines/loop.js";
import type { MachineSpec } from "./machines/policy.js";
import { MachinedClient } from "./machines/client.js";
import { ensureUserMachine, prepareMachineEndpoint, type MachineHost } from "./machines/ready.js";
import { devMachineBypass, rememberDevMachine } from "./machines/ready.js";
import { applyRetention, flushMinutes, opsMinutes } from "./ops/rollup.js";
import { registerOpsRoutes } from "./ops/routes.js";
import { reconcileMachineApps, registerCatalogRoutes } from "./apps/catalog.js";
import { registerApprovalRoutes } from "./approvals/routes.js";
import { createUserFlights, type UserFlights } from "./screen/flight.js";
import { createScreenInputDrain } from "./screen/input-drain.js";
import { createTakeoverLeases, type TakeoverLeases } from "./screen/leases.js";
import { remoteUncertain } from "./agent/remote-uncertain.js";
import { messageView } from "./agent/view.js";
import { registerScreenGateway, registerScreenRoutes } from "./screen/gateway.js";
import { notifyTaskSettled, registerNotificationRoutes } from "./notify/index.js";
import { dispatchDue, RoutineError, usersToWake } from "./routines/service.js";
import { registerRoutineRoutes as registerRoutineHttp } from "./routines/routes.js";
import type { AppRuntime } from "./providers.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerChatRoutes } from "./routes/chat.js";
import { cleanupUnreferencedUploads } from "./uploads/store.js";
import { registerUploadRoutes } from "./uploads/routes.js";
import { userScope } from "./scope.js";
import { messages } from "./db/schema.js";
import { createDriver, devSpec, reconcileDeps } from "./runtime.js";
import { registerWeb } from "./web-static.js";
import { createHub, registerWebsocket } from "./ws.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface ControlContext {
  db: AppDatabase;
  driver: DockerDriver;
  config: ControlConfig;
  key: Buffer;
  /** buildApp 写入。显式回调，不挂在数据库对象上。 */
  reconcileApps?: NonNullable<MachineHost["reconcileApps"]>;
}

export interface AppOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  onDisconnect?: (userId: string) => void;
  prepareEndpoint?: (userId: string, onPhase: (phase: "starting" | "ready") => void) => Promise<{ host: string; port: number; token: string }>;
  ensureMachine?: (userId: string, spec?: MachineSpec) => Promise<void>;
  waitHealthy?: (userId: string) => Promise<void>;
  deleteMachine?: (userId: string) => Promise<void>;
  machineControl?: MachineControl;
  retryDelays?: number[];
  flights?: UserFlights;
  leases?: TakeoverLeases;
  https?: { key: Buffer; cert: Buffer };
}

const runtimes = new WeakMap<FastifyInstance, AppRuntime>();
const chats = new WeakMap<FastifyInstance, ChatService>();

export function openContext(config: ControlConfig = loadConfig()): ControlContext {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder });
  return { db, driver: createDriver(), config, key: loadOrCreateKey(config.secretKeyPath) };
}

export function buildApp(ctx: ControlContext, options: AppOptions = {}) {
  const app = Fastify({
    logger: process.env.VITEST === "true" ? false : true,
    ...(options.https ? { https: options.https } : {}),
  });
  const { db, driver, config, key } = ctx;
  const hub = createHub();
  const now = options.now ?? (() => new Date());
  let disconnectScreens = (_userId: string) => {};
  const runtime = createRuntime(config, db, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    onDisconnect: (userId) => {
      hub.disconnect(userId);
      disconnectScreens(userId);
      options.onDisconnect?.(userId);
    },
  });
  runtimes.set(app, runtime);
  registerAuth(app, { db, key, config, runtime, now });
  const tasks = new Map<string, GatewayTask>();
  function holdRun(taskId: string, waiting: boolean): void {
    const task = tasks.get(taskId);
    if (!task || !holdTaskClock(task, waiting, now().getTime())) return;
    db.$client.prepare("update tasks set usage_json=? where id=?").run(taskUsageJson(task), taskId);
  }
  const flights = options.flights ?? createUserFlights();
  const inputDrain = createScreenInputDrain();
  const leases =
    options.leases ??
    createTakeoverLeases({
    db,
    secretWaitMs: config.secretWaitMs,
    now,
    flights,
    writesBlocked: (userId) => remoteUncertain(db, userId),
    drainInput: (botId) => inputDrain.revoke(botId),
    onWaiting(taskId) {
      holdRun(taskId, true);
      const row = db.$client
        .prepare("select t.trigger as trigger, t.bot_id as botId, b.user_id as userId from tasks t join bots b on b.id=t.bot_id where t.id=?")
        .get(taskId) as { trigger: string; botId: string; userId: string } | undefined;
      if (row?.trigger === "routine") notifyTaskSettled(db, { userId: row.userId, botId: row.botId, taskId, outcome: "needs_user" });
    },
    onResumed(taskId) {
      holdRun(taskId, false);
    },
    quiesce: async (botId) => {
      const row = db.$client.prepare("select user_id as userId from bots where id=?").get(botId) as { userId: string } | undefined;
      if (row) await flights.barrier(row.userId);
    },
  });
  let machineInstaller: {
    install(command: { userId: string; archivePath: string; name: string; version: string; sha256: string; signal?: AbortSignal }): Promise<{ routines?: ReadonlyArray<{ cron: string; timezone: string; prompt: string }> } | void>;
    uninstall(command: { userId: string; name: string }): Promise<void>;
  } | undefined;
  const catalogInstaller = {
    install(command: { userId: string; archivePath: string; name: string; version: string; sha256: string; signal?: AbortSignal }) {
      if (!machineInstaller) throw new Error("安装器尚未就绪");
      return machineInstaller.install(command);
    },
    uninstall(command: { userId: string; name: string }) {
      if (!machineInstaller) throw new Error("安装器尚未就绪");
      return machineInstaller.uninstall(command);
    },
  };
  const chat = createChatService({
    db,
    config,
    key,
    hub,
    tasks,
    installer: catalogInstaller,
    streamFn: createGateway({
      db,
      config,
      tasks,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      now,
      ...(options.retryDelays ? { retryDelays: options.retryDelays } : {}),
    }),
    prepareEndpoint:
      options.prepareEndpoint ??
      (devMachineBypass()
        ? async (userId, onPhase) => {
            const endpoint = devMachineBypass();
            if (!endpoint) throw new Error("开发机器旁路没有配置");
            rememberDevMachine(db, key, userId, endpoint);
            onPhase("ready");
            return endpoint;
          }
        : (userId, onPhase) => prepareMachineEndpoint(ctx, userId, onPhase, options.fetch ?? fetch)),
    now,
    leases,
    flights,
  });
  chats.set(app, chat);
  const bypass = devMachineBypass();
  const ensureMachine = options.ensureMachine ?? (bypass
    ? async (userId: string) => { rememberDevMachine(db, key, userId, bypass); }
    : (userId: string, spec?: MachineSpec) => ensureUserMachine(ctx, userId, spec));
  registerChatRoutes(app, {
    db,
    config,
    key,
    chat,
    credentials: runtime.credentials,
    providerId: runtime.identity.id,
    ensureMachine,
    tasks,
    now,
  });
  registerUploadRoutes(app, { db, dataDir: config.dataDir, now });
  registerAdminRoutes(app, {
    db,
    key,
    config,
    credentials: runtime.credentials,
    directory: runtime.directory,
    providerId: runtime.identity.id,
    ensureMachine,
    waitHealthy:
      options.waitHealthy ??
      (bypass ? async () => {} : (userId) => prepareMachineEndpoint(ctx, userId, () => {}, options.fetch ?? fetch).then(() => undefined)),
    deleteMachine: options.deleteMachine ?? ((userId) => deleteCreatedMachine(db, driver, userId)),
    machineControl: options.machineControl ?? dockerMachineControl(ctx),
    now,
  });
  registerWebsocket(app, { db, key, config, runtime, hub, now });
  const prepare =
    options.prepareEndpoint ??
    (bypass
      ? async (userId: string, onPhase: (phase: "starting" | "ready") => void) => {
          rememberDevMachine(db, key, userId, bypass);
          onPhase("ready");
          return bypass;
        }
      : (userId: string, onPhase: (phase: "starting" | "ready") => void) =>
          prepareMachineEndpoint(ctx, userId, onPhase, options.fetch ?? fetch));
  const screen = {
    db,
    key,
    config,
    runtime,
    now,
    leases,
    inputDrain,
    wake: async (userId: string) => {
      await prepare(userId, () => {});
    },
    endpoint: async (userId: string, _botId: string) => ({
      machine: await prepare(userId, () => {}),
      display: 1,
    }),
  };
  app.after(() => {
    disconnectScreens = registerScreenGateway(app, screen);
    registerScreenRoutes(app, screen);
  });
  registerOpsRoutes(app, { db, now, metricsToken: config.metricsToken });
  registerApprovalRoutes(app, {
    db,
    gate: chat.approvalGate,
  });
  const enqueueRoutine = (work: { userId: string; botId: string; prompt: string; runId: string }) => {
    try {
      return chat.enqueueRoutine({ userId: work.userId, botId: work.botId, prompt: work.prompt, routineRunId: work.runId });
    } catch (error) {
      if (error instanceof ChatError) throw new RoutineError(error.message, error.statusCode);
      throw error;
    }
  };
  registerRoutineHttp(app, { db, enqueue: enqueueRoutine, userStatus: (userId) => routineUserStatus(ctx, runtime, userId) });
  registerNotificationRoutes(app, { db });
  const fetchImpl = options.fetch ?? fetch;
  const reconcileAttempted = new Set<string>();
  const reconcileInflight = new Map<string, Promise<void>>();
  machineInstaller = {
    async install(command: { userId: string; archivePath: string; name: string; version: string; sha256: string; signal?: AbortSignal }) {
      const archive = await readFile(archiveInside(config.dataDir, command.archivePath));
      const endpoint = await prepare(command.userId, () => {});
      const routines = await new MachinedClient(endpoint, fetchImpl).installApp({
        name: command.name,
        version: command.version,
        sha256: command.sha256,
        archive,
      }, command.signal);
      return { routines };
    },
    async uninstall(command: { userId: string; name: string }) {
      const endpoint = await prepare(command.userId, () => {});
      await new MachinedClient(endpoint, fetchImpl).uninstallApp(command.name);
    },
  };
  ctx.reconcileApps = (input) => {
    const attempt = `${input.machineId}:${input.containerId}`;
    if (!input.force && reconcileAttempted.has(attempt)) return Promise.resolve();
    const pending = reconcileInflight.get(attempt);
    if (pending) return pending;
    if (!input.force) reconcileAttempted.add(attempt);
    const run = reconcileMachineApps(
      {
        db,
        key,
        dataDir: config.dataDir,
        installer: catalogInstaller,
        wake: async (userId) => {
          await prepare(userId, () => {});
        },
      },
      input.machineId,
    ).then(
      () => undefined,
      (error: unknown) => {
        console.error("应用对账失败", error instanceof Error ? error.message : "unknown");
      },
    ).finally(() => {
      reconcileInflight.delete(attempt);
    });
    reconcileInflight.set(attempt, run);
    return run;
  };
  registerCatalogRoutes(app, {
    db,
    key,
    dataDir: config.dataDir,
    installer: catalogInstaller,
    wake: async (userId) => {
      await prepare(userId, () => {});
    },
    onNotice: (conversationId) => {
      const row = db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(desc(messages.id)).get();
      if (!row) return;
      hub.publish(conversationId, {
        type: "message",
        conversationId,
        message: messageView({
          id: row.id,
          conversationId: row.conversationId,
          role: row.role,
          contentJson: row.contentJson,
          taskId: row.taskId,
          createdAt: row.createdAt,
        }),
      });
    },
  });
  registerWeb(app);
  app.addHook("onClose", async () => {
    chat.shutdown();
  });

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

    app.post("/dev/reconcile", async () => reconcileOnce(reconcileDeps(db, driver, taskActivityProbe(db), ctx.reconcileApps)));
  }

  return app;
}

export function startIntegrationJobs(app: FastifyInstance): () => void {
  return runtimes.get(app)?.startJobs() ?? (() => {});
}

export function chatService(app: FastifyInstance): ChatService {
  const service = chats.get(app);
  if (!service) throw new Error("没有任务服务");
  return service;
}

export function startReconcileLoop(ctx: ControlContext, intervalMs = 30_000): () => void {
  if (devMachineBypass()) return () => {};
  const timer = setInterval(() => {
    reconcileOnce(reconcileDeps(ctx.db, ctx.driver, taskActivityProbe(ctx.db), ctx.reconcileApps)).catch((error: unknown) => {
      console.error("对账失败", error);
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function startRoutineLoop(app: FastifyInstance, ctx: ControlContext, intervalMs = 30_000): () => void {
  const runtime = runtimes.get(app)!;
  const timer = setInterval(() => {
    const chat = chats.get(app);
    if (!chat) return;
    const now = new Date();
    for (const userId of usersToWake(ctx.db, now)) {
      routineUserStatus(ctx, runtime, userId).then(async (status) => {
        if (status === "active" && !devMachineBypass()) await prepareMachineEndpoint(ctx, userId, () => {});
      }).catch((error: unknown) => {
        console.error("定时任务唤醒失败", error);
      });
    }
    dispatchDue(ctx.db, now, {
      userStatus: (userId) => routineUserStatus(ctx, runtime, userId),
      enqueue: (work) => {
        try {
          return chat.enqueueRoutine({
            userId: work.userId,
            botId: work.botId,
            prompt: work.prompt,
            routineRunId: work.runId,
          });
        } catch (error) {
          if (error instanceof ChatError) throw new RoutineError(error.message, error.statusCode);
          throw error;
        }
      },
    }).catch((error: unknown) => {
      console.error("定时任务调度失败", error);
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function routineUserStatus(ctx: ControlContext, runtime: AppRuntime, userId: string): Promise<"active" | "disabled" | "unknown"> {
  const local = userRepository(ctx.db).findById(userId)?.status;
  if (local !== "active") return local === "disabled" ? "disabled" : "unknown";
  if (ctx.config.integration !== "viate" || !runtime.directory.userStatus) return "active";
  const identity = identityRepository(ctx.db).findByUser(userId, runtime.identity.id);
  if (!identity) return "unknown";
  try {
    return await runtime.directory.userStatus({ subject: identity.subject, provider: identity.provider });
  } catch {
    return "unknown";
  }
}

export function startOpsMaintenance(ctx: ControlContext, intervalMs = 60 * 60 * 1000): () => void {
  const timer = setInterval(() => {
    flushMinutes(ctx.db, opsMinutes);
    applyRetention(ctx.db, new Date());
    cleanupUnreferencedUploads(ctx.db, ctx.config.dataDir, new Date());
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function archiveInside(root: string, file: string): string {
  const rootReal = resolve(root);
  const fileReal = resolve(file);
  const rel = relative(rootReal, fileReal);
  if (rel.length === 0 || rel.startsWith("..") || rel.split(/[/\\]/).includes("..")) throw new Error("归档路径无效");
  return fileReal;
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
