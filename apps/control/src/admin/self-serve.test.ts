import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { provisionUser, selfServeProvision, type ProvisionDeps } from "./service.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { auditRepository } from "../db/audit.js";
import { botRepository } from "../db/bots.js";
import { chatRepository } from "../db/chat.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { memoryRepository } from "../db/memories.js";
import { quotaRepository } from "../db/quotas.js";
import { settingsRepository, type BotTemplate } from "../db/settings.js";
import { userRepository } from "../db/users.js";
import { acceptIdentity, LoginRejected } from "../login.js";
import type { CredentialProvider } from "../providers.js";
import { adminScope, userScope } from "../scope.js";
import { createSession } from "../session.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function template(id: string, name: string): BotTemplate {
  return {
    id,
    name,
    description: "",
    instructions: "用中文",
    defaultModel: "fake",
    initialMemories: ["记住这件事"],
    welcome: `你好，我是${name}。`,
  };
}

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vb-self-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const key = loadOrCreateKey(join(dir, "secret.key"));
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_MODEL_API_KEY: "shared",
    VB_ALLOW_SIGNUP: "false",
    VB_MODELS: "fake",
    VB_ALLOW_SELF_SERVE: "true",
    ...env,
  });
  const issued: string[] = [];
  const revoked: string[] = [];
  const calls = { ensure: 0, healthy: 0, deleted: 0 };
  let ensureError: Error | undefined;
  let healthyError: Error | undefined;
  const credentials: CredentialProvider = {
    async issue(bot) {
      issued.push(bot.id);
      return { provider: "fake", externalId: `ext-${bot.id}`, secret: `secret-${bot.id}`, policyRef: null, shared: false };
    },
    async revoke(credential) {
      if (credential.externalId) revoked.push(credential.externalId);
    },
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
  const users = userRepository(db);
  users.insert({ id: "admin-1", email: "admin@example.com", name: "Admin", status: "active", isAdmin: true });
  return {
    db,
    key,
    config,
    deps,
    issued,
    revoked,
    calls,
    users,
    setEnsureError: (error: Error) => {
      ensureError = error;
    },
    setHealthyError: (error: Error | undefined) => {
      healthyError = error;
    },
  };
}

function addUser(db: AppDatabase, id: string, status: "active" | "disabled" = "active") {
  userRepository(db).insert({ id, email: `${id}@example.com`, name: id, status, isAdmin: false });
}

function headers(session: { token: string; csrf: string }, write = false): Record<string, string> {
  return {
    cookie: `vb_session=${session.token}`,
    ...(write ? { "x-vb-csrf": session.csrf, "content-type": "application/json" } : {}),
  };
}

async function http(env: Record<string, string> = {}) {
  const started = setup(env);
  const app = buildApp(
    { db: started.db, key: started.key, config: started.config, driver: {} as never },
    {
      ensureMachine: started.deps.ensureMachine,
      waitHealthy: started.deps.waitHealthy,
      deleteMachine: started.deps.deleteMachine,
    },
  );
  await app.ready();
  return { ...started, app };
}

