import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { createTakeoverLeases } from "../screen/leases.js";
import { acceptRemoteRisk, markRemoteUncertain, remoteUncertain } from "./remote-uncertain.js";

describe("remote uncertain block", () => {
  it("survives local stop and blocks takeover until a separate accept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-remote-"));
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
      const now = new Date().toISOString();
      db.$client.prepare("insert into users (id,email,name,status,created_at) values ('u','u@example.com','U','active',?)").run(now);
      db.$client.prepare("insert into bots (id,user_id,name,model,created_at,updated_at) values ('b','u','B','m',?,?)").run(now, now);
      db.$client.prepare("insert into tasks (id,bot_id,state,trigger,error) values ('t','b','cancelled','user','remote_unconfirmed')").run();
      markRemoteUncertain(db, { userId: "u", botId: "b", taskId: "t" });
      expect(remoteUncertain(db, "u")).toBe(true);
      const leases = createTakeoverLeases({
        db,
        secretWaitMs: 60_000,
        quiesce: async () => {},
        writesBlocked: (userId) => remoteUncertain(db, userId),
      });
      const waiting = leases.request({ botId: "b", userId: "u", taskId: "t" });
      await Promise.resolve();
      const lease = leases.pending("b")[0];
      expect(lease).toBeTruthy();
      leases.attach("socket", "b", "session");
      expect(leases.grant(lease!.id, "socket", "u", "session")).toBe(false);
      expect(acceptRemoteRisk(db, "u", "t")).toBe(true);
      expect(remoteUncertain(db, "u")).toBe(false);
      expect(db.$client.prepare("select error from tasks where id='t'").get()).toEqual({ error: "remote_unconfirmed" });
      expect(leases.grant(lease!.id, "socket", "u", "session")).toBe(true);
      expect(leases.release(lease!.id, "u", "session")).toBe(true);
      await waiting;
      const audit = db.$client.prepare("select action from audit_log where target='t'").get() as { action: string };
      expect(audit.action).toBe("mcp.remote_uncertain_accepted");
      markRemoteUncertain(db, { userId: "u", botId: "b", taskId: "other" });
      expect(remoteUncertain(db, "u")).toBe(true);
      expect(acceptRemoteRisk(db, "u", "t")).toBe(false);
      expect(leases.grant(lease!.id, "socket", "u", "session")).toBe(false);
      db.$client.prepare(
        "insert into events (id, ts, user_id, bot_id, type, attrs_json) values ('zzz-mark','2026-11-16T00:00:00.000Z','u','b','mcp.remote_unconfirmed','{\"taskId\":\"late\"}')",
      ).run();
      db.$client.prepare(
        "insert into events (id, ts, user_id, type, attrs_json) values ('aaa-accept','2026-11-16T00:00:00.000Z','u','mcp.remote_uncertain_accepted','{\"taskId\":\"late\"}')",
      ).run();
      expect(acceptRemoteRisk(db, "u", "late")).toBe(false);
      expect(remoteUncertain(db, "u")).toBe(true);
      expect(acceptRemoteRisk(db, "u", "other")).toBe(true);
      expect(remoteUncertain(db, "u")).toBe(false);
    } finally {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores the user and task the gate query matches, and ignores a mark with neither", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-remote-"));
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
      const now = new Date().toISOString();
      db.$client.prepare("insert into users (id,email,name,status,created_at) values ('u','u@example.com','U','active',?)").run(now);
      markRemoteUncertain(db, { userId: "u", botId: "b", taskId: "t" });
      expect(db.$client.prepare("select user_id, bot_id, attrs_json from events").get()).toEqual({
        user_id: "u",
        bot_id: "b",
        attrs_json: '{"taskId":"t"}',
      });
      expect(remoteUncertain(db, "u")).toBe(true);
      db.$client.prepare("insert into events (id, ts, type, attrs_json) values ('blank',?,'mcp.remote_unconfirmed','{}')").run(now);
      expect(remoteUncertain(db, "u")).toBe(true);
      expect(remoteUncertain(db, "nobody")).toBe(false);
    } finally {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
