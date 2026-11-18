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
  it("preserves private versions and pending reviews across migration restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-db-"));
    dirs.push(dir);
    const path = join(dir, "restart.sqlite");
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    const db = openDatabase(path);
    migrate(db, { migrationsFolder });
    db.$client.exec(`insert into users(id,email,name,status,created_at) values ('owner','o@example.com','Owner','active','now');
      insert into apps(id,name,source,owner_user_id,created_at) values ('private','notes','user','owner','now');
      insert into app_versions(id,app_id,version,manifest_json,archive_path,sha256,status,created_at) values ('version','private','1.0.0','{}','/tmp/notes.tar.zst','hash','active','now');
      insert into app_publish_requests(id,app_version_id,requester_user_id,note,state,created_at) values ('request','version','owner','please publish','pending','now');`);
    db.$client.close();
    const reopened = openDatabase(path);
    try {
      migrate(reopened, { migrationsFolder });
      migrate(reopened, { migrationsFolder });
      expect(reopened.$client.prepare(`select a.source,a.owner_user_id,v.version,v.sha256,r.state,r.note
        from apps a join app_versions v on v.app_id=a.id join app_publish_requests r on r.app_version_id=v.id`).get()).toEqual({
        source: "user", owner_user_id: "owner", version: "1.0.0", sha256: "hash", state: "pending", note: "please publish",
      });
    } finally {
      reopened.$client.close();
    }
  });

  it("upgrades existing user and quota rows with detail off and budget inheritance without changing routine quota", () => {
    const sqlite = new Database(":memory:");
    for (const name of ["0000_init.sql", "0001_session_validation.sql", "0002_memories_fts.sql", "0003_conversation_summary.sql", "0004_m2.sql", "0005_routine_punctuality.sql", "0006_bot_install.sql"]) applyMigration(sqlite, name);
    sqlite.exec("insert into users(id,email,name,status,is_admin,created_at) values ('u','u@x','U','active',1,'now'); insert into quotas(user_id,max_bots,spec_json,max_concurrent_tasks,max_routines) values ('u',4,'{}',2,0);");
    applyMigration(sqlite, "0007_polish.sql");
    expect(sqlite.prepare("select show_process, is_admin from users where id='u'").get()).toEqual({ show_process: 0, is_admin: 1 });
    expect(sqlite.prepare("select task_token_budget,max_routines,max_bots from quotas where user_id='u'").get()).toEqual({ task_token_budget: null, max_routines: 0, max_bots: 4 });
    sqlite.close();
  });

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
      "app_publish_requests",
      "app_versions",
      "app_visibility",
      "apps",
      "approvals",
      "approval_rules",
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
    expect(columnNames(db, "bots")).toContain("bio");
    expect(columnNames(db, "users")).toContain("show_process");
    expect(columnNames(db, "quotas")).toContain("task_token_budget");
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

  it("creates app_publish_requests for per-version publish review", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-db-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "viate-bot.sqlite"));
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    expect(columnNames(db, "app_publish_requests")).toEqual([
      "id",
      "app_version_id",
      "requester_user_id",
      "bot_id",
      "task_id",
      "note",
      "state",
      "reason",
      "reviewer_user_id",
      "created_at",
      "decided_at",
    ]);
    db.$client.close();
  });
});

function applyMigration(sqlite: Database.Database, name: string): void {
  const sql = readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) sqlite.exec(trimmed);
  }
}
