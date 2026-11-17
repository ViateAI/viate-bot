import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireOidc, type ControlConfig } from "./config.js";
import {
  OAUTH_COOKIE,
  OAUTH_MAX_AGE_SECONDS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  cookieSecure,
  csrfEqual,
  readCookie,
  safeReturnPath,
  serializeCookie,
} from "./cookies.js";
import { decrypt, encrypt } from "./crypto.js";
import type { AppDatabase } from "./db/index.js";
import { quotaRepository } from "./db/quotas.js";
import { sessionRepository } from "./db/sessions.js";
import { LoginRejected, acceptIdentity } from "./login.js";
import { newTransaction } from "./oidc.js";
import type { AppRuntime } from "./providers.js";
import { egressRepository } from "./db/egress.js";
import { userScope } from "./scope.js";
import {
  clearSessionCookie,
  createSession,
  hashToken,
  rememberSession,
  resolveSession,
  type ResolvedSession,
} from "./session.js";

export interface AuthDeps {
  db: AppDatabase;
  key: Buffer;
  config: ControlConfig;
  runtime: AppRuntime;
  now: () => Date;
}

export const authenticated = new WeakMap<FastifyRequest, ResolvedSession>();

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const secure = cookieSecure(deps.config.publicUrl);

  app.addHook("preHandler", async (request, reply) => {
    // 按匹配到的路由判断：原始 URL 里的 /%61pi/me 也会路由到 /api/me。
    const path = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
    if (path.startsWith("/api/") && deviceToken(deps.db, request.headers.authorization)) {
      return reply.code(401).send({ error: "未登录" });
    }
    if (authExempt(path) || !requiresSession(request.method, path)) return;
    const lookup = await resolveSession(
      deps.db,
      deps.key,
      deps.config,
      deps.runtime.identity,
      request.headers.cookie,
      deps.now(),
      deps.runtime.hooks.disconnectUser,
    );
    if (lookup.kind === "unavailable") {
      return reply.code(503).send({ error: "暂时无法确认登录状态" });
    }
    if (lookup.kind === "none") return reply.code(401).send({ error: "未登录" });
    const rawPath = request.url.split("?")[0] ?? "";
    if ((path.startsWith("/api/admin") || rawPath.toLowerCase().startsWith("/api/admin")) && !lookup.resolved.user.isAdmin) {
      return reply.code(404).send({ error: "找不到" });
    }
    if (mutating(request.method)) {
      const header = request.headers["x-vb-csrf"];
      const csrf = Array.isArray(header) ? header[0] : header;
      if (!csrfEqual(lookup.resolved.session.csrf, csrf)) {
        return reply.code(403).send({ error: "缺少 CSRF" });
      }
    }
    authenticated.set(request, lookup.resolved);
    rememberSession(reply, deps.config.publicUrl, lookup.resolved.token);
  });

  app.get<{ Querystring: { return_to?: string } }>("/auth/login", async (request, reply) => {
    let returnTo: string;
    try {
      returnTo = safeReturnPath(request.query.return_to);
      requireOidc(deps.config);
    } catch (error) {
      const rejected = error instanceof LoginRejected ? error : error instanceof Error ? new LoginRejected(error.message, 400) : null;
      if (!rejected) throw error;
      return reply.code(rejected.statusCode).send({ error: rejected.message });
    }
    const identity = deps.runtime.identity;
    const transaction = await newTransaction();
    const redirectUri = callbackUrl(deps.config.publicUrl);
    const authorize = await identity.authorizeUrl(transaction, redirectUri);
    reply.header(
      "set-cookie",
      serializeCookie(OAUTH_COOKIE, encrypt(deps.key, JSON.stringify({ ...transaction, returnTo })), {
        maxAge: OAUTH_MAX_AGE_SECONDS,
        path: "/auth",
        secure,
      }),
    );
    return reply.code(302).header("location", authorize.toString()).send();
  });

  app.get("/auth/callback", async (request, reply) => {
    const encoded = readCookie(request.headers.cookie, OAUTH_COOKIE);
    if (!encoded) return reply.code(400).send({ error: "登录状态无效" });
    let transaction: { state: string; nonce: string; codeVerifier: string; codeChallenge: string; returnTo: string };
    try {
      transaction = JSON.parse(decrypt(deps.key, encoded)) as typeof transaction;
    } catch {
      return reply.code(400).send({ error: "登录状态无效" });
    }
    const currentUrl = new URL(request.url, deps.config.publicUrl);
    try {
      const identity = deps.runtime.identity;
      const result = await identity.handleCallback(currentUrl, transaction);
      const user = acceptIdentity(deps.db, deps.config, identity.id, result.identity);
      const session = createSession(deps.db, deps.key, user.id, result.refreshToken, deps.now());
      reply.header("set-cookie", [
        serializeCookie(SESSION_COOKIE, session.token, {
          maxAge: SESSION_MAX_AGE_SECONDS,
          path: "/",
          secure,
        }),
        serializeCookie(OAUTH_COOKIE, "", { maxAge: 0, path: "/auth", secure }),
      ]);
      return reply.code(302).header("location", transaction.returnTo || "/").send();
    } catch (error) {
      if (error instanceof LoginRejected) return reply.code(error.statusCode).send({ error: error.message });
      request.log.warn({ err: error }, "登录回调被拒绝");
      return reply.code(400).send({ error: "登录失败" });
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const resolved = authenticated.get(request);
    if (!resolved) return reply.code(401).send({ error: "未登录" });
    sessionRepository(deps.db).delete(resolved.session.id);
    deps.runtime.hooks.disconnectUser(resolved.user.id);
    reply.header("set-cookie", clearSessionCookie(deps.config.publicUrl));
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const resolved = authenticated.get(request);
    if (!resolved) return reply.code(401).send({ error: "未登录" });
    const user = resolved.user;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      isAdmin: user.isAdmin,
      provisioned: quotaRepository(deps.db).find(userScope(user.id)) !== undefined,
      csrf: resolved.session.csrf,
      desktopDownloadUrl: deps.config.desktopDownloadUrl || null,
    };
  });
}

function authExempt(path: string): boolean {
  return path === "/auth/login" || path === "/auth/callback" || path === "/health" || path.startsWith("/dev/") || path === "/client/token";
}

/** 设备令牌只能连 /client/egress。拿到 /api 一律 401，即使同时还带着会话。 */
function deviceToken(db: AuthDeps["db"], header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith("Bearer ")) return false;
  const token = value.slice("Bearer ".length);
  if (!token) return false;
  return egressRepository(db).findActiveByTokenHash(hashToken(token)) !== undefined;
}

function mutating(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function requiresSession(method: string, path: string): boolean {
  if (path.startsWith("/api/") || path === "/auth/logout") return true;
  return mutating(method);
}

function callbackUrl(publicUrl: string): string {
  return new URL("/auth/callback", publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`).toString();
}
