import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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
    expect(names).toContain("memories_fts");
    expect(names.filter((name) => name !== "__drizzle_migrations" && !name.startsWith("memories_fts")).sort()).toEqual([
      "app_installs",
      "app_push_targets",
      "app_pushes",
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
      "notifications",
      "quotas",
      "routine_runs",
      "routines",
      "secrets",
      "sessions",
      "settings",
      "stats_minute",
      "task_steps",
      "tasks",
      "takeover_leases",
      "usage_hourly",
      "users",
    ].sort());
    expect(columnNames(db, "sessions")).toEqual(
      expect.arrayContaining(["idp_refresh_token_enc", "token_hash", "last_validated_at"]),
    );
    expect(columnNames(db, "bots")).toContain("model_credential_id");
    expect(primaryKey(db, "identities")).toEqual(["provider", "subject"]);
    expect(primaryKey(db, "usage_hourly")).toEqual(["bot_id", "user_id", "model", "hour"]);
    expect(columnNames(db, "usage_hourly")).toContain("cost_source");
    expect(columnNames(db, "routines")).toContain("state");
    expect(columnNames(db, "approvals")).toEqual(expect.arrayContaining(["args_hash", "consumed_at"]));
    expect(columnNames(db, "app_versions")).toContain("recommended");
    expect(columnNames(db, "app_installs")).toEqual(expect.arrayContaining(["installed_by_bot_id", "installed_by_bot_name"]));
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

  it("drops legacy sessions before the token hash unique index", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    applyMigration(sqlite, "0000_init.sql");
    const now = new Date().toISOString();
    sqlite
      .prepare("insert into users (id, email, name, status, created_at) values (?, ?, ?, ?, ?)")
      .run("user-1", "a@example.com", "A", "active", now);
    const insertSession = sqlite.prepare(
      `insert into sessions (id, user_id, csrf, idp_refresh_token_enc, expires_at, last_seen_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSession.run("s1", "user-1", "csrf-1", "enc", now, now, now);
    insertSession.run("s2", "user-1", "csrf-2", "enc", now, now, now);
    applyMigration(sqlite, "0001_session_validation.sql");
    expect(sqlite.prepare("select count(*) from sessions").pluck().get()).toBe(0);
    expect(
      sqlite
        .prepare("select name from sqlite_master where type = 'index' and name = 'sessions_token_hash_unique'")
        .pluck()
        .get(),
    ).toBe("sessions_token_hash_unique");
    const insertHashed = sqlite.prepare(
      `insert into sessions (
        id, user_id, token_hash, csrf, idp_refresh_token_enc, expires_at, last_seen_at, last_validated_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertHashed.run("s3", "user-1", "hash-a", "c", "enc", now, now, now, now);
    insertHashed.run("s4", "user-1", "hash-b", "c", "enc", now, now, now, now);
    expect(() => insertHashed.run("s5", "user-1", "hash-a", "c", "enc", now, now, now, now)).toThrow(/UNIQUE/);
    sqlite.close();
  });
});

function applyMigration(sqlite: Database.Database, name: string): void {
  const sql = readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) sqlite.exec(trimmed);
  }
}
