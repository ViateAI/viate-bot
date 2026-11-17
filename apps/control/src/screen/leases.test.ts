import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { createTakeoverLeases } from "./leases.js";
import { RfbClientFilter } from "./rfb.js";

describe("RFB client filter", () => {
  it("drops a negative-length clipboard frame and still forwards the update request", () => {
    const filter = new RfbClientFilter();
    const update = Buffer.alloc(10);
    update[0] = 3;
    const extended = Buffer.alloc(16);
    extended[0] = 6;
    extended.writeInt32BE(-8, 4);
    expect(filter.push(Buffer.concat([update, extended]), () => false)).toEqual([update]);
    expect(filter.push(extended, () => true)).toEqual([extended]);
  });
});

describe("takeover lease", () => {
  it("filters input and converges on release, disconnect, stop, and restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-screen-"));
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
      const now = new Date().toISOString();
      db.$client.prepare("insert into users (id,email,name,status,created_at) values ('u','u@example.com','U','active',?)").run(now);
      db.$client.prepare("insert into bots (id,user_id,name,model,created_at,updated_at) values ('b','u','B','m',?,?)").run(now, now);
      db.$client.prepare("insert into tasks (id,bot_id,state,trigger) values ('t','b','running','user')").run();
      let quiesced = false;
      const leases = createTakeoverLeases({ db, secretWaitMs: 60_000, quiesce: async () => { quiesced = true; } });
      const wait = leases.request({ botId: "b", userId: "u", taskId: "t" });
      await Promise.resolve();
      expect(quiesced).toBe(true);
      const lease = leases.pending("b")[0]!;
      leases.attach("socket", "b", "session");
      const pointer = Buffer.from([5, 1, 0, 1, 0, 2]);
      const filter = new RfbClientFilter();
      expect(filter.push(pointer, () => leases.canControl("socket"))).toEqual([]);
      expect(leases.grant(lease.id, "socket", "other", "session")).toBe(false);
      expect(leases.grant(lease.id, "socket", "u", "session")).toBe(true);
      expect(filter.push(pointer, () => leases.canControl("socket"))).toEqual([pointer]);
      expect(leases.release(lease.id, "u", "session")).toBe(true);
      await wait;
      const wait2 = leases.request({ botId: "b", userId: "u", taskId: "t" });
      await Promise.resolve();
      const lease2 = leases.pending("b")[0]!;
      expect(leases.grant(lease2.id, "socket", "u", "session")).toBe(true);
      leases.detach("socket");
      await expect(wait2).rejects.toThrow();
      expect(leases.isActive("b")).toBe(false);
      const wait3 = leases.request({ botId: "b", userId: "u", taskId: "t" });
      await Promise.resolve();
      leases.stop("b");
      await expect(wait3).rejects.toThrow();
      db.$client.prepare("update tasks set state='waiting_takeover' where id='t'").run();
      db.$client.prepare("insert into takeover_leases (id,bot_id,user_id,task_id,session_id,state,created_at,updated_at) values ('old','b','u','t','session','active',?,?)").run(now, now);
      const restarted = createTakeoverLeases({ db, secretWaitMs: 60_000, quiesce: async () => {} });
      restarted.arm();
      expect(restarted.isActive("b")).toBe(false);
      expect(restarted.pending("b")).toHaveLength(1);
    } finally {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
