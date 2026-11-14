import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { decrypt, encrypt } from "./crypto.js";
import type { AppDatabase } from "./db/index.js";
import { sessionRepository, type SessionRecord } from "./db/sessions.js";
import { userRepository, type UserRecord } from "./db/users.js";
import { ulid } from "./id.js";
import { acceptIdentity } from "./login.js";
import type { ControlConfig } from "./config.js";
import {
  REFRESH_WINDOW_MS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  SESSION_TTL_MS,
  cookieSecure,
  readCookie,
  serializeCookie,
} from "./cookies.js";
import type { ExternalIdentity, IdentityProvider } from "./providers.js";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(
  db: AppDatabase,
  key: Buffer,
  userId: string,
  refreshToken: string,
  now: Date,
): { token: string; csrf: string } {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const iso = now.toISOString();
  sessionRepository(db).insert({
    id: ulid(now.getTime()),
    userId,
    tokenHash: hashToken(token),
    csrf,
    refreshTokenEnc: encrypt(key, refreshToken),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    lastSeenAt: iso,
    lastValidatedAt: iso,
  });
  return { token, csrf };
}

export function sessionCookie(publicUrl: string, token: string): string {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
    secure: cookieSecure(publicUrl),
  });
}

export function clearSessionCookie(publicUrl: string): string {
  return serializeCookie(SESSION_COOKIE, "", {
    maxAge: 0,
    path: "/",
    secure: cookieSecure(publicUrl),
  });
}

export interface ResolvedSession {
  token: string;
  user: UserRecord;
  session: SessionRecord;
}

export type SessionLookup =
  | { kind: "none" }
  | { kind: "ok"; resolved: ResolvedSession }
  | { kind: "unavailable" };

type RefreshOutcome = { kind: "none" } | { kind: "unavailable" } | { kind: "ok"; user: UserRecord };

/**
 * 控制面是单进程。同一会话并发越过刷新窗口时只打一次身份提供方，
 * 其它请求等待并共用结果。结束或失败都从 Map 移除，避免轮换后的旧 token 被再送一次。
 */
const refreshFlights = new Map<string, Promise<RefreshOutcome>>();

function shareRefresh(sessionId: string, work: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
  const existing = refreshFlights.get(sessionId);
  if (existing) return existing;
  const { promise, resolve } = Promise.withResolvers<RefreshOutcome>();
  refreshFlights.set(sessionId, promise);
  void work().then(
    (outcome) => resolve(outcome),
    () => resolve({ kind: "unavailable" }),
  );
  void promise.finally(() => {
    if (refreshFlights.get(sessionId) === promise) refreshFlights.delete(sessionId);
  });
  return promise;
}

export async function resolveSession(
  db: AppDatabase,
  key: Buffer,
  config: ControlConfig,
  identity: IdentityProvider,
  cookieHeader: string | undefined,
  now: Date,
  disconnectUser: (userId: string) => void,
): Promise<SessionLookup> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return { kind: "none" };
  const sessions = sessionRepository(db);
  const session = sessions.findByTokenHash(hashToken(token));
  if (!session) return { kind: "none" };
  if (Date.parse(session.expiresAt) <= now.getTime()) {
    sessions.delete(session.id);
    return { kind: "none" };
  }

  const users = userRepository(db);
  const user = users.findById(session.userId);
  if (!user || user.status === "disabled") {
    sessions.delete(session.id);
    disconnectUser(session.userId);
    return { kind: "none" };
  }

  let current = user;
  if (now.getTime() - Date.parse(session.lastValidatedAt) > REFRESH_WINDOW_MS) {
    const outcome = await shareRefresh(session.id, () =>
      refreshStoredSession(db, key, config, identity, session.id, now, disconnectUser),
    );
    if (outcome.kind !== "ok") return outcome;
    current = outcome.user;
  }

  const seen = now.toISOString();
  sessions.touch(session.id, seen, new Date(now.getTime() + SESSION_TTL_MS).toISOString());
  const fresh = sessions.findByTokenHash(hashToken(token));
  if (!fresh) return { kind: "none" };
  return { kind: "ok", resolved: { token, user: current, session: fresh } };
}

export function rememberSession(reply: FastifyReply, publicUrl: string, token: string): void {
  reply.header("set-cookie", sessionCookie(publicUrl, token));
}

async function refreshStoredSession(
  db: AppDatabase,
  key: Buffer,
  config: ControlConfig,
  identity: IdentityProvider,
  sessionId: string,
  now: Date,
  disconnectUser: (userId: string) => void,
): Promise<RefreshOutcome> {
  const sessions = sessionRepository(db);
  const session = sessions.findById(sessionId);
  if (!session) return { kind: "none" };
  const users = userRepository(db);
  if (now.getTime() - Date.parse(session.lastValidatedAt) <= REFRESH_WINDOW_MS) {
    return currentUser(sessions, users, session, disconnectUser);
  }

  let refreshToken: string;
  try {
    refreshToken = decrypt(key, session.refreshTokenEnc);
  } catch {
    sessions.delete(session.id);
    disconnectUser(session.userId);
    return { kind: "none" };
  }

  let refreshed: { identity: ExternalIdentity | null; refreshToken: string } | "revoked";
  try {
    refreshed = await identity.refresh(refreshToken);
  } catch {
    return { kind: "unavailable" };
  }
  if (refreshed === "revoked") {
    sessions.delete(session.id);
    disconnectUser(session.userId);
    return { kind: "none" };
  }

  sessions.saveRefresh(session.id, encrypt(key, refreshed.refreshToken), now.toISOString());
  if (!refreshed.identity) return currentUser(sessions, users, session, disconnectUser);
  try {
    const updated = acceptIdentity(db, config, identity.id, refreshed.identity);
    if (updated.status === "disabled") {
      sessions.delete(session.id);
      disconnectUser(session.userId);
      return { kind: "none" };
    }
    return { kind: "ok", user: updated };
  } catch {
    sessions.delete(session.id);
    disconnectUser(session.userId);
    return { kind: "none" };
  }
}

function currentUser(
  sessions: ReturnType<typeof sessionRepository>,
  users: ReturnType<typeof userRepository>,
  session: SessionRecord,
  disconnectUser: (userId: string) => void,
): RefreshOutcome {
  const user = users.findById(session.userId);
  if (!user || user.status === "disabled") {
    sessions.delete(session.id);
    disconnectUser(session.userId);
    return { kind: "none" };
  }
  return { kind: "ok", user };
}
