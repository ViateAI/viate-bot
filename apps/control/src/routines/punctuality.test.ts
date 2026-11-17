import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { routineRunRepository } from "../db/routines.js";
import { settingsRepository } from "../db/settings.js";
import { adminOverview } from "../ops/report.js";
import { adminScope, userScope } from "../scope.js";
import { ROUTINE_LOOP_SEEN_KEY, routineOutcome } from "./punctuality.js";
import { claimDue, routineService } from "./service.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function open(path: string): AppDatabase {
  const db = openDatabase(path);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return db;
}

function seed(db: AppDatabase, userId = "u", botId = "b"): void {
  db.$client.prepare("insert into users (id,email,name,status,created_at) values (?,?,?,?, '2025-01-01')").run(userId, `${userId}@example.com`, userId, "active");
  db.$client.prepare("insert into bots (id,user_id,name,model,created_at,updated_at) values (?,?,?,?, '2025-01-01','2025-01-01')").run(botId, userId, botId, "m");
  db.$client.prepare("insert into quotas (user_id,max_bots,spec_json,max_concurrent_tasks,max_routines) values (?,1,'{}',1,4)").run(userId);
}

const start = new Date("2025-01-01T00:00:00.000Z");
const later = new Date("2025-01-01T00:05:30.000Z");