describe("self-serve provision", () => {
  it("rejects self-serve while the switch is off and does not create a machine", async () => {
    const { db, deps, calls } = setup({ VB_ALLOW_SELF_SERVE: "false" });
    addUser(db, "user-a");
    await expect(selfServeProvision(deps, "user-a")).rejects.toMatchObject({ statusCode: 403, message: "未开启自助开通" });
    expect(calls.ensure).toBe(0);
    expect(quotaRepository(db).find(userScope("user-a"))).toBeUndefined();
    db.$client.close();
  });

  it("provisions the signed-in user from the general template and writes a self-serve audit", async () => {
    const { db, deps, calls, issued } = setup();
    addUser(db, "user-a");
    settingsRepository(db).saveTemplates([template("other", "其他"), template("general", "通用助手")]);
    const result = await selfServeProvision(deps, "user-a");
    expect(result).toMatchObject({ userId: "user-a", email: "user-a@example.com", model: "fake" });
    expect(result.quota.maxBots).toBe(5);
    expect(issued).toEqual([result.botId]);
    expect(calls).toMatchObject({ ensure: 1, healthy: 1, deleted: 0 });
    expect(botRepository(db).findById(userScope("user-a"), result.botId)?.name).toBe("通用助手");
    expect(memoryRepository(db).list(userScope("user-a"), result.botId)?.map((item) => item.content)).toEqual(["记住这件事"]);
    const conversations = chatRepository(db).listConversations(userScope("user-a"), result.botId);
    const messages = chatRepository(db).listMessages(userScope("user-a"), conversations?.[0]?.id ?? "");
    expect(messages?.[0]?.contentJson).toContain("你好，我是通用助手。");
    const audit = auditRepository(db).list(adminScope("admin-1"), 10);
    expect(audit.some((row) => row.action === "user.self_serve_provision" && row.actorUserId === "user-a" && JSON.stringify(row.attrs).includes('"ok":true'))).toBe(true);
    expect(audit.some((row) => row.action === "user.provision")).toBe(false);
    db.$client.close();
  });

  it("uses the first template when general is missing and refuses an empty list", async () => {
    const { db, deps, calls } = setup();
    addUser(db, "user-a");
    addUser(db, "user-b");
    settingsRepository(db).saveTemplates([template("writer", "写作者")]);
    const result = await selfServeProvision(deps, "user-a");
    expect(botRepository(db).findById(userScope("user-a"), result.botId)?.name).toBe("写作者");
    settingsRepository(db).saveTemplates([]);
    await expect(selfServeProvision(deps, "user-b")).rejects.toMatchObject({
      statusCode: 503,
      message: "管理员尚未配置默认模板，请联系管理员",
    });
    expect(calls.ensure).toBe(1);
    expect(quotaRepository(db).find(userScope("user-b"))).toBeUndefined();
    db.$client.close();
  });

  it("returns 409 for a second call and lets only one of two concurrent calls succeed", async () => {
    const { db, deps, issued, calls } = setup();
    addUser(db, "user-a");
    const first = await selfServeProvision(deps, "user-a");
    await expect(selfServeProvision(deps, "user-a")).rejects.toMatchObject({ statusCode: 409, message: "已经开通" });
    expect(issued).toEqual([first.botId]);
    expect(calls.ensure).toBe(1);
    expect(botRepository(db).list(userScope("user-a"))).toHaveLength(1);

    addUser(db, "user-b");
    const raced = await Promise.allSettled([selfServeProvision(deps, "user-b"), selfServeProvision(deps, "user-b")]);
    expect(raced.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(botRepository(db).list(userScope("user-b"))).toHaveLength(1);
    expect(calls.ensure).toBe(2);
    db.$client.close();
  });

  it("refuses a full cap and lets only one of two users take the last seat", async () => {
    const { db, deps, calls } = setup({ VB_MAX_PROVISIONED_USERS: "1" });
    addUser(db, "user-a");
    addUser(db, "user-b");
    let entered = 0;
    const firstEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    deps.ensureMachine = async () => {
      entered += 1;
      calls.ensure += 1;
      if (entered === 1) firstEntered.resolve();
      await release.promise;
    };
    const raced = Promise.allSettled([selfServeProvision(deps, "user-a"), selfServeProvision(deps, "user-b")]);
    await firstEntered;
    const { promise: turn, resolve: nextTurn } = Promise.withResolvers<void>();
    setImmediate(nextTurn);
    await turn;
    expect(entered).toBe(1);
    release.resolve();
    const settled = await raced;
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
    const rejected = settled.find((item) => item.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({ statusCode: 409, message: "开通名额已满，请联系管理员" });
    const provisioned = ["user-a", "user-b"].filter((id) => quotaRepository(db).find(userScope(id)));
    expect(provisioned).toHaveLength(1);
    expect(calls.ensure).toBe(1);
    expect(calls.deleted).toBe(0);

    addUser(db, "user-c");
    await expect(selfServeProvision(deps, "user-c")).rejects.toMatchObject({ statusCode: 409, message: "开通名额已满，请联系管理员" });
    expect(calls.ensure).toBe(1);
    const admin = await provisionUser(deps, adminScope("admin-1"), { userId: "user-c", templateId: "general" });
    expect(admin.userId).toBe("user-c");
    expect(quotaRepository(db).find(userScope("user-c"))).toBeTruthy();
    expect(auditRepository(db).list(adminScope("admin-1"), 20).some((row) => row.action === "user.provision" && row.target === "user-c")).toBe(true);
    db.$client.close();
  });

  it("rolls back the key, the new machine and the quota when the machine fails", async () => {
    const { db, deps, issued, revoked, calls, setHealthyError, setEnsureError } = setup();
    addUser(db, "user-a");
    setHealthyError(new Error("健康检查失败"));
    await expect(selfServeProvision(deps, "user-a")).rejects.toThrow(/健康检查失败/);
    expect(issued).toHaveLength(1);
    expect(revoked).toEqual([`ext-${issued[0]}`]);
    expect(calls.deleted).toBe(1);
    expect(quotaRepository(db).find(userScope("user-a"))).toBeUndefined();
    expect(botRepository(db).list(userScope("user-a"))).toEqual([]);
    expect(
      auditRepository(db)
        .list(adminScope("admin-1"), 5)
        .some((row) => row.action === "user.self_serve_provision" && JSON.stringify(row.attrs).includes("健康检查失败")),
    ).toBe(true);

    addUser(db, "user-b");
    setHealthyError(undefined);
    setEnsureError(new Error("机器创建失败"));
    await expect(selfServeProvision(deps, "user-b")).rejects.toThrow(/机器创建失败/);
    expect(revoked).toHaveLength(2);
    expect(calls.deleted).toBe(2);
    expect(quotaRepository(db).find(userScope("user-b"))).toBeUndefined();
    expect(botRepository(db).list(userScope("user-b"))).toEqual([]);
    db.$client.close();
  });

  it("does not provision a disabled user", async () => {
    const { db, deps, calls } = setup();
    addUser(db, "user-a", "disabled");
    await expect(selfServeProvision(deps, "user-a")).rejects.toMatchObject({ statusCode: 403, message: "用户已禁用" });
    expect(calls.ensure).toBe(0);
    expect(quotaRepository(db).find(userScope("user-a"))).toBeUndefined();
    db.$client.close();
  });

  it("keeps signup closed for an unknown account when self-serve is on", () => {
    const { db, config } = setup({ VB_ALLOW_SELF_SERVE: "true", VB_ALLOW_SIGNUP: "false" });
    expect(config.allowSignup).toBe(false);
    expect(() =>
      acceptIdentity(db, config, "oidc", { sub: "stranger", email: "stranger@example.com", emailVerified: true, name: "Stranger" }),
    ).toThrow(LoginRejected);
    try {
      acceptIdentity(db, config, "oidc", { sub: "stranger", email: "stranger@example.com", emailVerified: true, name: "Stranger" });
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 403, message: "不允许注册" });
    }
    expect(userRepository(db).findByEmail("stranger@example.com")).toEqual([]);
    db.$client.close();
  });
});

