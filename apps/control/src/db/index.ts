import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import SqliteDatabase, { type Database as SqliteConnection } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema> & {
  $client: SqliteConnection;
};

export function openDatabase(path: string): AppDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new SqliteDatabase(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export { schema };
