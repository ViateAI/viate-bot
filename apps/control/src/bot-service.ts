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

export class BotRejected extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "BotRejected";
  }
}

export interface BotServiceDeps {
  db: AppDatabase;
  key: Buffer;
  credentials: CredentialProvider;
  providerId: string;
  /** 缺省不限制。创建 bot 时先检查，避免先写入再拒绝。 */
  allowModel?: (model: string) => boolean;
  maxBots?: (scope: UserScope) => number;
  /** 该用户还没有机器时创建一台停止的机器。失败则删掉刚创建的 bot。 */
  ensureMachine?: (userId: string) => Promise<void>;
}

export async function createBot(deps: BotServiceDeps, scope: UserScope, input: CreateBotInput): Promise<BotRecord> {
  const bots = botRepository(deps.db);
  const credentials = credentialRepository(deps.db);
  if (deps.allowModel && !deps.allowModel(input.model)) {
    throw new BotRejected(`模型不在白名单内: ${input.model}`, 400);
  }
  const maxBots = deps.maxBots?.(scope);
  if (maxBots !== undefined && bots.list(scope).length >= maxBots) {
    throw new BotRejected("已达到 bot 数量上限", 403);
  }
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
  if (deps.ensureMachine) {
    try {
      await deps.ensureMachine(scope.userId);
    } catch (error) {
      bots.softDelete(scope, id);
      const message = error instanceof Error ? error.message : "机器创建失败";
      throw new BotRejected(message, 503);
    }
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
