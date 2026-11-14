import { identityRepository } from "./db/identities.js";
import type { AppDatabase } from "./db/index.js";
import { userRepository } from "./db/users.js";
import type { Directory } from "./providers.js";

/** 不接外部目录时，只根据本地 users.status 回答。 */
export function localDirectory(db: AppDatabase, providerId: string): Directory {
  const identities = identityRepository(db);
  const users = userRepository(db);
  return {
    async userStatus(identity) {
      const row = identities.find(identity.provider ?? providerId, identity.subject);
      if (!row) return "unknown";
      const user = users.findById(row.userId);
      if (!user) return "unknown";
      if (user.status === "disabled") return "disabled";
      if (user.status === "active") return "active";
      return "unknown";
    },
  };
}
