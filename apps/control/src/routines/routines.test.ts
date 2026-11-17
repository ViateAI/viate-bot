import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { authenticated } from "../auth.js";
import { openDatabase } from "../db/index.js";
import { notifyTaskSettled, registerNotificationRoutes } from "../notify/index.js";
import { nextCron } from "./cron.js";
import { registerRoutineRoutes } from "./routes.js";
import { claimDue, hasRoutineSoon, routineService, usersToWake } from "./service.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vb-routines-")); dirs.push(dir);
  const db = openDatabase(join(dir, "test.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const sql = db.$client;
  sql.prepare("insert into users (id,email,name,status,created_at) values ('u','u@example.com','U','active','2025-01-01')").run();
  sql.prepare("insert into bots (id,user_id,name,model,created_at,updated_at) values ('b','u','B','m','2025-01-01','2025-01-01')").run();
  sql.prepare("insert into quotas (user_id,max_bots,spec_json,max_concurrent_tasks,max_routines) values ('u',1,'{}',1,1)").run();
  return db;
}
const start = new Date("2025-01-01T00:00:00.000Z");
const active = { userStatus: () => "active" };

describe("routines", () => {
  it("interprets timezone, DST and Vixie day OR, rejecting invalid expressions", () => {
    expect(nextCron("0 9 * * *", "Asia/Shanghai", start).toISOString()).toBe("2025-01-01T01:00:00.000Z");
    expect(nextCron("30 2 * * *", "America/New_York", new Date("2025-03-09T05:00:00Z")).toISOString()).toBe("2025-03-10T06:30:00.000Z");
    expect(nextCron("0 0 13 * 1", "UTC", start).toISOString()).toBe("2025-01-06T00:00:00.000Z");
    expect(() => nextCron("@daily", "UTC", start)).toThrow();
    expect(() => nextCron("0 0 * * *", "Not/AZone", start)).toThrow();
  });

  it("treats only an exact star as unrestricted and ORs restricted day fields", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    expect(nextCron("0 0 */2 * *", "UTC", after).toISOString()).toBe("2026-01-03T00:00:00.000Z");
    const firstOrMonday = nextCron("0 0 1 * 1", "UTC", after);
    expect(firstOrMonday.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(firstOrMonday.getUTCDate()).not.toBe(1);
    const monday = nextCron("0 0 * * 1", "UTC", after);
    expect(monday.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(monday.getUTCDay()).toBe(1);
  });

  it("requires confirmation, enforces quota and coalesces, retries and skips safely", async () => {
    const db = fixture(); const service = routineService(db);
    const id = service.propose("u", "b", { cron: "* * * * *", timezone: "UTC", prompt: "private prompt" }, start);
    const later = new Date("2025-01-01T00:05:30Z");
    expect(await claimDue(db, later, active)).toEqual([]);
    service.confirm("u", id, start);
    const second = service.propose("u", "b", { cron: "* * * * *", timezone: "UTC", prompt: "second" }, start);
    expect(() => service.confirm("u", second, start)).toThrow(/配额/);
    expect(usersToWake(db, start)).toEqual(["u"]);
    expect(hasRoutineSoon(db, "u", start)).toBe(true);
    const [work] = await claimDue(db, later, active);
    expect(work).toMatchObject({ routineId: id, scheduledAt: "2025-01-01T00:05:00.000Z", missedCount: 5 });
    expect((await claimDue(db, later, active))[0]?.runId).toBe(work!.runId);
    expect(() => db.$client.prepare("insert into routine_runs (id,routine_id,scheduled_at,state) values ('duplicate',?,?,'claimed')").run(id, work!.scheduledAt)).toThrow(/UNIQUE/);
    db.$client.prepare("insert into tasks (id,bot_id,state,trigger) values ('task','b','running','routine')").run();
    expect(service.attachTask(work!.runId, "task")).toBe(true);
    expect(await claimDue(db, new Date("2025-01-01T00:08:00Z"), active)).toEqual([]);
    expect((db.$client.prepare("select next_run_at from routines where id=?").get(id) as { next_run_at: string }).next_run_at).toBe("2025-01-01T00:06:00.000Z");
    db.$client.prepare("update tasks set state='succeeded' where id='task'").run();
    await claimDue(db, new Date("2025-01-01T00:08:00Z"), { userStatus: () => { throw new Error("offline"); } });
    expect((db.$client.prepare("select next_run_at from routines where id=?").get(id) as { next_run_at: string }).next_run_at).toBe("2025-01-01T00:06:00.000Z");
    expect(await claimDue(db, new Date("2025-01-01T00:08:00Z"), { userStatus: () => "disabled" })).toEqual([]);
    expect(db.$client.prepare("select state,error from routine_runs where scheduled_at='2025-01-01T00:08:00.000Z'").get()).toEqual({ state: "skipped", error: "用户已停用" });
    service.pause("u", id, true, later);
    expect(await claimDue(db, new Date("2025-01-01T00:10:00Z"), active)).toEqual([]);
    expect(() => service.confirm("u", second, start)).toThrow(/配额/);
    service.pause("u", id, false, new Date("2025-01-01T00:10:00Z"));
    expect((db.$client.prepare("select enabled from routines where id=?").get(id) as { enabled: number }).enabled).toBe(1);
    const manual = service.manual("u", id, new Date("2025-01-01T00:09:00Z"));
    service.remove("u", id);
    expect(await claimDue(db, new Date("2025-01-01T00:12:00Z"), active)).toEqual([]);
    expect(service.history("u", id)).toHaveLength(3);
    expect(manual.routineId).toBe(id);
    notifyTaskSettled(db, { userId: "u", botId: "b", taskId: "task", outcome: "succeeded" });
    expect(JSON.stringify(db.$client.prepare("select * from notifications").all())).not.toContain("private prompt");
    expect(JSON.stringify(db.$client.prepare("select * from events").all())).not.toContain("private prompt");
    db.$client.close();
  });

  it("enqueues a manual run through the owner-scoped route", async () => {
    const db = fixture(); const service = routineService(db);
    const id = service.propose("u", "b", { cron: "* * * * *", timezone: "UTC", prompt: "work" }, start);
    service.confirm("u", id, start); service.pause("u", id, true, start);
    const app = Fastify();
    app.addHook("preHandler", async (request) => { authenticated.set(request, { user: { id: "u" } } as never); });
    registerRoutineRoutes(app, { db, enqueue: (work) => {
      db.$client.prepare("insert into tasks (id,bot_id,state,trigger,routine_run_id) values ('route-task','b','queued','routine',?)").run(work.runId);
      return "route-task";
    } });
    const response = await app.inject({ method: "POST", url: `/api/routines/${id}/run` });
    expect(response.statusCode).toBe(200);
    expect((service.history("u", id)[0] as { taskId: string }).taskId).toBe("route-task");
    await app.close(); db.$client.close();
  });

  it("lists an unread notice without the prompt and clears it", async () => {
    const db = fixture();
    db.$client.prepare("insert into tasks (id,bot_id,state,trigger) values ('task','b','succeeded','user')").run();
    notifyTaskSettled(db, { userId: "u", botId: "b", taskId: "task", outcome: "needs_user" });
    const app = Fastify();
    app.addHook("preHandler", async (request) => { authenticated.set(request, { user: { id: "u" } } as never); });
    registerNotificationRoutes(app, { db });
    const listed = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { notifications: Array<{ id: string; kind: string }> };
    expect(body.notifications.map((item) => item.kind)).toEqual(["needs_user"]);
    expect(JSON.stringify(body)).not.toContain("private prompt");
    const read = await app.inject({ method: "POST", url: `/api/notifications/${body.notifications[0]!.id}/read` });
    expect(read.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json()).toEqual({ notifications: [] });
    await app.close();
    db.$client.close();
  });
});
