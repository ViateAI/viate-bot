import { createViateIntegration, type ViateIntegration } from "@viate-bot/integration-viate";
import type { ControlConfig } from "./config.js";
import { credentialRepository } from "./db/credentials.js";
import type { AppDatabase } from "./db/index.js";
import { usageRepository } from "./db/usage.js";
import { botRepository } from "./db/bots.js";
import { localDirectory } from "./local-directory.js";
import { OidcIdentityProvider } from "./oidc.js";
import type { AppRuntime } from "./providers.js";
import { sharedCredentialProvider } from "./shared-key.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const USAGE_LOOKBACK_MS = 48 * HOUR_MS;

export interface ComposeOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  onDisconnect?: (userId: string) => void;
}

/** 唯一允许引用 viate 集成包的组装入口。 */
export function createRuntime(config: ControlConfig, db: AppDatabase, options: ComposeOptions = {}): AppRuntime {
  const now = options.now ?? (() => new Date());
  const identity = new OidcIdentityProvider({
    id: config.integration === "viate" ? "viate" : "oidc",
    issuer: config.oidcIssuer,
    clientId: config.oidcClientId,
    clientSecret: config.oidcClientSecret,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const hooks = { disconnectUser: options.onDisconnect ?? (() => {}) };
  if (config.integration !== "viate") {
    return {
      identity,
      credentials: sharedCredentialProvider(config),
      directory: localDirectory(db, identity.id),
      hooks,
      startJobs: () => () => {},
    };
  }
  const credentials = config.serviceCredentials;
  const viate = createViateIntegration({
    url: credentials?.url ?? "",
    clientId: credentials?.clientId ?? "",
    clientSecret: credentials?.clientSecret ?? "",
    now: () => now().getTime(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    identity,
    credentials: viate.credentials,
    directory: viate.directory,
    hooks,
    startJobs: () => startViateJobs(db, viate, now),
  };
}

function startViateJobs(db: AppDatabase, viate: ViateIntegration, now: () => Date): () => void {
  const pull = () => pullViateUsage(db, viate, now());
  const reconcile = () =>
    viate.reconcile((botId) => botRepository(db).isActive(botId)).then(() => undefined);
  const usageTimer = setInterval(() => {
    pull().catch((error: unknown) => console.error("拉取 viate 扣费失败", error));
  }, HOUR_MS);
  const reconcileTimer = setInterval(() => {
    reconcile().catch((error: unknown) => console.error("viate key 对账失败", error));
  }, DAY_MS);
  usageTimer.unref?.();
  reconcileTimer.unref?.();
  return () => {
    clearInterval(usageTimer);
    clearInterval(reconcileTimer);
  };
}

export async function pullViateUsage(
  db: AppDatabase,
  viate: Pick<ViateIntegration, "pullUsage">,
  now: Date,
): Promise<number> {
  const to = now.toISOString();
  const from = new Date(now.getTime() - USAGE_LOOKBACK_MS).toISOString();
  const rows = await viate.pullUsage(credentialRepository(db).listBillableExternal(from), from, to);
  usageRepository(db).upsert(rows);
  return rows.length;
}
