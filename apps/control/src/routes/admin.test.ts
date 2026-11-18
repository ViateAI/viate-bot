import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import type { MachineControl } from "../admin/service.js";
import { buildApp, type ControlContext } from "../app.js";
import { loadConfig } from "../config.js";
import { encrypt, loadOrCreateKey } from "../crypto.js";
import { auditRepository } from "../db/audit.js";
import { botRepository } from "../db/bots.js";
import { chatRepository } from "../db/chat.js";
import { credentialRepository } from "../db/credentials.js";
import { openDatabase } from "../db/index.js";
import { machineRepository, type MachineRecord } from "../db/machines.js";
import { memoryRepository } from "../db/memories.js";
import { secretRepository } from "../db/secrets.js";
import { userRepository } from "../db/users.js";
import { ulid } from "../id.js";
import { createSession } from "../session.js";
import { adminScope, userScope } from "../scope.js";

const LEAKS = ["leak-memory-正文-9f3a", "leak-conversation-正文-9f3a", "leak-secret-value-9f3a", "leak-api-key-9f3a"];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function machine(userId: string): MachineRecord {
  return {
    id: `machine-${userId}`,
    userId,
    state: "running",
    containerId: "c",
    networkId: "n",
    volumeName: `vb-home-${userId}`,
    imageVersion: "viate-bot/machine:dev",
    spec: { cpu: 1, memMb: 1024, diskGb: 10 },
    tokenEnc: "enc-token-not-for-admin",
  };
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-admin-"));
  dirs.push(dir);
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "shared-secret",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
  });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const key = loadOrCreateKey(config.secretKeyPath);
  userRepository(db).insert({ id: "admin-1", email: "admin@example.com", name: "Admin", status: "active", isAdmin: true });
  userRepository(db).insert({ id: "user-1", email: "user@example.com", name: "User", status: "active", isAdmin: false });
  const scope = userScope("user-1");
  const bot = botRepository(db).insert(scope, { id: "bot-1", name: "Helper", model: "fake", instructions: "不要出现在管理端" });
  credentialRepository(db).insertOwned(scope, {
    id: "cred-1",
    botId: bot.id,
    provider: "fake",
    externalId: "ext-1",
    secretEnc: encrypt(key, "leak-api-key-9f3a"),
    policyRef: "channel",
  });
  memoryRepository(db).save(scope, bot.id, { id: "mem-1", content: "leak-memory-正文-9f3a", sourceTaskId: null });
  const conversation = chatRepository(db).insertConversation(scope, { id: "conv-1", botId: bot.id, title: "标题" });
  if (!conversation) throw new Error("conversation");
  chatRepository(db).insertMessage(scope, {
    id: "msg-1",
    conversationId: conversation.id,
    role: "user",
    contentJson: JSON.stringify({ text: "leak-conversation-正文-9f3a" }),
    taskId: null,
  });
  secretRepository(db).upsert(scope, { id: ulid(), name: "token", valueEnc: encrypt(key, "leak-secret-value-9f3a"), scope: "browser" });
  machineRepository(db).insert(scope, machine("user-1"));
  const task = chatRepository(db).insertTask(scope, { id: "task-1", botId: bot.id, conversationId: conversation.id });
  if (!task) throw new Error("task");
  chatRepository(db).updateTask(scope, task.id, { state: "running" });
  const removed: string[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  const control: MachineControl = {
    async start(userId) {
      started.push(userId);
    },
    async stop(userId) {
      stopped.push(userId);
    },
    async restart() {},
    async rebuild() {},
    async remove(userId) {
      removed.push(userId);
      machineRepository(db).update(userScope(userId), { state: "deleted", containerId: null, networkId: null });
    },
    async stats() {
      return { cpuPct: 1.5, memMb: 32 };
    },
  };
  const ctx: ControlContext = { db, driver: {} as ControlContext["driver"], config, key };
  const app = buildApp(ctx, {
    ensureMachine: async () => {},
    waitHealthy: async () => {},
    deleteMachine: async () => {},
    machineControl: control,
    prepareEndpoint: async () => ({ host: "127.0.0.1", port: 9, token: "t" }),
  });
  await app.ready();
  const now = new Date();
  const admin = createSession(db, key, "admin-1", "refresh-a", now);
  const user = createSession(db, key, "user-1", "refresh-u", now);
  return { app, db, admin, user, removed, started, stopped, key };
}

