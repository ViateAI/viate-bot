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
import { botRepository } from "./db/bots.js";
import { credentialRepository } from "./db/credentials.js";
import { identityRepository } from "./db/identities.js";
import { openDatabase } from "./db/index.js";
import { machineRepository, type MachineRecord } from "./db/machines.js";
import { settingsRepository } from "./db/settings.js";
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
  it("uses the configured default channel for later bots but preserves an explicit override", async () => {
    const { db, key } = database();
    settingsRepository(db).setDefaultChannel("default-channel");
    const credentials: CredentialProvider = {
      async issue(bot, policyRef) {
        return { provider: "viate", externalId: `ext-${bot.id}`, secret: "s", policyRef: policyRef ?? "first-upstream-channel", shared: false };
      },
      async revoke() {},
    };
    const scope = userScope("user-a");
    const deps = { db, key, credentials, providerId: "viate" };
    const defaultBot = await createBot(deps, scope, { name: "Default", model: "m" });
    const overrideBot = await createBot(deps, scope, { name: "Override", model: "m", policyRef: "override-channel" });
    expect(credentialRepository(db).findById(scope, defaultBot.modelCredentialId!)?.policyRef).toBe("default-channel");
    expect(credentialRepository(db).findById(scope, overrideBot.modelCredentialId!)?.policyRef).toBe("override-channel");
    db.$client.close();
  });

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
    expect(await deleteBot(deps, userScope("user-b"), second.id)).toBe(false);
    expect(await deleteBot(deps, scope, second.id)).toBe(true);
    expect(credentialRepository(db).findShared()?.revokedAt).toBeNull();
    await expect(deleteBot(deps, scope, first.id)).rejects.toMatchObject({ statusCode: 409, message: "主 bot 不能删除" });
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
    await createBot(deps, scope, { name: "Keeper", model: "m" });
    const bot = await createBot(deps, scope, { name: "Helper", model: "m", policyRef: "channel-9" });
    expect(seen).toEqual([{ subject: "sub-a" }, { subject: "sub-a", policyRef: "channel-9" }]);
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
    const keeper = await createBot({ db, key, credentials, providerId: "viate" }, scope, { name: "Keeper", model: "m" });
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
    expect(await pullViateUsage(db, viate, new Date())).toBe(2);
    expect(queried.at(-1)?.slice().sort()).toEqual([`ext-${keeper.id}`, `ext-${bot.id}`].sort());
    expect(await deleteBot({ db, key, credentials, providerId: "viate" }, scope, bot.id)).toBe(true);
    expect(credentialRepository(db).listActiveExternal().map((item) => item.externalId)).toEqual([`ext-${keeper.id}`]);
    const revokedAt = credentialRepository(db).findById(scope, bot.modelCredentialId!)?.revokedAt;
    expect(revokedAt).toBeTruthy();
    const inside = new Date(Date.parse(revokedAt!) + USAGE_LOOKBACK_MS - 1000);
    expect(await pullViateUsage(db, viate, inside)).toBe(2);
    expect(queried.at(-1)?.slice().sort()).toEqual([`ext-${keeper.id}`, `ext-${bot.id}`].sort());
    expect(db.$client.prepare("select requests, cost_source from usage_hourly order by bot_id").all()).toEqual(
      [keeper.id, bot.id].sort().map(() => ({ requests: 7, cost_source: "viate" })),
    );
    const outside = new Date(Date.parse(revokedAt!) + USAGE_LOOKBACK_MS + 1000);
    expect(await pullViateUsage(db, viate, outside)).toBe(1);
    expect(queried.at(-1)).toEqual([`ext-${keeper.id}`]);
    expect(db.$client.prepare("select count(*) as count from usage_hourly").get()).toEqual({ count: 2 });
    db.$client.close();
  });

  it("leaves the machine in place when the last bot is deleted", async () => {
    const { db, key } = database();
    const scope = userScope("user-a");
    const record: MachineRecord = {
      id: "machine-a",
      userId: "user-a",
      state: "stopped",
      containerId: "c",
      networkId: "n",
      volumeName: "vb-home-user-a",
      imageVersion: "viate-bot/machine:dev",
      spec: { cpu: 1, memMb: 1024, diskGb: 10 },
      tokenEnc: "enc",
    };
    machineRepository(db).insert(scope, record);
    const deps = { db, key, credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "shared-secret" })), providerId: "oidc" };
    const primary = await createBot(deps, scope, { name: "Primary", model: "m" });
    const other = await createBot(deps, scope, { name: "Other", model: "m" });
    expect(await deleteBot(deps, scope, other.id)).toBe(true);
    expect(machineRepository(db).find(scope)?.id).toBe("machine-a");
    expect(machineRepository(db).find(scope)?.volumeName).toBe("vb-home-user-a");
    await expect(deleteBot(deps, scope, primary.id)).rejects.toMatchObject({ statusCode: 409, message: "主 bot 不能删除" });
    expect(machineRepository(db).find(scope)?.id).toBe("machine-a");
    db.$client.close();
  });

  it("revokes an issued key when machine creation fails", async () => {
    const { db, key } = database();
    const revoked: string[] = [];
    const credentials: CredentialProvider = {
      async issue(bot) {
        return { provider: "viate", externalId: `ext-${bot.id}`, secret: "s", policyRef: null, shared: false };
      },
      async revoke(credential) {
        if (credential.externalId) revoked.push(credential.externalId);
      },
    };
    await expect(
      createBot(
        {
          db,
          key,
          credentials,
          providerId: "oidc",
          ensureMachine: async () => {
            throw new Error("机器创建失败");
          },
        },
        userScope("user-a"),
        { name: "Only", model: "m" },
      ),
    ).rejects.toThrow(/机器创建失败/);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatch(/^ext-/);
    db.$client.close();
  });
});
describe("primary bot", () => {
  it("refuses to delete the earliest live bot and still deletes a later one", async () => {
    const { db, key } = database();
    const deps = {
      db,
      key,
      credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "shared-secret" })),
      providerId: "oidc",
    };
    const scope = userScope("user-a");
    const first = await createBot(deps, scope, { name: "First", model: "m" });
    const second = await createBot(deps, scope, { name: "Second", model: "m" });
    await expect(deleteBot(deps, scope, first.id)).rejects.toMatchObject({
      statusCode: 409,
      message: "主 bot 不能删除",
    });
    expect(botRepository(db).findById(scope, first.id)?.id).toBe(first.id);
    expect(await deleteBot(deps, scope, second.id)).toBe(true);
    expect(botRepository(db).findById(scope, second.id)).toBeUndefined();
    db.$client.close();
  });
  it("breaks equal created_at by id", async () => {
    const { db, key } = database();
    const deps = {
      db,
      key,
      credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "shared-secret" })),
      providerId: "oidc",
    };
    const scope = userScope("user-a");
    const left = await createBot(deps, scope, { name: "Left", model: "m" });
    const right = await createBot(deps, scope, { name: "Right", model: "m" });
    db.$client.prepare("update bots set created_at = ? where user_id = ?").run("2020-01-01T00:00:00.000Z", "user-a");
    const [earlier, later] = [left.id, right.id].sort();
    await expect(deleteBot(deps, scope, earlier!)).rejects.toMatchObject({
      statusCode: 409,
      message: "主 bot 不能删除",
    });
    expect(await deleteBot(deps, scope, later!)).toBe(true);
    db.$client.close();
  });
  it("treats the earliest remaining bot as primary after the original first bot was deleted", async () => {
    const { db, key } = database();
    const deps = {
      db,
      key,
      credentials: sharedCredentialProvider(loadConfig({ VB_MODEL_API_KEY: "shared-secret" })),
      providerId: "oidc",
    };
    const scope = userScope("user-a");
    const gone = await createBot(deps, scope, { name: "Gone", model: "m" });
    const kept = await createBot(deps, scope, { name: "Kept", model: "m" });
    const extra = await createBot(deps, scope, { name: "Extra", model: "m" });
    expect(botRepository(db).softDelete(scope, gone.id)).toBe(true);
    await expect(deleteBot(deps, scope, kept.id)).rejects.toMatchObject({
      statusCode: 409,
      message: "主 bot 不能删除",
    });
    expect(botRepository(db).findById(scope, kept.id)?.id).toBe(kept.id);
    expect(await deleteBot(deps, scope, extra.id)).toBe(true);
    db.$client.close();
  });
});
