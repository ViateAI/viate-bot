import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { provisionUser, type ProvisionDeps } from "../admin/service.js";
import { installMcpBlock, installMcpTool } from "../agent/app-tools.js";
import { foldNoticeEntries, insertAppUpdateNotice, NOTICE_PREFIX } from "../agent/notices.js";
import { buildSystemPrompt, NOTICE_GUIDANCE } from "../agent/prompt.js";
import { loadTranscriptEntries, messageView } from "../agent/view.js";
import { createApprovalGate } from "../approvals/gate.js";
import { authenticated } from "../auth.js";
import { createBot } from "../bot-service.js";
import { loadConfig } from "../config.js";
import { chatRepository } from "../db/chat.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { machineRepository } from "../db/machines.js";
import { auditLog } from "../db/schema.js";
import { userRepository, type UserRecord } from "../db/users.js";
import { ulid } from "../id.js";
import { sharedCredentialProvider } from "../shared-key.js";
import { adminScope, userScope } from "../scope.js";
import type { ResolvedSession } from "../session.js";
import {
  deliverAppUpdateNotices,
  installForUser,
  listUserInstalls,
  markImportantVersion,
  publishCatalogVersion,
  registerCatalogRoutes,
  retireVersion,
  setVisibility,
  uninstallForUser,
  type CatalogDeps,
  type CatalogInstaller,
} from "./catalog.js";

const dirs: string[] = [];
const closers: Array<() => void> = [];
let shaByte = 1;

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-notice-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => db.$client.close());
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const key = randomBytes(32);
  const users = userRepository(db);
  const admin = users.insert({ id: "admin", email: "admin@example.com", name: "Admin", status: "active", isAdmin: true });
  users.insert({ id: "alice", email: "alice@example.com", name: "Alice", status: "active", isAdmin: false });
  users.insert({ id: "nina", email: "nina@example.com", name: "Nina", status: "active", isAdmin: false });
  users.insert({ id: "gus", email: "gus@example.com", name: "Gus", status: "active", isAdmin: false });
  users.insert({ id: "ed", email: "ed@example.com", name: "Ed", status: "active", isAdmin: false });
  users.insert({ id: "max", email: "max@example.com", name: "Max", status: "active", isAdmin: false });
  users.insert({ id: "sam", email: "sam@example.com", name: "Sam", status: "active", isAdmin: false });
  for (const userId of ["alice", "nina", "gus", "ed", "max", "sam"]) machineFor(db, userId);
  const installer: CatalogInstaller = { async install() {}, async uninstall() {} };
  const deps: CatalogDeps = { db, key, installer, dataDir: dir };
  return { db, key, deps, admin };
}

function machineFor(db: AppDatabase, userId: string) {
  machineRepository(db).insert(userScope(userId), {
    id: `machine-${userId}`,
    userId,
    state: "running",
    containerId: "c",
    networkId: "n",
    volumeName: `vol-${userId}`,
    imageVersion: "dev",
    spec: { cpu: 1, memMb: 512, diskGb: 10 },
    tokenEnc: "enc",
  });
}

function publish(deps: CatalogDeps, version: string) {
  shaByte += 1;
  return publishCatalogVersion(deps, adminScope("admin"), {
    name: "pager",
    version,
    manifestJson: "{}",
    archivePath: `/var/lib/viate/apps/pager/${version}.tar.zst`,
    sha256: shaByte.toString(16).padStart(2, "0").repeat(32),
  });
}

function notices(db: AppDatabase) {
  return db.$client.prepare("select user_id as userId, delivered_message_id as deliveredMessageId, payload_json as payloadJson from system_notices order by user_id").all() as Array<{
    userId: string;
    deliveredMessageId: string | null;
    payloadJson: string;
  }>;
}

function sessionFor(user: UserRecord): ResolvedSession {
  const now = new Date().toISOString();
  return {
    token: `token-${user.id}`,
    user,
    session: {
      id: `session-${user.id}`,
      userId: user.id,
      tokenHash: "hash",
      csrf: "csrf",
      refreshTokenEnc: "enc",
      expiresAt: now,
      lastSeenAt: now,
      lastValidatedAt: now,
      createdAt: now,
    },
  };
}

