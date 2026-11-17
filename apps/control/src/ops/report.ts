import { timingSafeEqual } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/index.js";
import { events, machines, quotas, tasks, usageHourly } from "../db/schema.js";
import { M2_EVENTS } from "../m2/events.js";

export function authorizeMetrics(header: string | undefined, token: string): boolean {
  if (token.length === 0 || header === undefined) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function renderMetrics(snapshot: {
  machinesRunning: number;
  tasksSucceeded: number;
  tasksFailed: number;
  approvalsPending: number;
}): string {
  return [
    "# HELP viate_bot_machines_running Machines whose desired state is running.",
    "# TYPE viate_bot_machines_running gauge",
    `viate_bot_machines_running ${snapshot.machinesRunning}`,
    "# HELP viate_bot_tasks_succeeded Tasks that succeeded in the collected window.",
    "# TYPE viate_bot_tasks_succeeded gauge",
    `viate_bot_tasks_succeeded ${snapshot.tasksSucceeded}`,
    "# HELP viate_bot_tasks_failed Tasks that failed in the collected window.",
    "# TYPE viate_bot_tasks_failed gauge",
    `viate_bot_tasks_failed ${snapshot.tasksFailed}`,
    "# HELP viate_bot_approvals_pending Approvals still waiting.",
    "# TYPE viate_bot_approvals_pending gauge",
    `viate_bot_approvals_pending ${snapshot.approvalsPending}`,
    "",
  ].join("\n");
}

export interface Overview {
  provisionedUsers: number;
  activeUsers1d: number;
  machinesRunning: number;
  tasksToday: number;
  tasksSucceededToday: number;
  costUsdToday: number;
  anomalies: Array<{ machineId: string; kind: "heartbeat" | "disk" | "error" }>;
  failureClasses: Array<{ errorClass: string; count: number }>;
  activeTrend: Array<{ day: string; count: number }>;
  alerts: Array<{ kind: "machine" | "routine"; target: string }>;
}

export function adminOverview(db: AppDatabase, now: Date): Overview {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const provisioned = db.select({ n: sql<number>`count(*)` }).from(quotas).get();
  const active = db
    .select({ n: sql<number>`count(distinct ${events.userId})` })
    .from(events)
    .where(and(gte(events.ts, dayAgo), sql`${events.userId} is not null`))
    .get();
  const running = db.select({ n: sql<number>`count(*)` }).from(machines).where(eq(machines.state, "running")).get();
  const taskRows = db
    .select({ state: tasks.state, n: sql<number>`count(*)` })
    .from(tasks)
    .where(gte(tasks.startedAt, dayStart))
    .groupBy(tasks.state)
    .all();
  let tasksToday = 0;
  let tasksSucceededToday = 0;
  for (const row of taskRows) {
    tasksToday += Number(row.n);
    if (row.state === "succeeded") tasksSucceededToday += Number(row.n);
  }
  const cost = db
    .select({ n: sql<number>`coalesce(sum(cast(${usageHourly.costUsd} as real)), 0)` })
    .from(usageHourly)
    .where(gte(usageHourly.hour, dayStart.slice(0, 13)))
    .get();
  const anomalies = machineAnomalies(db, now);
  return {
    provisionedUsers: Number(provisioned?.n ?? 0),
    activeUsers1d: Number(active?.n ?? 0),
    machinesRunning: Number(running?.n ?? 0),
    tasksToday,
    tasksSucceededToday,
    costUsdToday: Number(cost?.n ?? 0),
    anomalies,
    failureClasses: failureClasses(db, dayAgo),
    activeTrend: activeTrend(db, now),
    alerts: [
      ...anomalies.map((item) => ({ kind: "machine" as const, target: item.machineId })),
      ...routineAlerts(db, dayAgo),
    ],
  };
}

export function metricsSnapshot(db: AppDatabase, now: Date): {
  machinesRunning: number;
  tasksSucceeded: number;
  tasksFailed: number;
  approvalsPending: number;
} {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const running = db.select({ n: sql<number>`count(*)` }).from(machines).where(eq(machines.state, "running")).get();
  const succeeded = db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(and(gte(tasks.startedAt, dayStart), eq(tasks.state, "succeeded")))
    .get();
  const failed = db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(and(gte(tasks.startedAt, dayStart), eq(tasks.state, "failed")))
    .get();
  const pending = db.$client.prepare("select count(*) as n from approvals where state = 'pending'").get() as { n: number } | undefined;
  return {
    machinesRunning: Number(running?.n ?? 0),
    tasksSucceeded: Number(succeeded?.n ?? 0),
    tasksFailed: Number(failed?.n ?? 0),
    approvalsPending: Number(pending?.n ?? 0),
  };
}

function machineAnomalies(db: AppDatabase, now: Date): Overview["anomalies"] {
  const found: Overview["anomalies"] = [];
  for (const machine of db.select().from(machines).all()) {
    if (machine.state === "error") found.push({ machineId: machine.id, kind: "error" });
    if (machine.state === "running") {
      const beat = machine.lastHeartbeatAt ? Date.parse(machine.lastHeartbeatAt) : Number.NaN;
      if (!Number.isFinite(beat) || now.getTime() - beat > 3 * 60 * 1000) {
        found.push({ machineId: machine.id, kind: "heartbeat" });
      }
    }
  }
  const latest = db.$client
    .prepare(
      `select s.machine_id as machineId, s.disk_mb as diskMb, m.spec_json as specJson
       from machine_samples s
       join machines m on m.id = s.machine_id
       where s.ts = (select max(ts) from machine_samples where machine_id = s.machine_id)`,
    )
    .all() as Array<{ machineId: string; diskMb: number; specJson: string }>;
  for (const row of latest) {
    const spec = parseSpec(row.specJson);
    if (spec && row.diskMb > spec.diskGb * 1024 * 0.9) found.push({ machineId: row.machineId, kind: "disk" });
  }
  return found;
}

function routineAlerts(db: AppDatabase, since: string): Array<{ kind: "routine"; target: string }> {
  const rows = db.$client.prepare(
    `select type, attrs_json as attrsJson from events
     where ts>=? and type in ('routine.failed','task.finished')
     order by ts, rowid`,
  ).all(since) as Array<{ type: string; attrsJson: string }>;
  const routineOfTask = db.$client.prepare(
    `select r.routine_id as routineId from routine_runs r where r.task_id=? limit 1`,
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    const attrs = parseObject(row.attrsJson);
    const routineId = typeof attrs.routineId === "string"
      ? attrs.routineId
      : typeof attrs.taskId === "string"
        ? (routineOfTask.get(attrs.taskId) as { routineId: string } | undefined)?.routineId
        : undefined;
    if (!routineId) continue;
    if (row.type === M2_EVENTS.taskFinished) {
      counts.set(routineId, 0);
      continue;
    }
    counts.set(routineId, (counts.get(routineId) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= 3).map(([target]) => ({ kind: "routine", target }));
}

function failureClasses(db: AppDatabase, since: string): Array<{ errorClass: string; count: number }> {
  const rows = db
    .select({ attrsJson: events.attrsJson })
    .from(events)
    .where(and(eq(events.type, M2_EVENTS.taskFailed), gte(events.ts, since)))
    .all();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const attrs = parseObject(row.attrsJson);
    const name = typeof attrs.errorClass === "string" ? attrs.errorClass : "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([errorClass, count]) => ({ errorClass, count }))
    .sort((a, b) => b.count - a.count);
}

function activeTrend(db: AppDatabase, now: Date): Array<{ day: string; count: number }> {
  const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.$client
    .prepare(
      `select substr(ts, 1, 10) as day, count(distinct user_id) as count
       from events
       where ts >= ? and user_id is not null
       group by substr(ts, 1, 10)
       order by day`,
    )
    .all(start) as Array<{ day: string; count: number }>;
  return rows.map((row) => ({ day: row.day, count: Number(row.count) }));
}

function parseSpec(json: string): { diskGb: number } | undefined {
  try {
    const value = JSON.parse(json) as { diskGb?: unknown };
    if (typeof value.diskGb !== "number") return undefined;
    return { diskGb: value.diskGb };
  } catch {
    return undefined;
  }
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}
