import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { identityRepository } from "./db/identities.js";
import { openDatabase } from "./db/index.js";
import { userRepository } from "./db/users.js";
import { acceptIdentity, LoginRejected } from "./login.js";
import type { ExternalIdentity } from "./providers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function db() {
  const dir = mkdtempSync(join(tmpdir(), "vb-login-"));
  dirs.push(dir);
  const database = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(database, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  return database;
}

function config(allow: boolean, admins = "ada@example.com") {
  return loadConfig({
    VB_DATA_DIR: dirs[dirs.length - 1],
    VB_ALLOW_SIGNUP: allow ? "true" : "false",
    VB_ADMIN_EMAILS: admins,
  });
}

function identity(sub: string, email: string | null, verified: boolean | undefined): ExternalIdentity {
  return {
    sub,
    email,
    emailVerified: verified === true,
    name: "Ada",
  };
}

describe("admin signup while registration is closed", () => {
  it.each([
    { allow: true, listed: true, verified: true },
    { allow: true, listed: true, verified: false },
    { allow: true, listed: true, verified: "missing" as const },
    { allow: true, listed: false, verified: true },
    { allow: true, listed: false, verified: false },
    { allow: true, listed: false, verified: "missing" as const },
    { allow: false, listed: true, verified: true },
    { allow: false, listed: true, verified: false },
    { allow: false, listed: true, verified: "missing" as const },
    { allow: false, listed: false, verified: true },
    { allow: false, listed: false, verified: false },
    { allow: false, listed: false, verified: "missing" as const },
  ])("allow=$allow listed=$listed verified=$verified", ({ allow, listed, verified }) => {
    const database = db();
    const address = listed ? "  Ada@Example.com  " : "  other@example.com  ";
    const claim = identity(
      `sub-${allow}-${listed}-${String(verified)}`,
      address,
      verified === "missing" ? undefined : verified,
    );
    if (verified === "missing") {
      Object.assign(claim, { emailVerified: undefined });
    }
    const cfg = config(allow);
    const shouldCreate = allow || (listed && verified === true);
    if (!shouldCreate) {
      expect(() => acceptIdentity(database, cfg, "oidc", claim)).toThrow(LoginRejected);
      expect(() => acceptIdentity(database, cfg, "oidc", claim)).toThrow("不允许注册");
      expect(userRepository(database).findByEmail("ada@example.com")).toEqual([]);
      expect(userRepository(database).findByEmail("other@example.com")).toEqual([]);
    } else {
      const user = acceptIdentity(database, cfg, "oidc", claim);
      expect(user.isAdmin).toBe(listed && verified === true);
      expect(identityRepository(database).find("oidc", claim.sub)?.userId).toBe(user.id);
      expect(user.email).toBe(listed ? "ada@example.com" : "other@example.com");
    }
    database.$client.close();
  });

  it("does not register an admin when the IdP sends no email claim", () => {
    const database = db();
    expect(() => acceptIdentity(database, config(false), "oidc", identity("no-email", null, true))).toThrow("不允许注册");
    expect(userRepository(database).findByEmail("ada@example.com")).toEqual([]);
    database.$client.close();
  });

  it("binds the single existing unbound user and does not attach a new identity when several share the email", () => {
    const database = db();
    const cfg = config(false, " Ada@Example.com ");
    userRepository(database).insert({ id: "one", email: "ada@example.com", name: "One", status: "active", isAdmin: false });
    const bound = acceptIdentity(database, cfg, "oidc", identity("verified-admin", " ada@example.com ", true));
    expect(bound.id).toBe("one");
    expect(bound.isAdmin).toBe(true);

    userRepository(database).insert({ id: "two", email: "ada@example.com", name: "Two", status: "active", isAdmin: false });
    userRepository(database).insert({ id: "three", email: "ada@example.com", name: "Three", status: "active", isAdmin: false });
    const created = acceptIdentity(database, cfg, "oidc", identity("second-admin", "ADA@example.com", true));
    expect(created.id).not.toBe("one");
    expect(created.id).not.toBe("two");
    expect(created.id).not.toBe("three");
    expect(identityRepository(database).find("oidc", "second-admin")?.userId).toBe(created.id);
    expect(identityRepository(database).findByUser("two", "oidc")).toBeUndefined();
    expect(identityRepository(database).findByUser("three", "oidc")).toBeUndefined();
    database.$client.close();
  });

  it.each([
    { trust: false, verified: true, listed: true, creates: true },
    { trust: false, verified: false, listed: true, creates: false },
    { trust: false, verified: "missing" as const, listed: true, creates: false },
    { trust: true, verified: true, listed: true, creates: true },
    { trust: true, verified: false, listed: true, creates: true },
    { trust: true, verified: "missing" as const, listed: true, creates: true },
    { trust: true, verified: false, listed: false, creates: false },
    { trust: true, verified: "missing" as const, listed: false, creates: false },
  ])("trust=$trust verified=$verified listed=$listed", ({ trust, verified, listed, creates }) => {
    const database = db();
    const cfg = config(false, listed ? "ada@example.com" : "other@example.com");
    cfg.oidcTrustEmail = trust;
    const claim = identity("trust-sub", listed ? " Ada@Example.com " : " stranger@example.com ", verified === true);
    if (verified === "missing") Object.assign(claim, { emailVerified: undefined });
    if (!creates) {
      expect(() => acceptIdentity(database, cfg, "oidc", claim)).toThrow("不允许注册");
      expect(identityRepository(database).find("oidc", claim.sub)).toBeUndefined();
    } else {
      const user = acceptIdentity(database, cfg, "oidc", claim);
      expect(user.isAdmin).toBe(true);
      expect(user.email).toBe("ada@example.com");
    }
    database.$client.close();
  });

  it("still requires an email claim when email verification is trusted", () => {
    const database = db();
    const cfg = config(false);
    cfg.oidcTrustEmail = true;
    expect(() => acceptIdentity(database, cfg, "oidc", identity("no-email-trust", null, false))).toThrow("不允许注册");
    expect(userRepository(database).findByEmail("ada@example.com")).toEqual([]);
    database.$client.close();
  });

  it.each([false, true])("only trusts unverified email for preprovisioned binding when trust=$trust", (trust) => {
    const database = db();
    try {
      const cfg = config(false);
      cfg.oidcTrustEmail = trust;
      userRepository(database).insert({ id: "ordinary", email: "ordinary@example.com", name: "Ordinary", status: "active", isAdmin: false });
      const claim = identity("ordinary-sub", " Ordinary@Example.com ", false);
      if (trust) {
        const user = acceptIdentity(database, cfg, "oidc", claim);
        expect(user.id).toBe("ordinary");
        expect(user.isAdmin).toBe(false);
      } else {
        expect(() => acceptIdentity(database, cfg, "oidc", claim)).toThrow("不允许注册");
        expect(identityRepository(database).find("oidc", claim.sub)).toBeUndefined();
      }
    } finally {
      database.$client.close();
    }
  });
});