describe("app update notices", () => {
  it("rejects a retired version, a missing version, an empty note, and a non-admin", async () => {
    const { db, deps, admin } = boot();
    const first = publish(deps, "1.0.0");
    setVisibility(deps, adminScope("admin"), first.appId, { scope: "all" });
    retireVersion(deps, adminScope("admin"), first.appId, first.versionId);
    expect(() => markImportantVersion(deps, adminScope("admin"), first.appId, first.versionId, "请升级")).toThrow(
      expect.objectContaining({ statusCode: 409, message: "不能推荐已下架的版本" }),
    );
    expect(() => markImportantVersion(deps, adminScope("admin"), first.appId, "missing", "请升级")).toThrow(
      expect.objectContaining({ statusCode: 404, message: "找不到" }),
    );
    const second = publish(deps, "2.0.0");
    expect(() => markImportantVersion(deps, adminScope("admin"), second.appId, second.versionId, "   ")).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (request) => {
      authenticated.set(request, sessionFor(userRepository(db).findById("alice")!));
    });
    registerCatalogRoutes(app, deps);
    await app.ready();
    closers.push(() => void app.close());
    const denied = await app.inject({
      method: "POST",
      url: `/api/admin/apps/${second.appId}/versions/${second.versionId}/important`,
      payload: { note: "请升级" },
    });
    expect(denied.statusCode).toBe(404);
    expect(admin.id).toBe("admin");
    expect(notices(db)).toEqual([]);
  });

  it("notifies each eligible user once and leaves everyone else out", async () => {
    const { db, key, deps } = boot();
    const old = publish(deps, "1.0.0");
    const next = publish(deps, "2.0.0");
    setVisibility(deps, adminScope("admin"), old.appId, { scope: "all" });
    await installForUser(deps, "alice", "pager", { version: "1.0.0" });
    await installForUser(deps, "nina", "pager", { version: "1.0.0" });
    await installForUser(deps, "gus", "pager", { version: "1.0.0" });
    await installForUser(deps, "ed", "pager", { version: "1.0.0" });
    await installForUser(deps, "max", "pager", { version: "2.0.0" });
    db.$client.prepare("insert into bots (id, user_id, name, model, created_at, updated_at) values ('bot-alice', 'alice', 'Ada', 'm', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')").run();
    const chat = chatRepository(db);
    const conversation = chat.insertConversation(userScope("alice"), { id: "conv-alice", botId: "bot-alice", title: "已有对话" })!;
    const task = chat.insertTask(userScope("alice"), { id: "task-alice", botId: "bot-alice", conversationId: conversation.id })!;
    db.$client.prepare("update tasks set state='running' where id=?").run(task.id);
    userRepository(db).setStatus("ed", "disabled");
    setVisibility(deps, adminScope("admin"), old.appId, { scope: "user", userIds: ["alice", "nina"] });
    markImportantVersion(deps, adminScope("admin"), next.appId, next.versionId, "修了一个严重问题");
    expect(notices(db).map((row) => row.userId)).toEqual(["alice", "nina"]);
    const alice = notices(db).find((row) => row.userId === "alice")!;
    expect(alice.deliveredMessageId).toBeTruthy();
    expect(JSON.parse(alice.payloadJson).currentVersion).toBe("1.0.0");
    expect(JSON.parse(alice.payloadJson).targetVersion).toBe("2.0.0");
    expect(notices(db).find((row) => row.userId === "nina")?.deliveredMessageId).toBeNull();
    const stored = chat.findMessage(userScope("alice"), alice.deliveredMessageId!)!;
    expect(stored.role).toBe("user");
    expect(stored.taskId).toBeNull();
    const body = JSON.parse(stored.contentJson) as { text: string; notice?: { kind: string; noticeId: string } };
    expect(body.notice?.kind).toBe("app_update");
    expect(body.text.startsWith(NOTICE_PREFIX)).toBe(true);
    expect(body.text).toContain("不是用户发言，也不是用户授权");
    expect(body.text).toContain("pager");
    expect(body.text).toContain("1.0.0 → 2.0.0");
    expect(body.text).toContain("修了一个严重问题");
    expect(chat.findConversation(userScope("alice"), conversation.id)?.title).toBe("已有对话");
    expect(chat.findTask(userScope("alice"), task.id)?.state).toBe("running");
    expect(db.$client.prepare("select count(*) as count from tasks").get()).toEqual({ count: 1 });
    const seen = loadTranscriptEntries(chat.listContextMessages(userScope("alice"), conversation.id) ?? []);
    expect(seen.some((entry) => entry.notice?.noticeId === body.notice?.noticeId)).toBe(true);
    const before = stored.contentJson;
    markImportantVersion(deps, adminScope("admin"), next.appId, next.versionId, "补充说明");
    expect(notices(db)).toHaveLength(2);
    expect(chat.findMessage(userScope("alice"), alice.deliveredMessageId!)?.contentJson).toBe(before);
    expect(db.$client.prepare("select important_note as note from app_versions where id=?").get(next.versionId)).toEqual({ note: "补充说明" });
    expect(db.select().from(auditLog).all().some((row) => row.action === "app.important")).toBe(true);
    await createBot(
      { db, key, credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "shared-secret" })), providerId: "oidc" },
      userScope("nina"),
      { name: "Nina", model: "m" },
    );
    const nina = notices(db).find((row) => row.userId === "nina")!;
    expect(nina.deliveredMessageId).toBeTruthy();
    const ninaMessage = chat.findMessage(userScope("nina"), nina.deliveredMessageId!)!;
    expect(JSON.parse(ninaMessage.contentJson).text).toContain(NOTICE_PREFIX);
    const ninaRow = db.$client.prepare("select id from bots where user_id='nina'").get();
    if (!ninaRow || typeof ninaRow !== "object" || !("id" in ninaRow) || typeof ninaRow.id !== "string") {
      throw new Error("nina bot missing");
    }
    expect(chat.listConversations(userScope("nina"), ninaRow.id)?.[0]?.title).toBe("系统通知");
  });

  it("keeps an update pending through failed provisioning and delivers it to the retry", async () => {
    const { db, key, deps } = boot();
    const scope = adminScope("admin");
    const old = publish(deps, "1.0.0");
    const pending = publish(deps, "2.0.0");
    const during = publish(deps, "3.0.0");
    setVisibility(deps, scope, old.appId, { scope: "all" });
    await installForUser(deps, "alice", "pager", { version: "1.0.0" });
    markImportantVersion(deps, scope, pending.appId, pending.versionId, "before provisioning");
    const provisioning: ProvisionDeps = {
      db, key, config: loadConfig({ VB_MODELS: "test-model" }), providerId: "oidc", directory: {},
      credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "test-key" })),
      ensureMachine: async () => {},
      deleteMachine: async () => {},
      waitHealthy: async () => {
        markImportantVersion(deps, scope, during.appId, during.versionId, "during provisioning");
        throw new Error("health check failed");
      },
    };
    const input = { userId: "alice", templateId: "general" };
    await expect(provisionUser(provisioning, scope, input)).rejects.toThrow("health check failed");
    expect(notices(db).map((row) => row.deliveredMessageId)).toEqual([null, null]);
    const result = await provisionUser({ ...provisioning, waitHealthy: async () => {} }, scope, input);
    const chat = chatRepository(db);
    const [conversation] = chat.listConversations(userScope("alice"), result.botId)!;
    expect(conversation?.title).toBe("系统通知");
    const messages = chat.listMessages(userScope("alice"), conversation!.id)!.map(messageView);
    expect(messages.filter((message) => message.notice).map((message) => message.text.split("说明：").at(-1)))
      .toEqual(["before provisioning", "during provisioning"]);
  });

  it("does not consume a notice when first-bot creation fails after the version is marked", async () => {
    const { db, key, deps } = boot();
    const admin = adminScope("admin");
    const old = publish(deps, "1.0.0");
    const next = publish(deps, "2.0.0");
    setVisibility(deps, admin, old.appId, { scope: "all" });
    await installForUser(deps, "alice", "pager", { version: "1.0.0" });
    const botDeps = { db, key, credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "test-key" })), providerId: "oidc" };
    const scope = userScope("alice");
    const input = { name: "First", model: "test-model" };
    await expect(createBot({ ...botDeps, ensureMachine: async () => {
      markImportantVersion(deps, admin, next.appId, next.versionId, "while creating");
      throw new Error("machine setup failed");
    } }, scope, input)).rejects.toThrow("machine setup failed");
    expect(notices(db).map((row) => row.deliveredMessageId)).toEqual([null]);
    const bot = await createBot(botDeps, scope, input);
    const chat = chatRepository(db);
    const [conversation] = chat.listConversations(scope, bot.id)!;
    expect(chat.listMessages(scope, conversation!.id)?.map(messageView).map((message) => message.notice?.kind)).toEqual(["app_update"]);
  });

  it("delivers the pending update to an already-ready bot when an earlier creation fails", async () => {
    const { db, key, deps } = boot();
    const admin = adminScope("admin");
    const old = publish(deps, "1.0.0");
    const next = publish(deps, "2.0.0");
    setVisibility(deps, admin, old.appId, { scope: "all" });
    await installForUser(deps, "alice", "pager", { version: "1.0.0" });
    markImportantVersion(deps, admin, next.appId, next.versionId, "pending for next primary");
    const creds = { db, key, credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "test-key" })), providerId: "oidc" };
    const user = userScope("alice");
    const { promise: entered, resolve: started } = Promise.withResolvers<void>();
    const { promise: gated, resolve: release } = Promise.withResolvers<void>();
    const first = createBot({ ...creds, ensureMachine: async () => {
      started();
      await gated;
      throw new Error("first setup failed");
    } }, user, { name: "First", model: "test-model" });
    const rejected = expect(first).rejects.toThrow("first setup failed");
    await entered;
    const second = await createBot(creds, user, { name: "Second", model: "test-model" }).finally(release);
    await rejected;
    const chat = chatRepository(db);
    const conversation = chat.listConversations(user, second.id)?.[0];
    expect(conversation?.title).toBe("系统通知");
    expect(chat.listMessages(user, conversation!.id)?.map(messageView).map((message) => message.notice?.kind)).toEqual(["app_update"]);
  });

  it.each(["hidden", "uninstalled", "already updated", "disabled"] as const)("does not deliver a deferred update when the user is %s", async (reason) => {
    const { db, key, deps } = boot();
    const scope = adminScope("admin");
    const old = publish(deps, "1.0.0");
    const next = publish(deps, "2.0.0");
    setVisibility(deps, scope, old.appId, { scope: "all" });
    const install = await installForUser(deps, "alice", "pager", { version: "1.0.0" });
    markImportantVersion(deps, scope, next.appId, next.versionId, "update notice");
    expect(notices(db).map((row) => row.deliveredMessageId)).toEqual([null]);
    if (reason === "hidden") setVisibility(deps, scope, old.appId, { scope: "user", userIds: ["nina"] });
    if (reason === "uninstalled") await uninstallForUser(deps, "alice", install.id);
    if (reason === "already updated") await installForUser(deps, "alice", "pager", { version: "2.0.0" });
    if (reason === "disabled") userRepository(db).setStatus("alice", "disabled");
    const user = userScope("alice");
    const bot = await createBot(
      { db, key, credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "test-key" })), providerId: "oidc" },
      user,
      { name: "First", model: "test-model" },
    );
    expect(chatRepository(db).listConversations(user, bot.id)).toEqual([]);
    expect(notices(db).map((row) => row.deliveredMessageId)).toEqual([null]);
    if (reason === "hidden") {
      setVisibility(deps, scope, old.appId, { scope: "all" });
      markImportantVersion(deps, scope, next.appId, next.versionId, "update notice");
      expect(notices(db)).toHaveLength(1);
      expect(notices(db)[0]?.deliveredMessageId).toBeTruthy();
    }
  });

  it("folds adjacent notices for the model and keeps each row for the client", () => {
    const { db } = boot();
    db.$client.prepare("insert into bots (id, user_id, name, model, created_at, updated_at) values ('bot', 'alice', 'Ada', 'm', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')").run();
    const chat = chatRepository(db);
    const scope = userScope("alice");
    const conversation = chat.insertConversation(scope, { id: "conv", botId: "bot", title: "对话" })!;
    const payloads = [
      { appId: "pager", appName: "pager", currentVersion: "1.0.0", targetVersion: "1.1.0", targetVersionId: "v11", note: "第一则", markedAt: "2020-01-01T00:00:00.000Z" },
      { appId: "pager", appName: "pager", currentVersion: "1.0.0", targetVersion: "1.2.0", targetVersionId: "v12", note: "第二则", markedAt: "2020-01-02T00:00:00.000Z" },
      { appId: "meter", appName: "meter", currentVersion: "3.0.0", targetVersion: "3.1.0", targetVersionId: "v31", note: "另一应用", markedAt: "2020-01-03T00:00:00.000Z" },
    ];
    for (const payload of payloads) {
      const id = ulid();
      db.$client.prepare("insert into system_notices (id, user_id, kind, dedupe_key, payload_json, created_at) values (?, 'alice', 'app_update', ?, ?, ?)").run(id, `app_update:${payload.targetVersionId}`, JSON.stringify(payload), payload.markedAt);
      chat.insertMessage(scope, {
        id: ulid(),
        conversationId: conversation.id,
        role: "user",
        contentJson: (awaitNotice(id, payload)),
        taskId: null,
      });
    }
    const rows = chat.listMessages(scope, conversation.id)!;
    expect(rows.map(messageView)).toHaveLength(3);
    expect(rows.map(messageView).every((row) => row.notice?.kind === "app_update")).toBe(true);
    const folded = foldNoticeEntries(loadTranscriptEntries(rows));
    expect(folded.entries).toHaveLength(1);
    const text = folded.entries[0]?.message.role === "user" && typeof folded.entries[0].message.content === "string" ? folded.entries[0].message.content : "";
    expect(text.startsWith(NOTICE_PREFIX)).toBe(true);
    expect(text).toContain("1.0.0 → 1.2.0");
    expect(text).toContain("期间跨过的版本：1.1.0");
    expect(text).toContain("meter");
    expect(text).toContain("3.0.0 → 3.1.0");
    expect(text).toContain("第二则");
    const ids = rows.map((row) => row.id);
    expect(folded.groups.get(ids[2]!)?.slice().sort()).toEqual(ids.slice().sort());
    expect(chat.canSummarize(scope, conversation.id, [ids[2]!], ids[2]!)).toBe(false);
    expect(chat.canSummarize(scope, conversation.id, folded.groups.get(ids[2]!) ?? [], ids[2]!)).toBe(true);
    chat.saveSummary(scope, conversation.id, `${NOTICE_PREFIX}\n已折叠`, ids[2]!);
    const nextRows = chat.listContextMessages(scope, conversation.id)!;
    expect(nextRows.map((row) => row.id)).toEqual([ids[2]!]);
    const peeled = foldNoticeEntries(loadTranscriptEntries(nextRows)).entries.filter((entry) => entry.id !== ids[2]);
    const visible = `${NOTICE_PREFIX}\n已折叠\n${peeled.map((entry) => entry.message.role === "user" && typeof entry.message.content === "string" ? entry.message.content : "").join("\n")}`;
    expect(visible.split(NOTICE_PREFIX)).toHaveLength(2);

    chat.insertMessage(scope, {
      id: ulid(),
      conversationId: conversation.id,
      role: "user",
      contentJson: JSON.stringify({ pi: { role: "user", content: "我自己说的", timestamp: 1 }, text: "我自己说的" }),
      taskId: null,
    });
    const laterId = ulid();
    const later = { appId: "pager", appName: "pager", currentVersion: "1.2.0", targetVersion: "1.3.0", targetVersionId: "v13", note: "后一则", markedAt: "2020-01-04T00:00:00.000Z" };
    chat.insertMessage(scope, {
      id: laterId,
      conversationId: conversation.id,
      role: "user",
      contentJson: awaitNotice(laterId, later),
      taskId: null,
    });
    db.$client.prepare("update conversations set summary_text=null, summary_until_message_id=null where id='conv'").run();
    const split = foldNoticeEntries(loadTranscriptEntries(chat.listMessages(scope, conversation.id)!));
    const contents = split.entries.map((entry) => entry.message.role === "user" && typeof entry.message.content === "string" ? entry.message.content : "");
    expect(contents.some((item) => item === "我自己说的")).toBe(true);
    expect(contents.filter((item) => item.includes("1.3.0"))).toHaveLength(1);
    expect(contents.filter((item) => item.includes("1.2.0") && item.includes("期间跨过的版本"))).toHaveLength(1);
  });

  it("deletes a conversation that delivered a notice and does not deliver it again", async () => {
    const { db, key, deps } = boot();
    const creds = {
      db,
      key,
      credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "shared-secret" })),
      providerId: "oidc",
    };
    const scope = userScope("alice");
    const first = await createBot(creds, scope, { name: "Ada", model: "m" });
    const old = publish(deps, "1.0.0");
    const next = publish(deps, "2.0.0");
    setVisibility(deps, adminScope("admin"), old.appId, { scope: "all" });
    await installForUser(deps, "alice", "pager", { version: "1.0.0" });
    markImportantVersion(deps, adminScope("admin"), next.appId, next.versionId, "删对话后不能再投");
    const chat = chatRepository(db);
    const conversationId = chat.listConversations(scope, first.id)?.[0]?.id;
    expect(conversationId).toBeTruthy();
    const before = db.$client.prepare("select delivered_message_id as deliveredMessageId, delivered_at as deliveredAt from system_notices where user_id='alice'").get() as {
      deliveredMessageId: string | null;
      deliveredAt: string | null;
    };
    expect(before.deliveredMessageId).toBeTruthy();
    expect(before.deliveredAt).toBeTruthy();
    expect(chat.deleteConversation(scope, conversationId!)).toEqual([]);
    expect(chat.findConversation(scope, conversationId!)).toBeUndefined();
    const after = db.$client.prepare("select delivered_message_id as deliveredMessageId, delivered_at as deliveredAt from system_notices where user_id='alice'").get() as {
      deliveredMessageId: string | null;
      deliveredAt: string | null;
    };
    expect(after.deliveredMessageId).toBeNull();
    expect(after.deliveredAt).toBe(before.deliveredAt);
    const fresh = chat.insertConversation(scope, { id: ulid(), botId: first.id, title: "之后的对话" });
    expect(fresh).toBeTruthy();
    await createBot(creds, scope, { name: "Bea", model: "m" });
    expect(deliverAppUpdateNotices(db, "alice")).toBeUndefined();
    expect(chat.listMessages(scope, fresh!.id)).toEqual([]);
    expect(db.$client.prepare("select count(*) as count from messages").get()).toEqual({ count: 0 });
  });

  it("keeps exactly one notice when marking delivery fails before commit", async () => {
    const { db, key, deps } = boot();
    const creds = {
      db,
      key,
      credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "shared-secret" })),
      providerId: "oidc",
    };
    const scope = userScope("alice");
    const bot = await createBot(creds, scope, { name: "Ada", model: "m" });
    const note = "中途失败不能留两条";
    const old = publish(deps, "1.0.0");
    const next = publish(deps, "2.1.0");
    setVisibility(deps, adminScope("admin"), old.appId, { scope: "all" });
    await installForUser(deps, "alice", "pager", { version: "1.0.0" });
    expect(insertAppUpdateNotice(db, "alice", {
      appId: old.appId,
      appName: "pager",
      currentVersion: "1.0.0",
      targetVersion: "2.1.0",
      targetVersionId: next.versionId,
      note,
      markedAt: "2020-01-05T00:00:00.000Z",
    })).toBe(true);
    db.$client.exec(`
      create trigger fail_notice_mark before update on system_notices
      when new.delivered_at is not null
      begin
        select raise(abort, 'delivery mark failed');
      end
    `);
    expect(() => deliverAppUpdateNotices(db, "alice")).toThrow(/delivery mark failed/);
    expect(chatRepository(db).listConversations(scope, bot.id)).toEqual([]);
    db.$client.exec("drop trigger fail_notice_mark");
    const conversationId = deliverAppUpdateNotices(db, "alice");
    expect(conversationId).toBeTruthy();
    const copies = (chatRepository(db).listMessages(scope, conversationId!) ?? []).filter((row) => row.contentJson.includes(note));
    expect(copies).toHaveLength(1);
    const mark = db.$client.prepare("select delivered_message_id as deliveredMessageId, delivered_at as deliveredAt from system_notices where user_id='alice'").get() as {
      deliveredMessageId: string | null;
      deliveredAt: string | null;
    };
    expect(mark.deliveredMessageId).toBe(copies[0]?.id);
    expect(mark.deliveredAt).toBeTruthy();
  });

  it("upgrades an installed catalog version in place only after approval", async () => {
    const { db, deps } = boot();
    const old = publish(deps, "1.0.0");
    const next = publish(deps, "2.0.0");
    setVisibility(deps, adminScope("admin"), old.appId, { scope: "all" });
    await installForUser(deps, "alice", "pager", { version: "1.0.0" });
    const installed = listUserInstalls(deps, "alice").find((item) => item.name === "pager")!;
    const args = { catalog: { name: "pager", version: "2.0.0" }, reason: "按通知升级" };
    expect(installMcpBlock(deps, "alice", args)).toBeUndefined();
    expect(installMcpBlock(deps, "alice", { catalog: { name: "pager", version: "1.0.0" }, reason: "重复" })).toContain("已安装");
    db.$client.prepare("insert into bots (id, user_id, name, model, created_at, updated_at) values ('bot-alice', 'alice', 'Ada', 'm', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')").run();
    db.$client.prepare("insert into tasks (id, bot_id, state, trigger, step_count) values ('task-up', 'bot-alice', 'running', 'user', 0)").run();
    const gate = createApprovalGate({ db, waitMs: 5000 });
    const waiting = gate.bind("task-up").beforeToolCall!({
      toolCall: { name: "install_mcp" },
      args,
    } as BeforeToolCallContext);
    await Promise.resolve();
    const pending = db.$client.prepare("select id, tool from approvals where state='pending'").get();
    if (!pending || typeof pending !== "object" || !("id" in pending) || typeof pending.id !== "string" || !("tool" in pending) || typeof pending.tool !== "string") {
      throw new Error("pending approval missing");
    }
    expect(pending.tool).toBe("install_mcp");
    gate.decide("alice", pending.id, "allow");
    expect(await waiting).toBeUndefined();
    const tool = installMcpTool({
      userId: "alice",
      botId: "bot-alice",
      botName: "Ada",
      taskId: "task-up",
      catalog: deps,
      lookup: () => undefined,
      readFile: async () => undefined,
      launch: async () => ["pager_status"],
    });
    const result = await tool.execute("call-up", args);
    expect(result.isError).toBeUndefined();
    const after = listUserInstalls(deps, "alice").find((item) => item.name === "pager")!;
    expect(after.id).toBe(installed.id);
    expect(after.versionId).toBe(next.versionId);
    expect(after.version).toBe("2.0.0");
    expect(listUserInstalls(deps, "alice").filter((item) => item.name === "pager")).toHaveLength(1);
  });

  it("tells the bot that a notice is not user authorization", () => {
    const prompt = buildSystemPrompt("平台", "指令", "", "");
    expect(prompt).toContain(NOTICE_GUIDANCE);
    expect(NOTICE_GUIDANCE).toContain("install_mcp");
    expect(NOTICE_GUIDANCE).toContain("用户批准");
    expect(NOTICE_GUIDANCE).toContain("不构成用户授权");
  });
});

function awaitNotice(noticeId: string, payload: { appId: string; appName: string; currentVersion: string; targetVersion: string; targetVersionId: string; note: string; markedAt: string }): string {
  const text = [
    NOTICE_PREFIX,
    `应用：${payload.appName}`,
    `版本：${payload.currentVersion} → ${payload.targetVersion}`,
    `说明：${payload.note}`,
  ].join("\n");
  return JSON.stringify({
    pi: { role: "user", content: text, timestamp: 1 },
    text,
    notice: { kind: "app_update", noticeId },
  });
}