describe("routine punctuality", () => {
  it("keeps downtime misses after the database is reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-punctual-"));
    dirs.push(dir);
    const path = join(dir, "test.sqlite");
    const db = open(path);
    seed(db);
    const service = routineService(db);
    const id = service.propose("u", "b", { cron: "* * * * *", timezone: "UTC", prompt: "secret-prompt-value" }, start);
    service.confirm("u", id, start);
    await claimDue(db, later, { userStatus: () => "active" });
    db.$client.close();

    const reopened = open(path);
    const rows = reopened.$client.prepare("select scheduled_at as scheduledAt, state from routine_runs order by scheduled_at").all();
    expect(rows).toEqual([
      { scheduledAt: "2025-01-01T00:01:00.000Z", state: "missed" },
      { scheduledAt: "2025-01-01T00:02:00.000Z", state: "missed" },
      { scheduledAt: "2025-01-01T00:03:00.000Z", state: "missed" },
      { scheduledAt: "2025-01-01T00:04:00.000Z", state: "missed" },
      { scheduledAt: "2025-01-01T00:05:00.000Z", state: "claimed" },
    ]);
    reopened.$client.prepare("insert into tasks (id,bot_id,state,trigger,started_at) values ('late','b','succeeded','routine','2025-01-01T00:08:00.000Z')").run();
    reopened.$client.prepare("update routine_runs set task_id='late' where scheduled_at='2025-01-01T00:05:00.000Z'").run();
    const at = new Date("2025-01-01T00:10:00.000Z");
    const stats = routineRunRepository(reopened).punctuality(userScope("u"), at);
    expect(stats).toEqual({ planned: 5, onTime: 0, late: 1, missed: 4, skipped: 0, onTimeRate: 0 });
    expect(JSON.stringify(adminOverview(reopened, at))).not.toContain("secret-prompt-value");
    expect(adminOverview(reopened, at).routinePunctuality7d.missed).toBe(4);
    reopened.$client.close();
  });

  it("counts a start inside two minutes as on time and excludes skips from the rate", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-punctual-"));
    dirs.push(dir);
    const db = open(join(dir, "test.sqlite"));
    seed(db);
    seed(db, "other", "other-bot");
    db.$client.exec(`
      insert into routines (id,bot_id,cron,timezone,prompt,enabled,state,next_run_at,created_at) values
        ('r','b','0 0 * * *','UTC','secret-prompt-value',1,'active',null,'2025-01-01'),
        ('ro','other-bot','0 0 * * *','UTC','other prompt',1,'active',null,'2025-01-01');
      insert into tasks (id,bot_id,state,trigger,started_at) values
        ('on-time','b','succeeded','routine','2025-01-01T00:01:30.000Z'),
        ('late','b','succeeded','routine','2025-01-01T00:05:00.000Z');
      insert into routine_runs (id,routine_id,task_id,scheduled_at,state,source) values
        ('a','r','on-time','2025-01-01T00:01:00.000Z','claimed','schedule'),
        ('b','r','late','2025-01-01T00:02:00.000Z','claimed','schedule'),
        ('c','r',null,'2025-01-01T00:03:00.000Z','skipped','schedule'),
        ('d','r',null,'2025-01-01T00:04:00.000Z','claimed','schedule'),
        ('e','r',null,'2025-01-01T00:04:30.000Z','claimed','manual'),
        ('f','ro',null,'2025-01-01T00:01:00.000Z','missed','schedule');
    `);
    db.$client.prepare("update routine_runs set error='用户已停用' where id='c'").run();
    const now = new Date("2025-01-01T00:04:20.000Z");
    const repo = routineRunRepository(db);
    expect(repo.punctuality(userScope("u"), now)).toEqual({
      planned: 3, onTime: 1, late: 1, missed: 0, skipped: 1, onTimeRate: 0.5,
    });
    expect(repo.punctuality(userScope("other"), now)).toEqual({
      planned: 1, onTime: 0, late: 0, missed: 1, skipped: 0, onTimeRate: 0,
    });
    expect(repo.punctuality(adminScope("admin"), now).planned).toBe(4);
    const overview = adminOverview(db, now);
    expect(overview.routinePunctuality7d.onTime).toBe(1);
    expect(overview.routinePunctuality7d.missed).toBe(1);
    expect(JSON.stringify(overview)).not.toContain("secret-prompt-value");
    expect(JSON.stringify(overview)).not.toContain("用户已停用");
    db.$client.close();
  });

  it("records an upstream outage as skipped only when the control plane was up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-punctual-"));
    dirs.push(dir);
    const db = open(join(dir, "test.sqlite"));
    seed(db);
    const service = routineService(db);
    const id = service.propose("u", "b", { cron: "* * * * *", timezone: "UTC", prompt: "secret-prompt-value" }, start);
    service.confirm("u", id, start);
    settingsRepository(db).setJson(ROUTINE_LOOP_SEEN_KEY, "2025-01-01T00:04:00.000Z");
    await claimDue(db, new Date("2025-01-01T00:04:30.000Z"), { userStatus: () => "unknown" });
    expect(db.$client.prepare("select count(*) as n from tasks").get()).toEqual({ n: 0 });
    expect(db.$client.prepare("select scheduled_at as scheduledAt, state, error from routine_runs order by scheduled_at").all()).toEqual([
      { scheduledAt: "2025-01-01T00:01:00.000Z", state: "skipped", error: "上游不可用" },
      { scheduledAt: "2025-01-01T00:02:00.000Z", state: "skipped", error: "上游不可用" },
    ]);
    expect((db.$client.prepare("select next_run_at as nextRunAt from routines where id=?").get(id) as { nextRunAt: string }).nextRunAt).toBe("2025-01-01T00:03:00.000Z");
    const covered = routineRunRepository(db).punctuality(userScope("u"), new Date("2025-01-01T00:04:30.000Z"));
    expect(covered).toMatchObject({ planned: 2, skipped: 2, missed: 0, onTimeRate: null });

    db.$client.prepare("delete from routine_runs").run();
    db.$client.prepare("update routines set next_run_at='2025-01-01T00:01:00.000Z' where id=?").run(id);
    db.$client.prepare("delete from settings where key=?").run(ROUTINE_LOOP_SEEN_KEY);
    await claimDue(db, later, { userStatus: () => "unknown" });
    const missed = db.$client.prepare("select state from routine_runs").all() as Array<{ state: string }>;
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((row) => row.state === "missed")).toBe(true);
    expect(db.$client.prepare("select count(*) as n from tasks").get()).toEqual({ n: 0 });
    db.$client.close();
  });

  it("records an offline desktop client as skipped and punctuality counts that skip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-punctual-"));
    dirs.push(dir);
    const db = open(join(dir, "test.sqlite"));
    seed(db);
    const service = routineService(db);
    const id = service.propose("u", "b", { cron: "* * * * *", timezone: "UTC", prompt: "secret-prompt-value" }, start);
    service.confirm("u", id, start);
    await claimDue(db, later, { userStatus: () => "active", egressPaused: () => true });
    const rows = db.$client.prepare("select state, error from routine_runs").all() as Array<{ state: string; error: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.state === "skipped" && row.error === "桌面客户端离线")).toBe(true);
    expect(routineOutcome({ state: "skipped", scheduledAt: "2025-01-01T00:01:00.000Z", startedAt: null })).toBe("skipped");
    const stats = routineRunRepository(db).punctuality(userScope("u"), later);
    expect(stats.skipped).toBe(rows.length);
    expect(stats.missed).toBe(0);
    expect(JSON.stringify(stats)).not.toContain("secret-prompt-value");
    db.$client.close();
  });
});
