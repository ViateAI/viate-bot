import { eq } from "drizzle-orm";
import type { AppDatabase } from "./index.js";
import { users } from "./schema.js";

/** 用户行是身份来源，本身不带 UserScope。开发脚本在创建机器前写入它。 */
export function ensureDevUser(db: AppDatabase, userId: string): void {
  if (db.select().from(users).where(eq(users.id, userId)).get()) return;
  db.insert(users)
    .values({
      id: userId,
      email: `${userId}@dev.local`,
      name: userId,
      status: "active",
      isAdmin: false,
      createdAt: new Date().toISOString(),
    })
    .run();
}
