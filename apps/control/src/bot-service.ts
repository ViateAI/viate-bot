import { encrypt } from "./crypto.js";
import { botRepository, type BotRecord } from "./db/bots.js";
import { credentialRepository } from "./db/credentials.js";
import { identityRepository } from "./db/identities.js";
import type { AppDatabase } from "./db/index.js";
import { ulid } from "./id.js";
import type { CredentialProvider } from "./providers.js";
import type { UserScope } from "./scope.js";

export interface CreateBotInput {
  name: string;
  model: string;
  instructions?: string;
  policyRef?: string;
}

export interface BotServiceDeps {
  db: AppDatabase;
  key: Buffer;
  credentials: CredentialProvider;
  providerId: string;
}

export async function createBot(deps: BotServiceDeps, scope: UserScope, input: CreateBotInput): Promise<BotRecord> {
  const bots = botRepository(deps.db);
  const credentials = credentialRepository(deps.db);
  const id = ulid();
  bots.insert(scope, {
    id,
    name: input.name,
    model: input.model,
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
  });
  const subject = identityRepository(deps.db).findByUser(scope.userId, deps.providerId)?.subject ?? null;
  try {
    const issued = await deps.credentials.issue(
      { id, name: input.name, userId: scope.userId, subject },
      ...(input.policyRef !== undefined ? [input.policyRef] : []),
    );
    if (issued.shared) {
      const shared = deps.db.transaction(() => {
        const existing = credentials.findShared();
        if (existing) {
          credentials.updateSecret(existing.id, encrypt(deps.key, issued.secret));
          return existing;
        }
        return credentials.insertShared(ulid(), encrypt(deps.key, issued.secret));
      });
      bots.setCredential(scope, id, shared.id);
    } else {
      const row = credentials.insertOwned(scope, {
        id: ulid(),
        botId: id,
        provider: issued.provider,
        externalId: issued.externalId,
        secretEnc: encrypt(deps.key, issued.secret),
        policyRef: issued.policyRef,
      });
      bots.setCredential(scope, id, row.id);
    }
  } catch (error) {
    bots.remove(scope, id);
    throw error;
  }
  const created = bots.findById(scope, id);
  if (!created) throw new Error("创建 bot 后读不回来");
  return created;
}

export async function deleteBot(deps: BotServiceDeps, scope: UserScope, id: string): Promise<boolean> {
  const bots = botRepository(deps.db);
  const credentials = credentialRepository(deps.db);
  const bot = bots.findById(scope, id);
  if (!bot) return false;
  if (bot.modelCredentialId) {
    const owned = credentials.findById(scope, bot.modelCredentialId);
    if (owned) {
      await deps.credentials.revoke({
        provider: owned.provider,
        externalId: owned.externalId,
        shared: false,
      });
      credentials.markRevoked(scope, owned.id, new Date().toISOString());
    }
  }
  return bots.softDelete(scope, id);
}
