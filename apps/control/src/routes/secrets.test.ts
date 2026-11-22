import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asc } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { createSecretBroker } from "../agent/secrets.js";
import { buildApp, type ControlContext } from "../app.js";
import {
  catalogSecretName,
  installForUser,
  publishCatalogVersion,
  resolveMcpLaunch,
  setVisibility,
  type CatalogDeps,
} from "../apps/catalog.js";
import { loadConfig } from "../config.js";
import { SESSION_COOKIE } from "../cookies.js";
import { decrypt, encrypt, loadOrCreateKey } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { machineRepository } from "../db/machines.js";
import { auditLog, secrets } from "../db/schema.js";
import { secretRepository } from "../db/secrets.js";
import { ensureDevUser } from "../db/users.js";
import { adminScope, userScope } from "../scope.js";
import { createSession } from "../session.js";

const PLAIN = "vault-plain-9f3a";
const NEXT = "vault-next-9f3b";
const PRIVATE = "app-private-9f3c";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function auth(session: { token: string; csrf: string }, write = true): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${session.token}`,
    ...(write ? { "x-vb-csrf": session.csrf } : {}),
  };
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-user-secrets-"));
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "model-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
  });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const ctx: ControlContext = { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
  ensureDevUser(ctx.db, "user-a");
  ensureDevUser(ctx.db, "user-b");
  const calls = { install: 0, uninstall: 0 };
  const deps: CatalogDeps = {
    db: ctx.db,
    key: ctx.key,
    dataDir: dir,
    installer: {
      async install() {
        calls.install += 1;
      },
      async uninstall() {
        calls.uninstall += 1;
      },
    },
  };
  const app = buildApp(ctx, {
    ensureMachine: async () => {},
    prepareEndpoint: async () => ({ host: "127.0.0.1", port: 9, token: "machine" }),
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    ctx.db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const now = new Date();
  return {
    app,
    ctx,
    deps,
    calls,
    alice: createSession(ctx.db, ctx.key, "user-a", "refresh-a", now),
    bob: createSession(ctx.db, ctx.key, "user-b", "refresh-b", now),
  };
}

function savedAudits(ctx: ControlContext) {
  return ctx.db
    .select()
    .from(auditLog)
    .orderBy(asc(auditLog.ts), asc(auditLog.id))
    .all()
    .filter((row) => row.action === "secret.saved" || row.action === "secret.deleted")
    .map((row) => ({ action: row.action, target: row.target, attrs: JSON.parse(row.attrsJson) as unknown }));
}

async function installRelay(ctx: ControlContext, deps: CatalogDeps) {
  const published = publishCatalogVersion(deps, adminScope("admin"), {
    name: "relay",
    version: "1.0.0",
    manifestJson: JSON.stringify({
      config: [
        { key: "MCP_TOKEN", secret: true, env: "MCP_TOKEN" },
        { key: "API_KEY", secret: true, env: "API_KEY" },
      ],
    }),
    archivePath: "apps/relay/1.0.0.tar.zst",
    sha256: "ab".repeat(32),
  });
  setVisibility(deps, adminScope("admin"), published.appId, { scope: "all" });
  machineRepository(ctx.db).insert(userScope("user-a"), {
    id: "machine-user-a",
    userId: "user-a",
    state: "running",
    containerId: "c",
    networkId: "n",
    volumeName: "vol-user-a",
    imageVersion: "dev",
    spec: { cpu: 1, memMb: 512, diskGb: 10 },
    tokenEnc: "enc",
  });
  return installForUser(deps, "user-a", "relay", {
    config: {
      MCP_TOKEN: PRIVATE,
      API_KEY: { secret: true, secretRef: "corp_token" },
    },
  });
}

describe("user secret http", () => {
  it("rejects anonymous calls and writes without csrf", async () => {
    const { app, alice } = await boot();
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: method === "GET" ? "/api/secrets" : "/api/secrets/corp_token",
        ...(method === "PUT" ? { payload: { value: PLAIN } } : {}),
      });
      expect(response.statusCode, method).toBe(401);
      expect(response.json()).toEqual({ error: "未登录" });
      expect(JSON.stringify(response.json())).not.toContain(PLAIN);
    }
    const put = await app.inject({
      method: "PUT",
      url: "/api/secrets/corp_token",
      headers: auth(alice, false),
      payload: { value: PLAIN },
    });
    const del = await app.inject({
      method: "DELETE",
      url: "/api/secrets/corp_token",
      headers: auth(alice, false),
    });
    expect(put.statusCode).toBe(403);
    expect(del.statusCode).toBe(403);
    expect(put.json()).toEqual({ error: "缺少 CSRF" });
    const read = await app.inject({ method: "GET", url: "/api/secrets", headers: auth(alice, false) });
    expect(read.statusCode).toBe(200);
  });

  it("rejects illegal names and values", async () => {
    const { app, alice, ctx } = await boot();
    ctx.db.insert(secrets).values({
      id: "scoped-app",
      userId: "user-a",
      name: "plain_app_scope",
      valueEnc: encrypt(ctx.key, PRIVATE),
      scope: "app",
      createdAt: "2020-01-01T00:00:00.000Z",
    }).run();
    const cases: Array<{ url: string; payload: { value?: string | number }; error: string }> = [
      { url: "/api/secrets", payload: { value: PLAIN }, error: "密钥名不合法" },
      { url: "/api/secrets/BadName", payload: { value: PLAIN }, error: "密钥名不合法" },
      { url: "/api/secrets/bad-name", payload: { value: PLAIN }, error: "密钥名不合法" },
      { url: `/api/secrets/${encodeURIComponent("app:foo")}`, payload: { value: PLAIN }, error: "密钥名不合法" },
      { url: `/api/secrets/${"a".repeat(65)}`, payload: { value: PLAIN }, error: "密钥名不合法" },
      { url: "/api/secrets/corp_token", payload: { value: "" }, error: "密钥内容不能为空" },
      { url: "/api/secrets/corp_token", payload: { value: 1 }, error: "密钥内容不合法" },
      { url: "/api/secrets/corp_token", payload: {}, error: "密钥内容不合法" },
      { url: "/api/secrets/corp_token", payload: { value: `LEAK${"x".repeat(4096)}` }, error: "密钥不能超过 4096 个字符" },
      { url: "/api/secrets/plain_app_scope", payload: { value: NEXT }, error: "不能覆盖应用独立密钥" },
    ];
    for (const item of cases) {
      const response = await app.inject({
        method: "PUT",
        url: item.url,
        headers: auth(alice),
        payload: item.payload,
      });
      expect(response.statusCode, item.url).toBe(400);
      expect(response.json(), item.url).toEqual({ error: item.error });
      expect(JSON.stringify(response.json()), item.url).not.toContain("LEAK");
      expect(JSON.stringify(response.json()), item.url).not.toContain(PLAIN);
      expect(JSON.stringify(response.json()), item.url).not.toContain(NEXT);
    }
    const blank = await app.inject({
      method: "PUT",
      url: "/api/secrets/blank_ok",
      headers: auth(alice),
      payload: { value: " " },
    });
    expect(blank.statusCode).toBe(201);
    expect(decrypt(ctx.key, secretRepository(ctx.db).find(userScope("user-a"), "blank_ok")?.valueEnc ?? "")).toBe(" ");
    const exact = await app.inject({
      method: "PUT",
      url: "/api/secrets/exact_len",
      headers: auth(alice),
      payload: { value: "b".repeat(4096) },
    });
    expect(exact.statusCode).toBe(201);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/secrets/${encodeURIComponent("app:foo")}`,
      headers: auth(alice),
    });
    expect(removed.statusCode).toBe(400);
    expect(removed.json()).toEqual({ error: "密钥名不合法" });
    const kept = secretRepository(ctx.db).find(userScope("user-a"), "plain_app_scope");
    expect(decrypt(ctx.key, kept?.valueEnc ?? "")).toBe(PRIVATE);
    const audits = savedAudits(ctx);
    expect(audits).toEqual([
      { action: "secret.saved", target: "blank_ok", attrs: { name: "blank_ok", length: 1, created: true } },
      { action: "secret.saved", target: "exact_len", attrs: { name: "exact_len", length: 4096, created: true } },
    ]);
    expect(JSON.stringify(audits)).not.toContain(PLAIN);
    expect(JSON.stringify(audits)).not.toContain(NEXT);
    expect(JSON.stringify(audits)).not.toContain(PRIVATE);
    expect(JSON.stringify(audits)).not.toContain("LEAK");
  });

  it("lists only the caller's user-level metadata", async () => {
    const { app, alice, bob, ctx } = await boot();
    const first = await app.inject({
      method: "PUT",
      url: "/api/secrets/zeta",
      headers: auth(alice),
      payload: { value: PLAIN },
    });
    const second = await app.inject({
      method: "PUT",
      url: "/api/secrets/alpha",
      headers: auth(alice),
      payload: { value: NEXT },
    });
    await app.inject({
      method: "PUT",
      url: "/api/secrets/alpha",
      headers: auth(bob),
      payload: { value: "bob-only-9f3d" },
    });
    ctx.db.insert(secrets).values([
      {
        id: "app-row",
        userId: "user-a",
        name: "app:install:TOKEN",
        valueEnc: encrypt(ctx.key, PRIVATE),
        scope: "app",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      {
        id: "legacy-row",
        userId: "user-a",
        name: "app:legacy",
        valueEnc: encrypt(ctx.key, "legacy-plain-9f3e"),
        scope: "browser",
        createdAt: "2020-01-02T00:00:00.000Z",
      },
    ]).run();
    const listed = await app.inject({ method: "GET", url: "/api/secrets", headers: auth(alice, false) });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      secrets: [
        { name: "alpha", updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
        { name: "zeta", updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      ],
    });
    const body = JSON.stringify(listed.json());
    expect(body).not.toContain(PLAIN);
    expect(body).not.toContain(NEXT);
    expect(body).not.toContain("valueEnc");
    expect(body).not.toContain("bob-only-9f3d");
    expect(body).not.toContain("app:");
    const bobList = await app.inject({ method: "GET", url: "/api/secrets", headers: auth(bob, false) });
    expect(bobList.json()).toEqual({
      secrets: [{ name: "alpha", updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) }],
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
  });

  it("creates and rotates a secret without leaking it or stopping an install", async () => {
    const { app, alice, ctx, deps, calls } = await boot();
    const created = await app.inject({
      method: "PUT",
      url: "/api/secrets/corp_token",
      headers: auth(alice),
      payload: { value: PLAIN },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      secret: { name: "corp_token", updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    });
    const installed = await installRelay(ctx, deps);
    expect(calls.install).toBe(1);
    expect(resolveMcpLaunch(deps, "user-a", "relay").env).toEqual({ MCP_TOKEN: PRIVATE, API_KEY: PLAIN });
    const rotated = await app.inject({
      method: "PUT",
      url: "/api/secrets/corp_token",
      headers: auth(alice),
      payload: { value: NEXT },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().secret.name).toBe("corp_token");
    expect(JSON.stringify(created.json())).not.toContain(PLAIN);
    expect(JSON.stringify(rotated.json())).not.toContain(NEXT);
    const row = secretRepository(ctx.db).find(userScope("user-a"), "corp_token");
    expect(row?.scope).toBe("browser");
    expect(row?.valueEnc).not.toContain(NEXT);
    expect(decrypt(ctx.key, row?.valueEnc ?? "")).toBe(NEXT);
    expect(secretRepository(ctx.db).list(userScope("user-a")).filter((item) => item.name === "corp_token")).toHaveLength(1);
    expect(resolveMcpLaunch(deps, "user-a", "relay").env).toEqual({ MCP_TOKEN: PRIVATE, API_KEY: NEXT });
    const broker = createSecretBroker({
      db: ctx.db,
      key: ctx.key,
      waitMs: 1000,
      now: () => new Date(),
      onWaiting() {},
      onRunning() {},
      onResume() {},
      onFail() {},
    });
    broker.remember("task-live", "corp_token", PLAIN);
    expect(broker.lookup("user-a", "task-live", "corp_token")).toBe(PLAIN);
    expect(broker.known("user-a", "task-next").find((item) => item.name === "corp_token")?.value).toBe(NEXT);
    broker.close();
    expect(calls.uninstall).toBe(0);
    expect(calls.install).toBe(1);
    const audits = savedAudits(ctx);
    expect(audits).toEqual([
      { action: "secret.saved", target: "corp_token", attrs: { name: "corp_token", length: PLAIN.length, created: true } },
      { action: "secret.saved", target: "corp_token", attrs: { name: "corp_token", length: NEXT.length, created: false } },
    ]);
    expect(JSON.stringify(audits)).not.toContain(PLAIN);
    expect(JSON.stringify(audits)).not.toContain(NEXT);
    expect(JSON.stringify(audits)).not.toContain(row?.valueEnc);
    expect(installed.config.API_KEY).toEqual({ secret: true, secretRef: "corp_token" });
  });

  it("deletes a referenced secret without removing the app secret", async () => {
    const { app, alice, bob, ctx, deps, calls } = await boot();
    const created = await app.inject({
      method: "PUT",
      url: "/api/secrets/corp_token",
      headers: auth(alice),
      payload: { value: PLAIN },
    });
    expect(created.statusCode).toBe(201);
    const installed = await installRelay(ctx, deps);
    const appName = catalogSecretName(installed.id, "MCP_TOKEN");
    ctx.db.insert(secrets).values({
      id: "prefixed",
      userId: "user-a",
      name: "app:install:TOKEN",
      valueEnc: encrypt(ctx.key, "prefixed-plain-9f3f"),
      scope: "app",
      createdAt: "2020-01-01T00:00:00.000Z",
    }).run();
    await app.inject({
      method: "PUT",
      url: "/api/secrets/bob_token",
      headers: auth(bob),
      payload: { value: "bob-only-9f3d" },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/secrets/corp_token",
      headers: auth(alice),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect(JSON.stringify(deleted.json())).not.toContain(PLAIN);
    expect(calls.uninstall).toBe(0);
    expect(decrypt(ctx.key, secretRepository(ctx.db).find(userScope("user-a"), appName)?.valueEnc ?? "")).toBe(PRIVATE);
    expect(() => resolveMcpLaunch(deps, "user-a", "relay")).toThrow(expect.objectContaining({
      statusCode: 400,
      message: "引用的密钥 corp_token 不存在，请先登录或保存该密钥",
    }));
    const again = await app.inject({
      method: "DELETE",
      url: "/api/secrets/corp_token",
      headers: auth(alice),
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "找不到密钥" });
    const foreign = await app.inject({
      method: "DELETE",
      url: "/api/secrets/bob_token",
      headers: auth(alice),
    });
    expect(foreign.statusCode).toBe(404);
    expect(decrypt(ctx.key, secretRepository(ctx.db).find(userScope("user-b"), "bob_token")?.valueEnc ?? "")).toBe("bob-only-9f3d");
    const prefixed = await app.inject({
      method: "DELETE",
      url: `/api/secrets/${encodeURIComponent("app:install:TOKEN")}`,
      headers: auth(alice),
    });
    expect(prefixed.statusCode).toBe(400);
    expect(prefixed.json()).toEqual({ error: "密钥名不合法" });
    expect(decrypt(ctx.key, secretRepository(ctx.db).find(userScope("user-a"), "app:install:TOKEN")?.valueEnc ?? "")).toBe("prefixed-plain-9f3f");
    const audits = savedAudits(ctx);
    expect(audits.filter((row) => row.action === "secret.deleted")).toEqual([
      { action: "secret.deleted", target: "corp_token", attrs: { name: "corp_token" } },
    ]);
    expect(JSON.stringify(audits)).not.toContain(PLAIN);
    expect(JSON.stringify(audits)).not.toContain(PRIVATE);
  });
});
