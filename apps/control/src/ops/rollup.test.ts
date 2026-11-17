import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { events, machineSamples, machines, quotas, statsMinute, users } from "../db/schema.js";
import { M2_EVENTS } from "../m2/events.js";
import { registerOpsRoutes } from "./routes.js";
import { adminOverview } from "./report.js";
import { MinuteAccumulator, applyRetention, emitOps, flushMinutes } from "./rollup.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "vb-ops-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return db;
}

describe("ops rollup", () => {
  it("drops message text and secrets, then deletes only expired rows", () => {
    const db = database();
    const now = new Date("2026-06-15T12:00:00.000Z");
    const acc = new MinuteAccumulator();
    emitOps(db, acc, {
      id: "evt-1",
      ts: now.toISOString(),
      type: M2_EVENTS.taskFailed,
      userId: null,
      attrs: { errorClass: "rate_limit", prompt: "把密码发到 secret-value", secret: "secret-value", text: "对话正文" },
    });
    emitOps(db, acc, {
      id: "evt-old",
      ts: "2026-04-01T00:00:00.000Z",
      type: M2_EVENTS.taskFailed,
      attrs: { errorClass: "old" },
    });
    expect(flushMinutes(db, acc)).toBe(2);
    const stored = db.select().from(events).all();
    expect(JSON.stringify(stored)).not.toContain("secret-value");
    expect(JSON.stringify(stored)).not.toContain("对话正文");
    expect(stored.find((row) => row.id === "evt-1")?.attrsJson).toContain("rate_limit");

    db.insert(statsMinute)
      .values({ bucket: "2024-01-01T00:00", metric: "task.failed", dimsKey: "_", valueSum: 1, valueCount: 1, valueMax: 1 })
      .run();
    const userId = "user-1";
    db.insert(users).values({ id: userId, email: "a@example.com", name: "A", status: "active", createdAt: now.toISOString() }).run();
    db.insert(quotas).values({ userId, maxBots: 1, specJson: "{}", maxConcurrentTasks: 1, maxRoutines: 1 }).run();
    db.insert(machines)
      .values({
        id: "machine-1",
        userId,
        state: "running",
        specJson: JSON.stringify({ cpu: 1, memMb: 512, diskGb: 1 }),
        imageVersion: "dev",
        volumeName: "vb-home-user-1",
        machinedTokenEnc: "enc",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastHeartbeatAt: "2026-06-15T11:00:00.000Z",
      })
      .run();
    db.insert(machineSamples)
      .values({
        machineId: "machine-1",
        ts: "2026-06-01T00:00:00.000Z",
        cpuPct: 1,
        memMb: 1,
        diskMb: 2000,
        netRx: 0,
        netTx: 0,
      })
      .run();
    db.insert(machineSamples)
      .values({
        machineId: "machine-1",
        ts: now.toISOString(),
        cpuPct: 10,
        memMb: 10,
        diskMb: 100,
        netRx: 0,
        netTx: 0,
      })
      .run();

    const removed = applyRetention(db, now);
    expect(removed.events).toBe(1);
    expect(removed.stats).toBe(1);
    expect(removed.samples).toBe(1);
    expect(db.select().from(events).all().map((row) => row.id)).toEqual(["evt-1"]);
    expect(db.select().from(machineSamples).all()).toHaveLength(1);

    const overview = adminOverview(db, now);
    expect(JSON.stringify(overview)).not.toContain("secret-value");
    expect(overview.anomalies).toContainEqual({ machineId: "machine-1", kind: "heartbeat" });
    expect(overview.failureClasses).toEqual([{ errorClass: "rate_limit", count: 1 }]);
    expect(overview.provisionedUsers).toBe(1);
    db.$client.close();
  });

  it("rejects a Prometheus scrape without the configured token", async () => {
    const db = database();
    const app = Fastify({ logger: false });
    registerOpsRoutes(app, { db, now: () => new Date("2026-06-15T12:00:00.000Z"), metricsToken: "metrics-token" });
    const denied = await app.inject({ method: "GET", url: "/metrics" });
    const wrong = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer other-token" } });
    const ok = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer metrics-token" } });
    expect(denied.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("viate_bot_machines_running 0");
    expect(ok.body).toContain("viate_bot_tasks_succeeded 0");
    expect(ok.body).toContain("viate_bot_tasks_failed 0");
    expect(ok.body).toContain("viate_bot_approvals_pending 0");
    expect(ok.body).not.toContain("metrics-token");
    const overview = await app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(overview.statusCode).toBe(404);
    await app.close();
    db.$client.close();
  });

  it("raises a routine alert after three failures and ignores two", () => {
    const db = database();
    const now = new Date("2026-06-15T12:00:00.000Z");
    const acc = new MinuteAccumulator();
    for (let index = 0; index < 3; index += 1) {
      emitOps(db, acc, {
        id: `fail-${index}`,
        ts: now.toISOString(),
        type: M2_EVENTS.routineFailed,
        attrs: { routineId: "routine-1", prompt: "每天把邮件发给客户" },
      });
    }
    emitOps(db, acc, {
      id: "fail-other",
      ts: now.toISOString(),
      type: M2_EVENTS.routineFailed,
      attrs: { routineId: "routine-2" },
    });
    const overview = adminOverview(db, now);
    expect(overview.alerts).toEqual([{ kind: "routine", target: "routine-1" }]);
    expect(JSON.stringify(overview)).not.toContain("邮件");
    db.$client.close();
  });

  it("does not alert when a success resets the consecutive failure streak", () => {
    const db = database();
    const now = new Date("2026-06-15T12:00:00.000Z");
    const acc = new MinuteAccumulator();
    const sequence = ["routine.failed", "task.finished", "routine.failed", "task.finished", "routine.failed"] as const;
    sequence.forEach((type, index) => {
      emitOps(db, acc, {
        id: `mix-${index}`,
        ts: new Date(now.getTime() + index * 1000).toISOString(),
        type,
        attrs: { routineId: "routine-1", taskId: `task-${index}` },
      });
    });
    expect(adminOverview(db, now).alerts).toEqual([]);
    db.$client.close();
  });
});
