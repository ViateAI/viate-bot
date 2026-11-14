import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Provider from "oidc-provider";
import type { FastifyInstance } from "fastify";
import { buildApp, type ControlContext } from "./app.js";
import { loadConfig } from "./config.js";
import { encrypt, loadOrCreateKey } from "./crypto.js";
import { identityRepository } from "./db/identities.js";
import { openDatabase } from "./db/index.js";
import { sessionRepository } from "./db/sessions.js";
import { userRepository } from "./db/users.js";
import type { DockerDriver } from "./machines/docker.js";
import { hashToken } from "./session.js";

interface Account {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

const account: Account = { sub: "sub-1", email: "ada@example.com", emailVerified: true, name: "Ada" };
let tamper: "aud" | "nonce" | null = null;
let refreshCalls = 0;
let minimalIdToken = false;
let refreshFault: { status: number; error: string } | null = null;
let userInfoShape: "full" | "name" | "email" | "explicit-false" = "full";
const disconnected: string[] = [];
let issuer: string;
let base: string;
let ctx: ControlContext;
let app: FastifyInstance;
let idp: Server;
let dataDir: string;

const fetching: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (isRefreshGrant(url, init?.body)) {
    refreshCalls += 1;
    if (refreshFault) {
      return new Response(JSON.stringify({ error: refreshFault.error, error_description: "injected" }), {
        status: refreshFault.status,
        headers: { "content-type": "application/json" },
      });
    }
  }
  const response = await fetch(input, init);
  if (!tamper || !new URL(url).pathname.endsWith("/token")) return response;
  const body = (await response.clone().json()) as { id_token?: string };
  if (!body.id_token) return response;
  const [header, payload, signature] = body.id_token.split(".");
  if (!header || !payload || !signature) return response;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { aud?: string; nonce?: string };
  if (tamper === "aud") claims.aud = "other-client";
  if (tamper === "nonce") claims.nonce = "not-the-nonce";
  body.id_token = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

beforeAll(async () => {
  const idpPort = await freePort();
  const controlPort = await freePort();
  issuer = `http://127.0.0.1:${idpPort}`;
  base = `http://127.0.0.1:${controlPort}`;
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: "bot",
        client_secret: "secret",
        redirect_uris: [`${base}/auth/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      },
    ],
    cookies: { keys: ["test-cookie-secret"] },
    claims: {
      openid: ["sub"],
      email: ["email", "email_verified"],
      profile: ["name"],
    },
    issueRefreshToken: async () => true,
    rotateRefreshToken: true,
    features: { devInteractions: { enabled: false } },
    interactions: { url: () => "/test/complete" },
    async findAccount(_ctx: unknown, id: string) {
      if (id !== account.sub) return undefined;
      const current = { ...account };
      return {
        accountId: id,
        async claims(use: string) {
          if (use === "id_token" && minimalIdToken) return { sub: current.sub };
          if (use === "userinfo" && userInfoShape === "name") return { sub: current.sub, name: current.name };
          if (use === "userinfo" && userInfoShape === "email") {
            return { sub: current.sub, email: current.email, name: current.name };
          }
          if (use === "userinfo" && userInfoShape === "explicit-false") {
            return { sub: current.sub, email: current.email, email_verified: false, name: current.name };
          }
          return {
            sub: current.sub,
            email: current.email,
            email_verified: current.emailVerified,
            name: current.name,
          };
        },
      };
    },
  });
  provider.use(async (context, next) => {
    if (context.path !== "/test/complete") {
      await next();
      return;
    }
    const details = await provider.interactionDetails(context.req, context.res);
    const clientId = details.params.client_id ?? "";
    const scope = details.params.scope ?? "openid email profile";
    const grant = new provider.Grant({ accountId: account.sub, clientId });
    grant.addOIDCScope(scope);
    const grantId = await grant.save();
    await provider.interactionFinished(context.req, context.res, {
      login: { accountId: account.sub },
      consent: { grantId },
    });
  });
  idp = provider.listen(idpPort, "127.0.0.1");
  if (!idp.listening) await once(idp, "listening");

  dataDir = mkdtempSync(join(tmpdir(), "vb-auth-"));
  const config = loadConfig({
    VB_DATA_DIR: dataDir,
    VB_PUBLIC_URL: base,
    VB_OIDC_ISSUER: issuer,
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
    VB_ALLOW_SIGNUP: "true",
  });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  ctx = { db, driver: {} as DockerDriver, config, key: loadOrCreateKey(config.secretKeyPath) };
  app = buildApp(ctx, {
    fetch: fetching,
    onDisconnect: (userId) => disconnected.push(userId),
  });
  app.get("/api/__probe", async () => ({ ok: true }));
  await app.listen({ host: "127.0.0.1", port: controlPort });
});

afterAll(async () => {
  await app?.close();
  ctx?.db.$client.close();
  if (idp) await new Promise<void>((resolve) => idp.close(() => resolve()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  tamper = null;
  refreshCalls = 0;
  minimalIdToken = false;
  refreshFault = null;
  userInfoShape = "full";
  disconnected.length = 0;
  account.sub = "sub-1";
  account.email = "ada@example.com";
  account.emailVerified = true;
  account.name = "Ada";
  ctx.config.allowSignup = true;
  ctx.config.oidcTrustEmail = false;
  ctx.config.adminEmails = [];
  ctx.db.$client.exec("delete from sessions; delete from identities; delete from users;");
});

describe("OIDC login", () => {
  it("rejects an open redirect before contacting the provider", async () => {
    const response = await fetch(`${base}/auth/login?return_to=${encodeURIComponent("https://evil.example")}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    const protocolRelative = await fetch(`${base}/auth/login?return_to=${encodeURIComponent("//evil.example")}`, {
      redirect: "manual",
    });
    expect(protocolRelative.status).toBe(400);
    for (const returnTo of ["/.//evil.example", "/%2e//evil.example", "/foo/..//evil.example"]) {
      const normalized = await fetch(`${base}/auth/login?return_to=${encodeURIComponent(returnTo)}`, {
        redirect: "manual",
      });
      expect(normalized.status).toBe(400);
    }
  });

  it("logs in, sets a loopback session cookie, and reports the user", async () => {
    ctx.config.adminEmails = ["ada@example.com"];
    const result = await signIn("/home");
    expect(result.sessionHeader).toContain("HttpOnly");
    expect(result.sessionHeader).toContain("SameSite=Lax");
    expect(result.sessionHeader).not.toContain("Secure");
    const me = await currentUser(result.jar);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { id: string; email: string; name: string; isAdmin: boolean };
    expect(body).toMatchObject({ email: "ada@example.com", name: "Ada", isAdmin: true });
    expect(textField(body, "csrf").length).toBeGreaterThan(0);
    const stored = sessionRepository(ctx.db).findByTokenHash(hashToken(result.jar.get("vb_session") ?? ""));
    expect(stored?.tokenHash).not.toBe(result.jar.get("vb_session"));
    account.name = "Augusta";
    ctx.config.adminEmails = [];
    const again = await signIn("/home");
    const updated = (await (await currentUser(again.jar)).json()) as { id: string; name: string; isAdmin: boolean };
    expect(updated.id).toBe(body.id);
    expect(updated.name).toBe("Augusta");
    expect(updated.isAdmin).toBe(false);
  });

  it("rejects a bad state, nonce, or audience and does not create a session", async () => {
    const state = await signIn("/home", (url) => {
      const parsed = new URL(url);
      if (parsed.pathname !== "/auth/callback") return url;
      parsed.searchParams.set("state", "tampered");
      return parsed.toString();
    });
    expect(state.status).toBe(400);
    expect(state.jar.has("vb_session")).toBe(false);

    tamper = "nonce";
    const nonce = await signIn("/home");
    expect(nonce.status).toBe(400);
    expect(sessionRepository(ctx.db).listByUser("anything")).toEqual([]);
    expect(ctx.db.$client.prepare("select count(*) as count from sessions").get()).toEqual({ count: 0 });

    tamper = "aud";
    const audience = await signIn("/home");
    expect(audience.status).toBe(400);
    expect(ctx.db.$client.prepare("select count(*) as count from users").get()).toEqual({ count: 0 });
  });

  it("binds a trusted email, refuses an untrusted one, and honors signup and local disable", async () => {
    ctx.config.allowSignup = false;
    userRepository(ctx.db).insert({
      id: "pre-1",
      email: "ada@example.com",
      name: "Pre",
      status: "active",
      isAdmin: false,
    });
    const bound = await signIn("/home");
    const me = (await (await currentUser(bound.jar)).json()) as { id: string };
    expect(me.id).toBe("pre-1");
    expect(identityRepository(ctx.db).find("oidc", "sub-1")?.userId).toBe("pre-1");

    ctx.db.$client.exec("delete from sessions; delete from identities;");
    account.emailVerified = false;
    const untrusted = await signIn("/home");
    expect(untrusted.status).toBe(403);
    expect(identityRepository(ctx.db).find("oidc", "sub-1")).toBeUndefined();

    ctx.config.oidcTrustEmail = true;
    const trusted = await signIn("/home");
    expect((await (await currentUser(trusted.jar)).json()) as { id: string }).toMatchObject({ id: "pre-1" });

    ctx.db.$client.exec("delete from sessions; delete from identities; delete from users;");
    ctx.config.oidcTrustEmail = false;
    ctx.config.allowSignup = false;
    account.emailVerified = true;
    const closed = await signIn("/home");
    expect(closed.status).toBe(403);
    expect(closed.body).toContain("不允许注册");

    ctx.config.allowSignup = true;
    const created = await signIn("/home");
    const createdBody = (await (await currentUser(created.jar)).json()) as { id: string };
    expect(createdBody.id).not.toBe("");
    userRepository(ctx.db).setStatus(createdBody.id, "disabled");
    ctx.db.$client.exec("delete from sessions;");
    const disabled = await signIn("/home");
    expect(disabled.status).toBe(403);
    expect(disabled.body).toContain("用户已禁用");

    ctx.db.$client.exec("delete from sessions; delete from identities; delete from users;");
    userRepository(ctx.db).insert({
      id: "pre-off",
      email: "ada@example.com",
      name: "Off",
      status: "disabled",
      isAdmin: false,
    });
    ctx.config.allowSignup = false;
    const preDisabled = await signIn("/home");
    expect(preDisabled.status).toBe(403);
    expect(identityRepository(ctx.db).find("oidc", "sub-1")).toBeUndefined();
  });

  it("requires CSRF on logout and drops the session when refresh fails", async () => {
    const result = await signIn("/home");
    const token = result.jar.get("vb_session") ?? "";
    const without = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: cookieHeader(result.jar) } });
    expect(without.status).toBe(403);
    expect(sessionRepository(ctx.db).findByTokenHash(hashToken(token))).toBeDefined();

