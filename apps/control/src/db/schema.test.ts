import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "./index.js";

const dirs: string[] = [];

function columnNames(db: AppDatabase, table: string): string[] {
  const rows = db.$client.prepare("select name from pragma_table_info(?)").all(table);
  const names: string[] = [];
  for (const row of rows) {
    if (row && typeof row === "object" && "name" in row && typeof row.name === "string") names.push(row.name);
  }
  return names;
}

function primaryKey(db: AppDatabase, table: string): string[] {
  const rows = db.$client.prepare("select name from pragma_table_info(?) where pk > 0 order by pk").all(table);
  const names: string[] = [];
  for (const row of rows) {
    if (row && typeof row === "object" && "name" in row && typeof row.name === "string") names.push(row.name);
  }
  return names;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("schema migration", () => {
  it("creates every table from section 3 and enforces one machine per user", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-db-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "viate-bot.sqlite"));
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    const rows = db.$client
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all();
    const names: string[] = [];
    for (const row of rows) {
      if (row && typeof row === "object" && "name" in row && typeof row.name === "string") names.push(row.name);
    }
    expect(names.filter((name) => name !== "__drizzle_migrations").sort()).toEqual([
      "app_installs",
      "app_versions",
      "app_visibility",
      "apps",
      "approvals",
      "audit_log",
      "bot_apps",
      "bots",
      "conversations",
      "events",
      "identities",
      "machine_meter",
      "machine_samples",
      "machines",
      "memories",
      "messages",
      "model_credentials",
      "quotas",
      "routine_runs",
      "routines",
      "secrets",
      "sessions",
      "settings",
      "stats_minute",
      "task_steps",
      "tasks",
      "usage_hourly",
      "users",
    ].sort());
    expect(columnNames(db, "sessions")).toContain("idp_refresh_token_enc");
    expect(columnNames(db, "bots")).toContain("model_credential_id");
    expect(primaryKey(db, "identities")).toEqual(["provider", "subject"]);
    expect(primaryKey(db, "usage_hourly")).toEqual(["bot_id", "user_id", "model", "hour"]);
    expect(columnNames(db, "usage_hourly")).toContain("cost_source");
    const viateColumns = db.$client
      .prepare(
        `select m.name as tbl, p.name as col
         from sqlite_master m, pragma_table_info(m.name) p
         where m.type = 'table' and p.name like '%viate%'`,
      )
      .all();
    expect(viateColumns).toEqual([]);
    const now = new Date().toISOString();
    db.$client
      .prepare("insert into users (id, email, name, status, created_at) values (?, ?, ?, ?, ?)")
      .run("user-1", "a@example.com", "A", "active", now);
    const insert = db.$client.prepare(
      `insert into machines (
        id, user_id, state, spec_json, image_version, volume_name, machined_token_enc, created_at, updated_at
      ) values (?, ?, 'stopped', '{}', 'dev', 'vb-home-user-1', 'enc', ?, ?)`,
    );
    insert.run("machine-1", "user-1", now, now);
    expect(() => insert.run("machine-2", "user-1", now, now)).toThrow(/UNIQUE/);
    db.$client.close();
  });
});
