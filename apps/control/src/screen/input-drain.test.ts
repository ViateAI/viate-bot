import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { UserBrowserLock } from "@viate-bot/browser";
import { openDatabase } from "../db/index.js";
import { createScreenInputDrain } from "./input-drain.js";
import { createTakeoverLeases } from "./leases.js";
import { createUserFlights } from "./flight.js";

describe("screen input drain", () => {
  it("bumps the epoch and waits for an in-flight forward before disabling input", async () => {
    const drain = createScreenInputDrain();
    let disabled = 0;
    drain.bind("b", async () => {
      disabled += 1;
    });
    const ticket = drain.begin("b");
    let finished = false;
    const revoking = drain.revoke("b").then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(disabled).toBe(0);
    expect(drain.epoch("b")).not.toBe(ticket);
    drain.end("b");
    await revoking;
    expect(finished).toBe(true);
    expect(disabled).toBe(1);
  });

  it("resolves a released lease only after human input is drained", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-input-drain-"));
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
      const now = new Date().toISOString();
      db.$client.prepare("insert into users (id,email,name,status,created_at) values ('u','u@example.com','U','active',?)").run(now);
      db.$client.prepare("insert into bots (id,user_id,name,model,created_at,updated_at) values ('b','u','B','m',?,?)").run(now, now);
      db.$client.prepare("insert into tasks (id,bot_id,state,trigger) values ('t','b','running','user')").run();
      let releaseDrain = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      let draining = false;
      const leases = createTakeoverLeases({
        db,
        secretWaitMs: 60_000,
        quiesce: async () => {},
        drainInput: async () => {
          draining = true;
          await gate;
        },
      });
      const wait = leases.request({ botId: "b", userId: "u", taskId: "t" });
      for (let i = 0; i < 8 && leases.pending("b").length === 0; i += 1) await Promise.resolve();
      const lease = leases.pending("b")[0]!;
      leases.attach("socket", "b", "session");
      expect(leases.grant(lease.id, "socket", "u", "session")).toBe(true);
      let settled = false;
      void wait.then(() => {
        settled = true;
      });
      expect(leases.release(lease.id, "u", "session")).toBe(true);
      await Promise.resolve();
      expect(draining).toBe(true);
      expect(settled).toBe(false);
      expect(leases.canControl("socket")).toBe(false);
      releaseDrain();
      await wait;
      expect(settled).toBe(true);
    } finally {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drains human input while a browser lock is held, then lets the next holder run", async () => {
    const drain = createScreenInputDrain();
    const lock = new UserBrowserLock();
    const release = Promise.withResolvers<void>();
    const held = lock.run(async () => {
      await release.promise;
    });
    await drain.revoke("bot");
    let ran = false;
    const next = lock.run(async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    release.resolve();
    await held;
    await next;
    expect(ran).toBe(true);
  });

  it("keeps the user paused and refuses a new grant when disarm fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-drain-"));
    const db = openDatabase(join(dir, "db.sqlite"));
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    try {
      const now = new Date().toISOString();
      db.$client.prepare("insert into users (id,email,name,status,created_at) values ('u','u@example.com','U','active',?)").run(now);
      db.$client.prepare("insert into bots (id,user_id,name,model,created_at,updated_at) values ('a','u','A','m',?,?),('b','u','B','m',?,?)").run(now, now, now, now);
      db.$client.prepare("insert into tasks (id,bot_id,state,trigger) values ('t','a','running','user'),('tb','b','running','user')").run();
      const flights = createUserFlights();
      let fail = true;
      const leases = createTakeoverLeases({
        db,
        secretWaitMs: 60_000,
        flights,
        drainInput: async () => {
          if (fail) throw new Error("vnc input=false failed");
        },
        quiesce: async () => {},
      });
      const wait = leases.request({ botId: "a", userId: "u", taskId: "t" });
      const other = leases.request({ botId: "b", userId: "u", taskId: "tb" });
      for (let i = 0; i < 8 && leases.pending("a").length === 0; i += 1) await Promise.resolve();
      for (let i = 0; i < 8 && leases.pending("b").length === 0; i += 1) await Promise.resolve();
      const lease = leases.pending("a")[0]!;
      const otherLease = leases.pending("b")[0]!;
      leases.attach("socket-a", "a", "session");
      leases.attach("socket-b", "b", "session-b");
      expect(leases.grant(lease.id, "socket-a", "u", "session")).toBe(true);
      expect(leases.release(lease.id, "u", "session")).toBe(true);
      await expect(wait).rejects.toThrow(/接管输入未能关闭/);
      expect(flights.paused("u")).toBe(true);
      expect(leases.grant(otherLease.id, "socket-b", "u", "session-b")).toBe(false);
      fail = false;
      expect(leases.release(lease.id, "u", "session")).toBe(true);
      let granted = false;
      for (let i = 0; i < 20 && !granted; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        granted = leases.grant(otherLease.id, "socket-b", "u", "session-b");
      }
      expect(granted).toBe(true);
      expect(leases.release(otherLease.id, "u", "session-b")).toBe(true);
      await other;
      expect(flights.paused("u")).toBe(false);
    } finally {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
