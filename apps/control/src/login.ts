import type { ControlConfig } from "./config.js";
import type { AppDatabase } from "./db/index.js";
import { identityRepository } from "./db/identities.js";
import { userRepository, type UserRecord } from "./db/users.js";
import { ulid } from "./id.js";
import type { ExternalIdentity } from "./providers.js";

export class LoginRejected extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "LoginRejected";
    this.statusCode = statusCode;
  }
}

export function emailTrusted(identity: ExternalIdentity, config: ControlConfig): boolean {
  return identity.emailVerified || config.oidcTrustEmail;
}

export function adminFor(identity: ExternalIdentity, config: ControlConfig): boolean {
  const email = normalizeEmail(identity.email);
  if (!email || !emailTrusted(identity, config)) return false;
  return config.adminEmails.includes(email);
}

/** 按 (provider, sub) 匹配；否则在邮箱可信时绑定唯一的未绑定用户；再否则看是否允许注册。 */
export function acceptIdentity(
  db: AppDatabase,
  config: ControlConfig,
  providerId: string,
  identity: ExternalIdentity,
): UserRecord {
  const users = userRepository(db);
  const identities = identityRepository(db);
  const email = normalizeEmail(identity.email);
  const isAdmin = adminFor(identity, config);
  const name = identity.name?.trim() || email || identity.sub;

  const existing = identities.find(providerId, identity.sub);
  if (existing) {
    const user = users.findById(existing.userId);
    if (!user || user.status === "disabled") throw new LoginRejected("用户已禁用", 403);
    identities.updateClaims(providerId, identity.sub, email, identity.emailVerified);
    users.updateProfile(user.id, {
      ...(email ? { email } : {}),
      ...(identity.name?.trim() ? { name: identity.name.trim() } : {}),
      isAdmin,
    });
    const updated = users.findById(user.id);
    if (!updated) throw new LoginRejected("用户已禁用", 403);
    return updated;
  }

  if (email && emailTrusted(identity, config)) {
    const candidates = users.findUnboundByEmail(email);
    if (candidates.length === 1) {
      const user = candidates[0];
      if (!user || user.status === "disabled") throw new LoginRejected("用户已禁用", 403);
      identities.insert({
        provider: providerId,
        subject: identity.sub,
        userId: user.id,
        email,
        emailVerified: identity.emailVerified,
      });
      users.updateProfile(user.id, { email, name, isAdmin });
      const updated = users.findById(user.id);
      if (!updated) throw new LoginRejected("用户已禁用", 403);
      return updated;
    }
  }

  if (!config.allowSignup && !adminSignup(identity, config)) throw new LoginRejected("不允许注册", 403);
  const id = ulid();
  const created = users.insert({
    id,
    email: email || `${identity.sub}@unknown.invalid`,
    name,
    status: "active",
    isAdmin,
  });
  identities.insert({
    provider: providerId,
    subject: identity.sub,
    userId: created.id,
    email,
    emailVerified: identity.emailVerified,
  });
  return created;
}

/**
 * 关闭注册时，管理员邮箱仍走和开放注册一样的首登建号。
 * 必须有邮箱声明。VB_OIDC_TRUST_EMAIL 关闭时还要求 email_verified 严格为 true；打开时不检查这项。
 * 不按邮箱把新身份绑到已有用户。
 */
function adminSignup(identity: ExternalIdentity, config: ControlConfig): boolean {
  const email = normalizeEmail(identity.email);
  if (!email || !config.adminEmails.includes(email)) return false;
  if (config.oidcTrustEmail) return true;
  return identity.emailVerified === true;
}

export function normalizeEmail(email: string | null): string | null {
  if (email === null) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