    const profile: unknown = await (await currentUser(result.jar)).json();
    const loggedOut = await fetch(`${base}/auth/logout`, {
      method: "POST",
      headers: { cookie: cookieHeader(result.jar), "x-vb-csrf": textField(profile, "csrf") },
    });
    expect(loggedOut.status).toBe(200);
    expect(sessionRepository(ctx.db).findByTokenHash(hashToken(token))).toBeUndefined();

    const again = await signIn("/home");
    const sessionToken = again.jar.get("vb_session") ?? "";
    const session = sessionRepository(ctx.db).findByTokenHash(hashToken(sessionToken));
    expect(session).toBeDefined();
    sessionRepository(ctx.db).replaceRefreshToken(session!.id, encrypt(ctx.key, "bogus-refresh-token"));
    const still = await currentUser(again.jar);
    expect(still.status).toBe(200);
    sessionRepository(ctx.db).setLastValidatedAt(session!.id, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const expired = await currentUser(again.jar);
    expect(expired.status).toBe(401);
    expect(sessionRepository(ctx.db).findByTokenHash(hashToken(sessionToken))).toBeUndefined();
    expect(disconnected).toContain(session!.userId);
  });

  it("keeps admin when a refresh id token omits claims that userinfo still has", async () => {
    ctx.config.adminEmails = ["ada@example.com"];
    minimalIdToken = true;
    const result = await signIn("/home");
    const me = (await (await currentUser(result.jar)).json()) as { name: string; isAdmin: boolean };
    expect(me).toMatchObject({ name: "Ada", isAdmin: true });
    const token = result.jar.get("vb_session") ?? "";
    const session = sessionRepository(ctx.db).findByTokenHash(hashToken(token));
    expect(session).toBeDefined();
    account.name = "Augusta";
    sessionRepository(ctx.db).setLastValidatedAt(session!.id, new Date(Date.now() - 6 * 60 * 1000).toISOString());
    const refreshed = await currentUser(result.jar);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ name: "Augusta", isAdmin: true, email: "ada@example.com" });
    expect(identityRepository(ctx.db).find("oidc", "sub-1")?.email).toBe("ada@example.com");
  });

  it("does not clear admin when userinfo omits email or email_verified", async () => {
    ctx.config.adminEmails = ["ada@example.com"];
    minimalIdToken = true;
    const result = await signIn("/home");
    const token = result.jar.get("vb_session") ?? "";
    expect(await (await currentUser(result.jar)).json()).toMatchObject({
      name: "Ada",
      email: "ada@example.com",
      isAdmin: true,
    });
    account.name = "Augusta";

    const named = await refreshAfter(result.jar, token, "name");
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ name: "Ada", email: "ada@example.com", isAdmin: true });
    expect(identityRepository(ctx.db).find("oidc", "sub-1")).toMatchObject({
      email: "ada@example.com",
      emailVerified: true,
    });

    const mailed = await refreshAfter(result.jar, token, "email");
    expect(mailed.status).toBe(200);
    expect(await mailed.json()).toMatchObject({ name: "Ada", email: "ada@example.com", isAdmin: true });
    expect(identityRepository(ctx.db).find("oidc", "sub-1")?.emailVerified).toBe(true);

    const explicit = await refreshAfter(result.jar, token, "explicit-false");
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject({ name: "Augusta", email: "ada@example.com", isAdmin: false });
    expect(identityRepository(ctx.db).find("oidc", "sub-1")?.emailVerified).toBe(false);
  });

  it("keeps the session unless the provider says the refresh token is invalid", async () => {
    const result = await signIn("/home");
    const token = result.jar.get("vb_session") ?? "";
    const session = sessionRepository(ctx.db).findByTokenHash(hashToken(token));
    expect(session).toBeDefined();
    sessionRepository(ctx.db).setLastValidatedAt(session!.id, new Date(Date.now() - 6 * 60 * 1000).toISOString());
    refreshFault = { status: 400, error: "temporarily_unavailable" };
    const unavailable = await currentUser(result.jar);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "暂时无法确认登录状态" });
    expect(sessionRepository(ctx.db).findByTokenHash(hashToken(token))).toBeDefined();
    expect(disconnected).toEqual([]);

    refreshFault = { status: 400, error: "invalid_grant" };
    const revoked = await currentUser(result.jar);
    expect(revoked.status).toBe(401);
    expect(sessionRepository(ctx.db).findByTokenHash(hashToken(token))).toBeUndefined();
    expect(disconnected).toContain(session!.userId);
  });

  it("requires a session for GET /api routes", async () => {
    const probe = await fetch(`${base}/api/__probe`);
    expect(probe.status).toBe(401);
    expect(await probe.json()).toEqual({ error: "未登录" });
    const encoded = await fetch(`${base}/%61pi/__probe`);
    expect(encoded.status).toBe(401);
  });

  it("refreshes a shared session once when five requests cross the window together", async () => {
    const result = await signIn("/home");
    const token = result.jar.get("vb_session") ?? "";
    const session = sessionRepository(ctx.db).findByTokenHash(hashToken(token));
    expect(session).toBeDefined();
    if (!session) return;
    sessionRepository(ctx.db).setLastValidatedAt(session.id, new Date(Date.now() - 6 * 60 * 1000).toISOString());
    refreshCalls = 0;
    const responses = await Promise.all(Array.from({ length: 5 }, () => currentUser(result.jar)));
    const bodies: unknown[] = [];
    for (const response of responses) {
      expect(response.status).toBe(200);
      bodies.push(await response.json());
    }
    for (const body of bodies) expect(textField(body, "email")).toBe("ada@example.com");
    expect(refreshCalls).toBe(1);
    expect(sessionRepository(ctx.db).findByTokenHash(hashToken(token))).toBeDefined();
    sessionRepository(ctx.db).setLastValidatedAt(session.id, new Date(Date.now() - 6 * 60 * 1000).toISOString());
    const again = await currentUser(result.jar);
    expect(again.status).toBe(200);
    expect(refreshCalls).toBe(2);
    expect(sessionRepository(ctx.db).findByTokenHash(hashToken(token))).toBeDefined();
  });
});