describe("self-serve http", () => {
  it("serves provision, me flags, and the new-bot switch without blocking admin provisioning", async () => {
    const off = await http({ VB_ALLOW_SELF_SERVE: "false", VB_ALLOW_NEW_BOT: "false" });
    addUser(off.db, "user-a");
    const deniedSession = createSession(off.db, off.key, "user-a", "refresh", new Date());
    const anonymous = await off.app.inject({ method: "POST", url: "/api/me/provision" });
    expect(anonymous.statusCode).toBe(401);
    const missingCsrf = await off.app.inject({ method: "POST", url: "/api/me/provision", headers: headers(deniedSession) });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toEqual({ error: "缺少 CSRF" });
    const denied = await off.app.inject({ method: "POST", url: "/api/me/provision", headers: headers(deniedSession, true), payload: {} });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "未开启自助开通" });
    const meOff = await off.app.inject({ method: "GET", url: "/api/me", headers: headers(deniedSession) });
    expect(meOff.json()).toMatchObject({
      id: "user-a",
      email: "user-a@example.com",
      name: "user-a",
      isAdmin: false,
      provisioned: false,
      allowSelfServe: false,
      allowNewBot: false,
      csrf: deniedSession.csrf,
    });
    await off.app.close();
    off.db.$client.close();

    const on = await http({ VB_ALLOW_NEW_BOT: "false" });
    addUser(on.db, "user-a");
    addUser(on.db, "user-b");
    const user = createSession(on.db, on.key, "user-a", "refresh", new Date());
    const created = await on.app.inject({ method: "POST", url: "/api/me/provision", headers: headers(user, true), payload: {} });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ userId: "user-a", email: "user-a@example.com", model: "fake", quota: { maxBots: 5 } });
    const again = await on.app.inject({ method: "POST", url: "/api/me/provision", headers: headers(user, true), payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "已经开通" });
    const meOn = await on.app.inject({ method: "GET", url: "/api/me", headers: headers(user) });
    expect(meOn.json()).toMatchObject({
      id: "user-a",
      provisioned: true,
      allowSelfServe: true,
      allowNewBot: false,
      csrf: user.csrf,
    });
    const blocked = await on.app.inject({
      method: "POST",
      url: "/api/bots",
      headers: headers(user, true),
      payload: { name: "第二个", model: "fake" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: "管理员已关闭自建 bot" });
    expect(botRepository(on.db).list(userScope("user-a"))).toHaveLength(1);
    const admin = createSession(on.db, on.key, "admin-1", "refresh", new Date());
    const delegated = await on.app.inject({
      method: "POST",
      url: "/api/admin/users/provision",
      headers: headers(admin, true),
      payload: { userId: "user-b", templateId: "general" },
    });
    expect(delegated.statusCode).toBe(201);
    expect(quotaRepository(on.db).find(userScope("user-b"))).toBeTruthy();
    expect(botRepository(on.db).list(userScope("user-b"))).toHaveLength(1);
    await on.app.close();
    on.db.$client.close();
  });
});
