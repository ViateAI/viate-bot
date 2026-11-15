import { encrypt } from "./crypto.js";
import { botRepository, type BotRecord } from "./db/bots.js";
import { credentialRepository } from "./db/credentials.js";
import { identityRepository } from "./db/identities.js";
import type { AppDatabase } from "./db/index.js";
import { settingsRepository } from "./db/settings.js";
import { ulid } from "./id.js";
import type { CredentialProvider, IssuedCredential } from "./providers.js";
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
  const policyRef = input.policyRef ?? settingsRepository(deps.db).defaultChannel() ?? undefined;
  let issued: IssuedCredential | undefined;
  try {
    const credential = await deps.credentials.issue(
      { id, name: input.name, userId: scope.userId, subject },
      ...(policyRef !== undefined ? [policyRef] : []),
    );
    issued = credential;
    deps.db.transaction(() => {
      if (credential.shared) {
        const existing = credentials.findShared();
        const shared = existing ?? credentials.insertShared(ulid(), encrypt(deps.key, credential.secret));
        if (existing) credentials.updateSecret(existing.id, encrypt(deps.key, credential.secret));
        bots.setCredential(scope, id, shared.id);
      } else {
        const row = credentials.insertOwned(scope, {
          id: ulid(),
          botId: id,
          provider: credential.provider,
          externalId: credential.externalId,
          secretEnc: encrypt(deps.key, credential.secret),
          policyRef: credential.policyRef,
        });
        bots.setCredential(scope, id, row.id);
      }
    });
  } catch (error) {
    bots.remove(scope, id);
    if (issued && !issued.shared) {
      try {
        await deps.credentials.revoke({ provider: issued.provider, externalId: issued.externalId, shared: false });
      } catch {
        throw new BotRejected("凭据保存失败；回滚未完成：凭据吊销失败", 503);
      }
    }
    throw error;
  }
  if (deps.ensureMachine) {
    try {
      await deps.ensureMachine(scope.userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "机器创建失败";
      try {
        await revokeOwned(deps, scope, id);
      } catch {
        throw new BotRejected(`${message}；回滚未完成：凭据吊销失败`, 503);
      } finally {
        // 保留未吊销凭据供对账回收，但失败的 bot 不能继续接收任务。
        bots.softDelete(scope, id);
      }
      throw new BotRejected(message, 503);
    }
  }
  const created = bots.findById(scope, id);
  if (!created) throw new Error("创建 bot 后读不回来");
  return created;
}

export async function deleteBot(deps: BotServiceDeps, scope: UserScope, id: string): Promise<boolean> {
  const bots = botRepository(deps.db);
  const bot = bots.findById(scope, id);
  if (!bot) return false;
  await revokeOwned(deps, scope, id);
  return bots.softDelete(scope, id);
}

/** 只吊销这个用户名下的按 bot 签发的凭据。共享 key 的 user_id 为空，findById 读不到，不会被吊销。 */
async function revokeOwned(deps: BotServiceDeps, scope: UserScope, id: string): Promise<void> {
  const bots = botRepository(deps.db);
  const credentials = credentialRepository(deps.db);
  const bot = bots.findById(scope, id);
  if (!bot?.modelCredentialId) return;
  const owned = credentials.findById(scope, bot.modelCredentialId);
  if (!owned) return;
  await deps.credentials.revoke({
    provider: owned.provider,
    externalId: owned.externalId,
    shared: false,
  });
  credentials.markRevoked(scope, owned.id, new Date().toISOString());
}