async function signIn(returnTo: string, rewrite?: (url: string) => string): Promise<{ status: number; body: string; jar: Map<string, string>; sessionHeader?: string }> {
  const jar = new Map<string, string>();
  let url = `${base}/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  let sessionHeader: string | undefined;
  for (let hop = 0; hop < 12; hop += 1) {
    if (rewrite) url = rewrite(url);
    const response = await fetch(url, { redirect: "manual", headers: { cookie: cookieHeader(jar) } });
    const cookies = response.headers.getSetCookie();
    for (const cookie of cookies) {
      if (cookie.startsWith("vb_session=")) sessionHeader = cookie;
      remember(jar, cookie);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("重定向缺少 location");
      url = new URL(location, url).toString();
      continue;
    }
    return { status: response.status, body: await response.text(), jar, ...(sessionHeader ? { sessionHeader } : {}) };
  }
  throw new Error("重定向次数过多");
}

function remember(jar: Map<string, string>, cookie: string): void {
  const [pair] = cookie.split(";");
  if (!pair) return;
  const eq = pair.indexOf("=");
  const name = pair.slice(0, eq).trim();
  const value = decodeURIComponent(pair.slice(eq + 1));
  const maxAge = cookie.split(";").find((part) => part.trim().toLowerCase().startsWith("max-age="));
  if (maxAge && Number(maxAge.split("=")[1]) <= 0) jar.delete(name);
  else jar.set(name, value);
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

function currentUser(jar: Map<string, string>): Promise<Response> {
  return fetch(`${base}/api/me`, { headers: { cookie: cookieHeader(jar) } });
}

async function refreshAfter(
  jar: Map<string, string>,
  token: string,
  shape: "name" | "email" | "explicit-false",
): Promise<Response> {
  userInfoShape = shape;
  const session = sessionRepository(ctx.db).findByTokenHash(hashToken(token));
  if (!session) throw new Error("刷新前没有会话");
  const previous = session.refreshTokenEnc;
  sessionRepository(ctx.db).setLastValidatedAt(session.id, new Date(Date.now() - 6 * 60 * 1000).toISOString());
  const response = await currentUser(jar);
  const next = sessionRepository(ctx.db).findByTokenHash(hashToken(token));
  if (!next || next.refreshTokenEnc === previous) throw new Error("轮换后的 refresh token 没有保存");
  return response;
}

function textField(body: unknown, key: string): string {
  if (!isRecord(body) || !(key in body)) throw new Error(`响应没有 ${key}`);
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`响应没有 ${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRefreshGrant(url: string, body: unknown): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!parsed.pathname.endsWith("/token")) return false;
  return grantBody(body).includes("grant_type=refresh_token");
}

function grantBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return "";
}