function headers(session: { token: string; csrf: string }, json = false) {
  return {
    cookie: `vb_session=${session.token}`,
    "x-vb-csrf": session.csrf,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

describe("admin http", () => {
  it("restricts model limits, budgets and detail flags to administrators with CSRF", async () => {
    const { app, db, admin, user } = await boot();
    try {
      const cases = [
        { method: "PUT" as const, url: "/api/admin/model-limits", payload: { model: "fake", contextTokens: 32000, maxTokens: 1000 } },
        { method: "PUT" as const, url: "/api/admin/model-rate", payload: { userPerMin: 0, botPerMin: 2 } },
        { method: "PUT" as const, url: "/api/admin/task-token-budget", payload: { value: 0 } },
        { method: "PUT" as const, url: "/api/admin/task-max-steps", payload: { value: 0 } },
        { method: "PUT" as const, url: "/api/admin/task-max-duration-sec", payload: { value: 0 } },
        { method: "PATCH" as const, url: "/api/admin/users/user-1/process-detail", payload: { enabled: true } },
      ];
      for (const input of cases) {
        expect((await app.inject({ ...input, headers: headers(user, true) })).statusCode).toBe(404);
        expect((await app.inject({ ...input, headers: { cookie: `vb_session=${admin.token}` } })).statusCode).toBe(403);
        expect((await app.inject({ ...input, headers: headers(admin, true) })).statusCode).toBe(200);
      }
      const invalid = await app.inject({ method: "PUT", url: "/api/admin/model-limits", headers: headers(admin, true), payload: { model: "fake", contextTokens: 1000, maxTokens: 1001 } });
      expect(invalid.statusCode).toBe(400);
      for (const payload of [{ userPerMin: -1, botPerMin: 1 }, { userPerMin: 1.5, botPerMin: 1 }, { userPerMin: "1", botPerMin: 1 }, { userPerMin: 1 }]) {
        expect((await app.inject({ method: "PUT", url: "/api/admin/model-rate", headers: headers(admin, true), payload })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: "GET", url: "/api/admin/settings", headers: headers(admin) })).json()).toMatchObject({
        modelLimits: { fake: { contextTokens: 32000, maxTokens: 1000 } }, taskTokenBudget: 0,
        taskMaxSteps: 0,
        taskMaxDurationSec: 0,
        modelRate: { userPerMin: 0, botPerMin: 2 },
        provisionDefaults: { maxBots: 5, maxConcurrentTasks: 2, maxRoutines: 10, models: [] },
      });
      const { quotaRepository } = await import("../db/quotas.js");
      quotaRepository(db).insert(adminScope("admin-1"), "user-1", {
        maxBots: 2,
        spec: { cpu: 1, memMb: 512, diskGb: 10 },
        maxConcurrentTasks: 1,
        maxRoutines: 0,
      });
      const saved = await app.inject({
        method: "PATCH",
        url: "/api/admin/users/user-1/quota",
        headers: headers(admin, true),
        payload: { taskMaxSteps: 0, taskMaxDurationSec: 12 },
      });
      expect(saved.statusCode).toBe(200);
      expect(quotaRepository(db).find(userScope("user-1"))).toMatchObject({ taskMaxSteps: 0, taskMaxDurationSec: 12 });
      expect((await app.inject({ method: "PATCH", url: "/api/admin/users/user-1/quota", headers: headers(admin, true), payload: { taskMaxSteps: -1 } })).statusCode).toBe(400);
    } finally {
      await app.close();
      db.$client.close();
    }
  });

  it.each(["delete", "rebuild"])("refuses %s while an active task belongs to a soft-deleted bot", async (action) => {
    const { app, db, admin, removed } = await boot();
    chatRepository(db).updateTask(userScope("user-1"), "task-1", { state: "running" });
    botRepository(db).softDelete(userScope("user-1"), "bot-1");
    const response = await app.inject({ method: "POST", url: `/api/admin/machines/machine-user-1/${action}`, headers: headers(admin, true), payload: { email: "user@example.com" } });
    expect(response.statusCode).toBe(409);
    expect(removed).toEqual([]);
    expect(machineRepository(db).find(userScope("user-1"))?.state).toBe("running");
    await app.close();
    db.$client.close();
  });

  it("keeps encoded and alternative admin paths inaccessible to ordinary sessions", async () => {
    const { app, db, user } = await boot();
    for (const url of ["/%61pi/admin/users", "/api/%61dmin/users", "/api/admin/%75sers", "/api/admin/users/", "/API/ADMIN/users", "/api/ADMIN/users", "/api/admin/users?limit=1"]) {
      const response = await app.inject({ method: "GET", url, headers: headers(user) });
      expect(response.statusCode, url).toBe(404);
      for (const leak of LEAKS) expect(response.body, url).not.toContain(leak);
    }
    for (const url of ["/%61pi/admin/users/provision", "/api/%61dmin/users/provision", "/api/admin/users/provision/", "/API/ADMIN/users/provision"]) {
      const response = await app.inject({ method: "POST", url, headers: { cookie: `vb_session=${user.token}` }, payload: { userId: "user-1", templateId: "general" } });
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
    db.$client.close();
  });

  it("hides admin routes from non-admins and keeps their data out of admin payloads", async () => {
    const { app, db, admin, user, removed, started, stopped } = await boot();
    const paths = ["/api/admin/users", "/api/admin/machines", "/api/admin/templates", "/api/admin/settings", "/api/admin/audit"];
    for (const url of paths) {
      const response = await app.inject({ method: "GET", url, headers: headers(user) });
      expect(response.statusCode, url).toBe(404);
    }
    const posted = await app.inject({
      method: "POST",
      url: "/api/admin/users/provision",
      headers: { cookie: `vb_session=${user.token}`, "content-type": "application/json" },
      payload: { userId: "user-1", templateId: "general" },
    });
    expect(posted.statusCode).toBe(404);

    const bodies: string[] = [];
    for (const url of paths) {
      const response = await app.inject({ method: "GET", url, headers: headers(admin) });
      expect(response.statusCode, url).toBe(200);
      bodies.push(response.body);
    }
    const stats = await app.inject({ method: "GET", url: "/api/admin/machines/machine-user-1/stats", headers: headers(admin) });
    expect(stats.statusCode).toBe(200);
    bodies.push(stats.body);
    const quota = await app.inject({
      method: "PATCH",
      url: "/api/admin/users/admin-1/quota",
      headers: headers(admin, true),
      payload: { maxBots: 3 },
    });
    expect(quota.statusCode).toBe(404);
    const { quotaRepository } = await import("../db/quotas.js");
    quotaRepository(db).insert(adminScope("admin-1"), "user-1", {
      maxBots: 2,
      spec: { cpu: 1, memMb: 512, diskGb: 10 },
      maxConcurrentTasks: 1,
      maxRoutines: 0,
    });
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/admin/users/user-1/quota",
      headers: headers(admin, true),
      payload: { maxBots: 4, spec: { cpu: 2, memMb: 2048, diskGb: 20 } },
    });
    expect(updated.statusCode).toBe(200);
    bodies.push(updated.body);
    const template = await app.inject({
      method: "POST",
      url: "/api/admin/templates",
      headers: headers(admin, true),
      payload: { name: "采集", description: "说明", instructions: "指令", defaultModel: "fake", initialMemories: [], welcome: "你好" },
    });
    expect(template.statusCode).toBe(201);
    bodies.push(template.body);
    const settings = await app.inject({
      method: "PATCH",
      url: "/api/admin/settings",
      headers: headers(admin, true),
      payload: { platformPrompt: "平台提示词已更新", defaultChannel: "channel-default" },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().platformPrompt.version).toBe(2);
    bodies.push(settings.body);
    const stoppedResponse = await app.inject({
      method: "POST",
      url: "/api/admin/machines/machine-user-1/stop",
      headers: headers(admin, true),
      payload: {},
    });
    expect(stoppedResponse.statusCode).toBe(200);
    const startedResponse = await app.inject({
      method: "POST",
      url: "/api/admin/machines/machine-user-1/start",
      headers: headers(admin, true),
      payload: {},
    });
    expect(startedResponse.statusCode).toBe(200);
    expect(stopped).toEqual(["user-1"]);
    expect(started).toEqual(["user-1"]);
    chatRepository(db).updateTask(userScope("user-1"), "task-1", { state: "running" });
    const deniedDelete = await app.inject({
      method: "POST",
      url: "/api/admin/machines/machine-user-1/delete",
      headers: headers(admin, true),
      payload: { email: "user@example.com" },
    });
    expect(deniedDelete.statusCode).toBe(409);
    bodies.push(deniedDelete.body);
    chatRepository(db).updateTask(userScope("user-1"), "task-1", { state: "succeeded" });
    const missingEmail = await app.inject({
      method: "POST",
      url: "/api/admin/machines/machine-user-1/delete",
      headers: headers(admin, true),
      payload: {},
    });
    expect(missingEmail.statusCode).toBe(400);
    const wrongEmail = await app.inject({
      method: "POST",
      url: "/api/admin/machines/machine-user-1/delete",
      headers: headers(admin, true),
      payload: { email: "other@example.com" },
    });
    expect(wrongEmail.statusCode).toBe(400);
    const deleted = await app.inject({
      method: "POST",
      url: "/api/admin/machines/machine-user-1/delete",
      headers: headers(admin, true),
      payload: { email: "user@example.com" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(removed).toEqual(["user-1"]);
    expect(machineRepository(db).find(userScope("user-1"))?.volumeName).toBe("vb-home-user-1");
    const conversation = await app.inject({
      method: "GET",
      url: "/api/conversations/conv-1",
      headers: headers(admin),
    });
    expect(conversation.statusCode).toBe(404);
    const audit = await app.inject({ method: "GET", url: "/api/admin/audit", headers: headers(admin) });
    bodies.push(audit.body);
    const dumped = bodies.join("\n");
    for (const leak of LEAKS) expect(dumped).not.toContain(leak);
    expect(dumped).not.toContain("enc-token-not-for-admin");
    expect(dumped).not.toContain("不要出现在管理端");
    const actions = auditRepository(db).list(adminScope("admin-1"), 50).map((row) => row.action);
    for (const action of ["quota.update", "template.create", "settings.update", "machine.stop", "machine.start", "machine.delete.rejected", "machine.delete"]) {
      expect(actions).toContain(action);
    }
    await app.close();
    db.$client.close();
  });
});
