import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { provisionUser, type ProvisionDeps } from "./service.js";
import { buildApp, chatService } from "../app.js";
import { loadConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { auditRepository } from "../db/audit.js";
import { botRepository } from "../db/bots.js";
import { chatRepository } from "../db/chat.js";
import { identityRepository } from "../db/identities.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { machineRepository, type MachineRecord } from "../db/machines.js";
import { memoryRepository } from "../db/memories.js";
import { quotaRepository } from "../db/quotas.js";
import { settingsRepository } from "../db/settings.js";
import { ensureDevUser, userRepository } from "../db/users.js";
import { acceptIdentity } from "../login.js";
import type { CredentialProvider, ModelPolicy } from "../providers.js";
import { adminScope, userScope } from "../scope.js";
import { createSession } from "../session.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(policies?: ModelPolicy[]) {
  const dir = mkdtempSync(join(tmpdir(), "vb-prov-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const key = loadOrCreateKey(join(dir, "secret.key"));
  const config = loadConfig({ VB_DATA_DIR: dir, VB_MODEL_API_KEY: "shared", VB_ALLOW_SIGNUP: "false", VB_MODELS: "fake" });
  const issued: string[] = [];
  const revoked: string[] = [];
  const policyRefs: Array<string | undefined> = [];
  const calls = { ensure: 0, healthy: 0, deleted: 0 };
  let ensureError: Error | undefined;
  let healthyError: Error | undefined;
  const credentials: CredentialProvider = {
    async issue(bot, policyRef) {
      issued.push(bot.id);
      policyRefs.push(policyRef);
      return { provider: "fake", externalId: `ext-${bot.id}`, secret: `secret-${bot.id}`, policyRef: policyRef ?? null, shared: false };
    },
    async revoke(credential) {
      if (credential.externalId) revoked.push(credential.externalId);
    },
    ...(policies ? { async listPolicies() { return policies; } } : {}),
  };
  const deps: ProvisionDeps = {
    db,
    key,
    credentials,
    directory: {},
    providerId: "oidc",
    config,
    ensureMachine: async () => {
      calls.ensure += 1;
      if (ensureError) throw ensureError;
    },
    waitHealthy: async () => {
      calls.healthy += 1;
      if (healthyError) throw healthyError;
    },
    deleteMachine: async () => {
      calls.deleted += 1;
    },
  };
  userRepository(db).insert({ id: "admin-1", email: "admin@example.com", name: "Admin", status: "active", isAdmin: true });
  const scope = adminScope("admin-1");
  return { db, deps, scope, issued, revoked, policyRefs, calls, setEnsureError: (error: Error) => { ensureError = error; }, setHealthyError: (error: Error) => { healthyError = error; } };
}

function machine(userId: string): MachineRecord {
  return {
    id: `machine-${userId}`,
    userId,
    state: "stopped",
    containerId: "c",
    networkId: "n",
    volumeName: `vb-home-${userId}`,
    imageVersion: "viate-bot/machine:dev",
    spec: { cpu: 1, memMb: 1024, diskGb: 10 },
    tokenEnc: "enc",
  };
}

describe("provision", () => {
  it("preprovisions by email without binding an unverified login identity", async () => {
    const { db, deps, scope } = setup();
    const result = await provisionUser(deps, scope, { email: "Ada@Example.com", name: "Ada", templateId: "general" });
    expect(identityRepository(db).findByUser(result.userId, "oidc")).toBeUndefined();
    expect(quotaRepository(db).find(userScope(result.userId))).toBeDefined();
    expect(() => acceptIdentity(db, deps.config, "oidc", { sub: "unverified-sub", email: "ada@example.com", emailVerified: false, name: "Ada" })).toThrow("不允许注册");
    const loggedIn = acceptIdentity(db, deps.config, "oidc", { sub: "verified-sub", email: "ada@example.com", emailVerified: true, name: "Ada" });
    expect(loggedIn.id).toBe(result.userId);
    db.$client.close();
  });

  it("seeds missing development quota for an existing user without overwriting it", () => {
    const { db } = setup();
    userRepository(db).insert({ id: "dev-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    ensureDevUser(db, "dev-1", { maxBots: 3 });
    expect(quotaRepository(db).find(userScope("dev-1"))?.maxBots).toBe(3);
    ensureDevUser(db, "dev-1", { maxBots: 9 });
    expect(quotaRepository(db).find(userScope("dev-1"))?.maxBots).toBe(3);
    db.$client.close();
  });

  it("does not let provisioning attach another login identity to an existing user", async () => {
    const { db, deps, scope } = setup();
    userRepository(db).insert({ id: "victim", email: "victim@example.com", name: "Victim", status: "active", isAdmin: false });
    identityRepository(db).insert({ provider: "oidc", subject: "victim-sub", userId: "victim", email: "victim@example.com", emailVerified: true });
    await expect(provisionUser(deps, scope, { userId: "victim", subject: "attacker-sub", email: "victim@example.com", templateId: "general" })).rejects.toMatchObject({ statusCode: 409 });
    expect(identityRepository(db).find("oidc", "attacker-sub")).toBeUndefined();
    expect(identityRepository(db).findByUser("victim", "oidc")?.subject).toBe("victim-sub");
    db.$client.close();
  });

  it.each([
    { requested: "request-model", template: "template-model", expected: "request-model" },
    { requested: "  ", template: "template-model", expected: "template-model" },
    { requested: undefined, template: "", expected: "configured-model" },
  ])("chooses a usable model in request, template, configuration order: $expected", async ({ requested, template, expected }) => {
    const { db, deps, scope } = setup();
    deps.config.models = ["configured-model", "template-model", "request-model"];
    if (template) {
      const settings = settingsRepository(db);
      settings.saveTemplates(settings.templates().map((item) => ({ ...item, defaultModel: template })));
    }
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    const result = await provisionUser(deps, scope, { userId: "user-1", templateId: "general", ...(requested !== undefined ? { model: requested } : {}) });
    expect(botRepository(db).findById(userScope("user-1"), result.botId)?.model).toBe(expected);
    db.$client.close();
  });

  it("rejects provisioning without any configured model before issuing credentials", async () => {
    const { db, deps, scope, issued, calls } = setup();
    deps.config.models = [];
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    await expect(provisionUser(deps, scope, { userId: "user-1", templateId: "general" })).rejects.toMatchObject({
      statusCode: 400,
      message: "没有可用模型，请管理员在模板里设置默认模型或配置 VB_MODELS",
    });
    expect(issued).toEqual([]);
    expect(calls.ensure).toBe(0);
    expect(quotaRepository(db).find(userScope("user-1"))).toBeUndefined();
    db.$client.close();
  });

  it("creates the user, identity, quota, bot, memory and welcome message", async () => {
    const { db, deps, scope, issued, calls } = setup();
    settingsRepository(db).saveTemplates([
      {
        id: "general",
        name: "通用助手",
        description: "说明",
        instructions: "用中文",
        defaultModel: "fake",
        initialMemories: ["记住用户喜欢简洁"],
        welcome: "你好，我是通用助手。",
      },
    ]);
    const result = await provisionUser(deps, scope, {
      subject: "sub-1",
      email: "Ada@Example.com",
      name: "Ada",
      templateId: "general",
    });
    expect(issued).toEqual([result.botId]);
    expect(calls).toMatchObject({ ensure: 1, healthy: 1, deleted: 0 });
    expect(quotaRepository(db).find(userScope(result.userId))?.maxBots).toBe(5);
    expect(identityRepository(db).find("oidc", "sub-1")?.userId).toBe(result.userId);
    expect(memoryRepository(db).list(userScope(result.userId), result.botId)?.map((item) => item.content)).toEqual(["记住用户喜欢简洁"]);
    const conversations = chatRepository(db).listConversations(userScope(result.userId), result.botId);
    const messages = chatRepository(db).listMessages(userScope(result.userId), conversations?.[0]?.id ?? "");
    expect(messages?.[0]?.contentJson).toContain("你好，我是通用助手。");
    expect(auditRepository(db).list(scope, 10).some((row) => row.action === "user.provision" && row.attrs && JSON.stringify(row.attrs).includes('"ok":true'))).toBe(true);
    const loggedIn = acceptIdentity(db, deps.config, "oidc", {
      sub: "sub-1",
      email: "other@example.com",
      emailVerified: false,
      name: "Ada",
    });
    expect(loggedIn.id).toBe(result.userId);
    db.$client.close();
  });

  it("rolls back the key, the new machine and the quota when health check fails", async () => {
    const { db, deps, scope, issued, revoked, calls, setHealthyError } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    setHealthyError(new Error("健康检查失败"));
    await expect(provisionUser(deps, scope, { userId: "user-1", templateId: "general" })).rejects.toThrow(/健康检查失败/);
    expect(issued.length).toBe(1);
    expect(revoked).toEqual([`ext-${issued[0]}`]);
    expect(calls.deleted).toBe(1);
    expect(quotaRepository(db).find(userScope("user-1"))).toBeUndefined();
    expect(botRepository(db).list(userScope("user-1"))).toEqual([]);
    expect(auditRepository(db).list(scope, 5).some((row) => JSON.stringify(row.attrs).includes("健康检查失败"))).toBe(true);
    db.$client.close();
  });

  it("rolls back when machine creation fails and does not delete a machine that already existed", async () => {
    const { db, deps, scope, revoked, calls, setEnsureError } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    setEnsureError(new Error("机器创建失败"));
    await expect(provisionUser(deps, scope, { userId: "user-1", templateId: "general" })).rejects.toThrow(/机器创建失败/);
    expect(revoked.length).toBe(1);
    expect(calls.deleted).toBe(1);
    expect(quotaRepository(db).find(userScope("user-1"))).toBeUndefined();

    const { db: db2, deps: deps2, scope: scope2, calls: calls2, setHealthyError } = setup();
    userRepository(db2).insert({ id: "user-2", email: "b@example.com", name: "B", status: "active", isAdmin: false });
    machineRepository(db2).insert(userScope("user-2"), machine("user-2"));
    setHealthyError(new Error("健康检查失败"));
    await expect(provisionUser(deps2, scope2, { userId: "user-2", templateId: "general" })).rejects.toThrow(/健康检查失败/);
    expect(calls2.deleted).toBe(0);
    expect(machineRepository(db2).find(userScope("user-2"))?.state).toBe("stopped");
    expect(quotaRepository(db2).find(userScope("user-2"))).toBeUndefined();
    db.$client.close();
    db2.$client.close();
  });

  it("allows only one of two concurrent provisions", async () => {
    const { db, deps, scope, issued } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    const results = await Promise.allSettled([
      provisionUser(deps, scope, { userId: "user-1", templateId: "general" }),
      provisionUser(deps, scope, { userId: "user-1", templateId: "general" }),
    ]);
    const fulfilled = results.filter((item) => item.status === "fulfilled");
    const rejected = results.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(issued).toHaveLength(1);
    expect(botRepository(db).list(userScope("user-1"))).toHaveLength(1);
    expect(quotaRepository(db).find(userScope("user-1"))).toBeTruthy();
    db.$client.close();
  });

  it("does not grant bot creation quota until provisioning is healthy", async () => {
    const { db, deps, scope } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    const { promise: entered, resolve: healthyEntered } = Promise.withResolvers<void>();
    const { promise: released, resolve: releaseHealthy } = Promise.withResolvers<void>();
    deps.waitHealthy = async () => {
      healthyEntered();
      await released;
      throw new Error("健康检查失败");
    };
    const provisioning = provisionUser(deps, scope, { userId: "user-1", templateId: "general" });
    const failed = expect(provisioning).rejects.toThrow("健康检查失败");
    await entered;
    const pendingQuota = quotaRepository(db).find(userScope("user-1"));
    releaseHealthy();
    await failed;
    expect(pendingQuota).toBeUndefined();
    expect(botRepository(db).list(userScope("user-1"))).toEqual([]);
    expect(quotaRepository(db).find(userScope("user-1"))).toBeUndefined();
    db.$client.close();
  });

  it("keeps provisional bots invisible and immutable until the quota is published", async () => {
    const { db, deps } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let taskStarts = 0;
    const app = buildApp({ db, key: deps.key, config: deps.config, driver: {} as never }, {
      ensureMachine: async () => {},
      waitHealthy: async () => { entered.resolve(); await gate.promise; },
      deleteMachine: async () => {},
      prepareEndpoint: async () => { taskStarts += 1; throw new Error("provisional task must not start"); },
    });
    await app.ready();
    const admin = createSession(db, deps.key, "admin-1", "refresh", new Date());
    const user = createSession(db, deps.key, "user-1", "refresh", new Date());
    const headers = (session: { token: string; csrf: string }) => ({ cookie: `vb_session=${session.token}`, "x-vb-csrf": session.csrf });
    const provisioning = app.inject({ method: "POST", url: "/api/admin/users/provision", headers: headers(admin), payload: { userId: "user-1", templateId: "general" } }).then((response) => response);
    try {
      await entered.promise;
      const provisional = botRepository(db).list(userScope("user-1"))[0]!;
      const listed = await app.inject({ method: "GET", url: "/api/bots", headers: headers(user) });
      const reads = [];
      for (const suffix of ["", "/memories", "/conversations"]) {
        reads.push(await app.inject({ method: "GET", url: `/api/bots/${provisional.id}${suffix}`, headers: headers(user) }));
      }
      const direct = await chatService(app).send({ userId: "user-1", botId: provisional.id, text: "must not start directly", mode: "queue" }).then(() => null, (error: unknown) => error);
      const sent = await app.inject({ method: "POST", url: `/api/bots/${provisional.id}/messages`, headers: headers(user), payload: { text: "must not start" } });
      const removedMemory = await app.inject({ method: "DELETE", url: `/api/bots/${provisional.id}/memories/unknown`, headers: headers(user) });
      const removedBot = await app.inject({ method: "DELETE", url: `/api/bots/${provisional.id}`, headers: headers(user) });
      gate.resolve();
      const completed = await provisioning;
      expect(listed.json().bots).toEqual([]);
      expect(reads.map((response) => response.statusCode)).toEqual([404, 404, 404]);
      expect(direct).toMatchObject({ statusCode: 403 });
      expect([sent.statusCode, removedMemory.statusCode, removedBot.statusCode]).toEqual([403, 403, 403]);
      expect(taskStarts).toBe(0);
      expect(db.$client.prepare("select count(*) as count from tasks").get()).toEqual({ count: 0 });
      expect(completed.statusCode).toBe(201);
      const visible = await app.inject({ method: "GET", url: "/api/bots", headers: headers(user) });
      expect(visible.json().bots.map((bot: { id: string }) => bot.id)).toEqual([provisional.id]);
    } finally {
      gate.resolve();
      await provisioning;
      await app.close();
      db.$client.close();
    }
  });

  it("does not resume queued work for a user without provisioning quota", async () => {
    const { db, deps } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    const scope = userScope("user-1");
    const bot = botRepository(db).insert(scope, { id: "pending-bot", name: "Pending", model: "fake" });
    const chat = chatRepository(db);
    const conversation = chat.insertConversation(scope, { id: "pending-conversation", botId: bot.id, title: "Pending" })!;
    chat.insertTask(scope, { id: "pending-task", botId: bot.id, conversationId: conversation.id });
    let starts = 0;
    const app = buildApp({ db, key: deps.key, config: deps.config, driver: {} as never }, {
      prepareEndpoint: async () => { starts += 1; throw new Error("unprovisioned task must stay queued"); },
    });
    try {
      await app.ready();
      expect(starts).toBe(0);
      expect(chat.findTask(scope, "pending-task")?.state).toBe("queued");
    } finally {
      await app.close();
      db.$client.close();
    }
  });

  it("serializes provisioning addressed by local id and external subject", async () => {
    const { db, deps, scope, issued } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    identityRepository(db).insert({ provider: "oidc", subject: "sub-1", userId: "user-1", email: "a@example.com", emailVerified: false });
    const results = await Promise.allSettled([
      provisionUser(deps, scope, { userId: "user-1", templateId: "general" }),
      provisionUser(deps, scope, { subject: "sub-1", templateId: "general" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(issued).toHaveLength(1);
    expect(botRepository(db).list(userScope("user-1"))).toHaveLength(1);
    db.$client.close();
  });

  it.each(["ensure", "healthy"])("hides the failed bot and reports an incomplete rollback when revoke fails after %s", async (phase) => {
    const { db, deps, scope, issued, calls, setEnsureError, setHealthyError } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    deps.credentials.revoke = async () => { throw new Error("upstream unavailable"); };
    if (phase === "ensure") setEnsureError(new Error("机器创建失败"));
    else setHealthyError(new Error("健康检查失败"));
    await expect(provisionUser(deps, scope, { userId: "user-1", templateId: "general" })).rejects.toThrow("回滚未完成");
    expect(botRepository(db).list(userScope("user-1"))).toEqual([]);
    expect(issued).toHaveLength(1);
    expect(db.$client.prepare("select external_id, revoked_at from model_credentials").all()).toEqual([
      { external_id: `ext-${issued[0]}`, revoked_at: null },
    ]);
    expect(calls.deleted).toBe(1);
    expect(quotaRepository(db).find(userScope("user-1"))).toBeUndefined();
    db.$client.close();
  });

  it("reports machine rollback failure instead of swallowing it", async () => {
    const { db, deps, scope, setHealthyError } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    setHealthyError(new Error("健康检查失败"));
    deps.deleteMachine = async () => { throw new Error("docker unavailable"); };
    await expect(provisionUser(deps, scope, { userId: "user-1", templateId: "general" })).rejects.toThrow("回滚未完成");
    expect(botRepository(db).list(userScope("user-1"))).toEqual([]);
    expect(quotaRepository(db).find(userScope("user-1"))).toBeUndefined();
    db.$client.close();
  });

  it("revokes the upstream key if local credential persistence fails", async () => {
    const { db, deps, scope, issued, revoked, calls } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    db.$client.exec("create trigger reject_credential before insert on model_credentials begin select raise(abort, 'credential write failed'); end");
    await expect(provisionUser(deps, scope, { userId: "user-1", templateId: "general" })).rejects.toThrow("credential write failed");
    expect(issued).toHaveLength(1);
    expect(revoked).toEqual([`ext-${issued[0]}`]);
    expect(botRepository(db).list(userScope("user-1"))).toEqual([]);
    expect(calls.ensure).toBe(0);
    expect(calls.deleted).toBe(0);
    expect(quotaRepository(db).find(userScope("user-1"))).toBeUndefined();
    db.$client.close();
  });

  it("rejects a channel the user was not granted", async () => {
    const { db, deps, scope, issued } = setup([{ id: "allowed", name: "允许" }]);
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    identityRepository(db).insert({
      provider: "oidc",
      subject: "sub-1",
      userId: "user-1",
      email: "a@example.com",
      emailVerified: false,
    });
    await expect(provisionUser(deps, scope, { userId: "user-1", templateId: "general", channelId: "nope" })).rejects.toThrow(
      /渠道/,
    );
    expect(issued).toEqual([]);
    expect(quotaRepository(db).find(userScope("user-1"))).toBeUndefined();
    const ok = await provisionUser(deps, scope, { userId: "user-1", templateId: "general", channelId: "allowed" });
    expect(ok.userId).toBe("user-1");
    db.$client.close();
  });

  it("refuses an unprovisioned user at the bot route", async () => {
    const { db, deps } = setup();
    userRepository(db).insert({ id: "user-1", email: "a@example.com", name: "A", status: "active", isAdmin: false });
    const app = buildApp(
      { db, driver: {} as never, config: deps.config, key: deps.key },
      { ensureMachine: async () => {}, prepareEndpoint: async () => ({ host: "127.0.0.1", port: 1, token: "t" }) },
    );
    await app.ready();
    const session = createSession(db, deps.key, "user-1", "refresh", new Date());
    const response = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: { cookie: `vb_session=${session.token}`, "x-vb-csrf": session.csrf, "content-type": "application/json" },
      payload: { name: "Ada", model: "fake" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("尚未开通，请联系管理员");
    await app.close();
    db.$client.close();
  });
});
