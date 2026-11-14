import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViateIntegration } from "@viate-bot/integration-viate";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { createBot, deleteBot } from "./bot-service.js";
import { pullViateUsage, USAGE_LOOKBACK_MS } from "./compose.js";
import { loadConfig } from "./config.js";
import { decrypt, loadOrCreateKey } from "./crypto.js";
import { credentialRepository } from "./db/credentials.js";
import { identityRepository } from "./db/identities.js";
import { openDatabase } from "./db/index.js";
import { ensureDevUser, userRepository } from "./db/users.js";
import type { CredentialProvider, IssuedCredential } from "./providers.js";
import { sharedCredentialProvider } from "./shared-key.js";
import { userScope } from "./scope.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), "vb-bots-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  const key = loadOrCreateKey(join(dir, "secret.key"));
  ensureDevUser(db, "user-a");
  ensureDevUser(db, "user-b");
  return { db, key };
}

describe("bot credentials", () => {
  it("shares one encrypted key and does not revoke it when a bot is deleted", async () => {
    const { db, key } = database();
    const config = loadConfig({ VB_MODEL_API_KEY: "shared-secret" });
    const deps = { db, key, credentials: sharedCredentialProvider(config), providerId: "oidc" };
    const scope = userScope("user-a");
    const first = await createBot(deps, scope, { name: "One", model: "m" });
    const second = await createBot(deps, scope, { name: "Two", model: "m" });
    expect(first.modelCredentialId).toBe(second.modelCredentialId);
    const stored = credentialRepository(db).findShared();
    expect(stored?.userId).toBeNull();
    expect(stored?.botId).toBeNull();
    expect(decrypt(key, stored!.secretEnc)).toBe("shared-secret");
    expect(await deleteBot(deps, scope, first.id)).toBe(true);
    expect(credentialRepository(db).findShared()?.revokedAt).toBeNull();
    expect(await deleteBot(deps, userScope("user-b"), second.id)).toBe(false);
    expect(await deleteBot(deps, scope, second.id)).toBe(true);
    expect(credentialRepository(db).findShared()?.revokedAt).toBeNull();
    db.$client.close();
  });

  it("issues and revokes a per-bot credential without crossing users", async () => {
    const { db, key } = database();
    identityRepository(db).insert({
      provider: "viate",
      subject: "sub-a",
      userId: "user-a",
      email: "a@example.com",
      emailVerified: false,
    });
    const revoked: string[] = [];
    const seen: Array<{ subject: string | null; policyRef?: string }> = [];
    const credentials: CredentialProvider = {
      async issue(bot, policyRef): Promise<IssuedCredential> {
        seen.push(policyRef === undefined ? { subject: bot.subject } : { subject: bot.subject, policyRef });
        return {
          provider: "viate",
          externalId: `ext-${bot.id}`,
          secret: `secret-${bot.id}`,
          policyRef: policyRef ?? "channel",
          shared: false,
        };
      },
      async revoke(credential) {
        if (credential.externalId) revoked.push(credential.externalId);
      },
    };
    const deps = { db, key, credentials, providerId: "viate" };
    const scope = userScope("user-a");
    const bot = await createBot(deps, scope, { name: "Helper", model: "m", policyRef: "channel-9" });
    expect(seen).toEqual([{ subject: "sub-a", policyRef: "channel-9" }]);
    const stored = credentialRepository(db).findById(scope, bot.modelCredentialId!);
    expect(decrypt(key, stored!.secretEnc)).toBe(`secret-${bot.id}`);
    expect(stored?.externalId).toBe(`ext-${bot.id}`);
    expect(await deleteBot(deps, userScope("user-b"), bot.id)).toBe(false);
    expect(revoked).toEqual([]);
    expect(await deleteBot(deps, scope, bot.id)).toBe(true);
    expect(revoked).toEqual([`ext-${bot.id}`]);
    expect(credentialRepository(db).findById(scope, stored!.id)?.revokedAt).not.toBeNull();
    expect(userRepository(db).findById("user-b")?.id).toBe("user-b");
    db.$client.close();
  });

  it("still pulls usage for a revoked bot key inside the lookback window", async () => {
    const { db, key } = database();
    identityRepository(db).insert({
      provider: "viate",
      subject: "sub-a",
      userId: "user-a",
      email: "a@example.com",
      emailVerified: false,
    });
    const credentials: CredentialProvider = {
      async issue(bot) {
        return {
          provider: "viate",
          externalId: `ext-${bot.id}`,
          secret: `secret-${bot.id}`,
          policyRef: "channel",
          shared: false,
        };
      },
      async revoke() {},
    };
    const scope = userScope("user-a");
    const bot = await createBot({ db, key, credentials, providerId: "viate" }, scope, { name: "Helper", model: "m" });
    const queried: string[][] = [];
    const viate: Pick<ViateIntegration, "pullUsage"> = {
      async pullUsage(items) {
        queried.push(items.map((item) => item.externalId));
        return items.map((item) => ({
          botId: item.botId,
          userId: item.userId,
          model: "",
          hour: "2026-11-14T05:00:00.000Z",
          requests: 7,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: "0.070000",
          costSource: "viate",
        }));
      },
    };
    expect(await pullViateUsage(db, viate, new Date())).toBe(1);
    expect(queried.at(-1)).toEqual([`ext-${bot.id}`]);
    expect(await deleteBot({ db, key, credentials, providerId: "viate" }, scope, bot.id)).toBe(true);
    expect(credentialRepository(db).listActiveExternal()).toEqual([]);
    const revokedAt = credentialRepository(db).findById(scope, bot.modelCredentialId!)?.revokedAt;
    expect(revokedAt).toBeTruthy();
    const inside = new Date(Date.parse(revokedAt!) + USAGE_LOOKBACK_MS - 1000);
    expect(await pullViateUsage(db, viate, inside)).toBe(1);
    expect(queried.at(-1)).toEqual([`ext-${bot.id}`]);
    expect(db.$client.prepare("select requests, cost_source from usage_hourly").all()).toEqual([
      { requests: 7, cost_source: "viate" },
    ]);
    const outside = new Date(Date.parse(revokedAt!) + USAGE_LOOKBACK_MS + 1000);
    expect(await pullViateUsage(db, viate, outside)).toBe(0);
    expect(queried.at(-1)).toEqual([]);
    expect(db.$client.prepare("select count(*) as count from usage_hourly").get()).toEqual({ count: 1 });
    db.$client.close();
  });
});
