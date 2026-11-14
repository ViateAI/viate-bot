import { requireSharedModelKey, type ControlConfig } from "./config.js";
import type { CredentialProvider } from "./providers.js";

/** 所有 bot 共用 VB_MODEL_API_KEY。删除 bot 时 shared 为 true，调用方不得吊销。 */
export function sharedCredentialProvider(config: ControlConfig): CredentialProvider {
  return {
    async issue() {
      return {
        provider: "shared",
        externalId: null,
        secret: requireSharedModelKey(config),
        policyRef: null,
        shared: true,
      };
    },
    async revoke() {},
  };
}
