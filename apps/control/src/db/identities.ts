import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "./index.js";
import { identities } from "./schema.js";

export interface IdentityRecord {
  provider: string;
  subject: string;
  userId: string;
  email: string | null;
  emailVerified: boolean;
}

export function identityRepository(db: AppDatabase) {
  return {
    find(provider: string, subject: string): IdentityRecord | undefined {
      const row = db
        .select()
        .from(identities)
        .where(and(eq(identities.provider, provider), eq(identities.subject, subject)))
        .get();
      return row ? toRecord(row) : undefined;
    },
    findByUser(userId: string, provider: string): IdentityRecord | undefined {
      const row = db
        .select()
        .from(identities)
        .where(and(eq(identities.userId, userId), eq(identities.provider, provider)))
        .get();
      return row ? toRecord(row) : undefined;
    },
    findBySubject(subject: string): IdentityRecord | undefined {
      const row = db.select().from(identities).where(eq(identities.subject, subject)).get();
      return row ? toRecord(row) : undefined;
    },
    insert(record: IdentityRecord): void {
      db.insert(identities)
        .values({
          provider: record.provider,
          subject: record.subject,
          userId: record.userId,
          email: record.email,
          emailVerified: record.emailVerified,
          createdAt: new Date().toISOString(),
        })
        .run();
    },
    updateClaims(provider: string, subject: string, email: string | null, emailVerified: boolean): void {
      db.update(identities)
        .set({ email, emailVerified })
        .where(and(eq(identities.provider, provider), eq(identities.subject, subject)))
        .run();
    },
  };
}

function toRecord(row: typeof identities.$inferSelect): IdentityRecord {
  return {
    provider: row.provider,
    subject: row.subject,
    userId: row.userId,
    email: row.email,
    emailVerified: row.emailVerified,
  };
}
