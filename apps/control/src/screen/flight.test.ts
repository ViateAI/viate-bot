import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { UserBrowserLock } from "@viate-bot/browser";
import { openDatabase } from "../db/index.js";
import { createUserFlights, trackExecution } from "./flight.js";
import { createTakeoverLeases } from "./leases.js";

function shellTool(run: (signal?: AbortSignal) => Promise<void>): AgentTool {
  return effectTool("shell_exec", run);
}

function effectTool(name: string, run: (signal?: AbortSignal) => Promise<void> | void): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute: async (_id, _params, signal) => {
      await run(signal);
      return { content: [{ type: "text", text: "ran" }], details: {} };
    },
  };
}

describe("takeover flight barrier", () => {
  it("does not grant input until the in-flight tool leaves, then blocks only that user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-flight-"));
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
      const now = new Date().toISOString();
      db.$client.prepare("insert into users (id,email,name,status,created_at) values ('u','u@example.com','U','active',?),('v','v@example.com','V','active',?)").run(now, now);
      db.$client.prepare("insert into bots (id,user_id,name,model,created_at,updated_at) values ('b','u','B','m',?,?),('b2','u','B2','m',?,?),('c','v','C','m',?,?)").run(now, now, now, now, now, now);
      db.$client.prepare("insert into tasks (id,bot_id,state,trigger) values ('t','b','running','user')").run();
      const flights = createUserFlights();
      const leases = createTakeoverLeases({
        db,
        secretWaitMs: 60_000,
        flights,
        quiesce: async (botId) => {
          const row = db.$client.prepare("select user_id as userId from bots where id=?").get(botId) as { userId: string };
          await flights.barrier(row.userId);
        },
      });
      const held = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      let ran = 0;
      const sameUser = trackExecution("u", shellTool(async () => {
        started.resolve();
        await held.promise;
        ran += 1;
      }), flights);
      const otherUser = trackExecution("v", shellTool(async () => {
        ran += 10;
      }), flights);
      const running = sameUser.execute("1", {});
      await started.promise;
      expect(flights.inflight("u")).toBe(1);
      const takeover = leases.request({ botId: "b", userId: "u", taskId: "t" });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(leases.pending("b")).toEqual([]);
      leases.attach("socket", "b", "session");
      expect(leases.grant("missing", "socket", "u", "session")).toBe(false);
      expect(flights.tryEnter("u")).toBe(false);
      expect(flights.tryEnter("v")).toBe(true);
      flights.leave("v");
      await expect(sameUser.execute("2", {})).rejects.toThrow("用户正在接管");
      expect(ran).toBe(0);
      held.resolve();
      await running;
      expect(ran).toBe(1);
      for (let i = 0; i < 8 && leases.pending("b").length === 0; i += 1) await Promise.resolve();
      const lease = leases.pending("b")[0];
      expect(lease?.state).toBe("requested");
      expect(leases.grant(lease!.id, "socket", "u", "session")).toBe(true);
      expect(leases.canControl("socket")).toBe(true);
      await expect(trackExecution("u", shellTool(async () => { ran += 1; }), flights).execute("3", {})).rejects.toThrow("用户正在接管");
      await otherUser.execute("4", {});
      expect(ran).toBe(11);
      expect(leases.release(lease!.id, "u", "session")).toBe(true);
      expect(leases.release(lease!.id, "u", "session")).toBe(false);
      await takeover;
      expect(flights.paused("u")).toBe(false);
      expect(flights.tryEnter("u")).toBe(true);
      flights.leave("u");
      const again = leases.request({ botId: "b2", userId: "u", taskId: "t" });
      for (let i = 0; i < 8 && leases.pending("b2").length === 0; i += 1) await Promise.resolve();
      leases.stop("b2");
      await expect(again).rejects.toThrow();
      expect(flights.paused("u")).toBe(false);
      expect(flights.tryEnter("v")).toBe(true);
      flights.leave("v");
    } finally {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for the browser lock holder to finish without taking that lock", async () => {
    const flights = createUserFlights();
    const lock = new UserBrowserLock();
    const finished = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const running = lock.run(() => {
      entered.resolve();
      return finished.promise;
    });
    expect(flights.tryEnter("u")).toBe(true);
    flights.pause("u");
    let granted = false;
    const waiting = flights.barrier("u").then(() => {
      granted = true;
    });
    await entered.promise;
    await Promise.resolve();
    expect(granted).toBe(false);
    finished.resolve();
    await running;
    flights.leave("u");
    await waiting;
    expect(granted).toBe(true);
    flights.resume("u");
  });

  it("keeps the pause through handoff and does not publish a lease after cancel or disconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-flight-handoff-"));
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
      const now = new Date().toISOString();
      db.$client.prepare("insert into users (id,email,name,status,created_at) values ('u','u@example.com','U','active',?),('v','v@example.com','V','active',?)").run(now, now);
      db.$client.prepare("insert into bots (id,user_id,name,model,created_at,updated_at) values ('b','u','B','m',?,?),('b2','u','B2','m',?,?),('c','v','C','m',?,?)").run(now, now, now, now, now, now);
      db.$client.prepare("insert into tasks (id,bot_id,state,trigger) values ('t','b','running','user'),('t2','b2','running','user')").run();
      const flights = createUserFlights();
      const grantable = () => db.$client.prepare("select id from takeover_leases where state in ('requested','active')").all() as { id: string }[];
      const leases = createTakeoverLeases({
        db,
        secretWaitMs: 60_000,
        flights,
        quiesce: async (botId) => {
          const row = db.$client.prepare("select user_id as userId from bots where id=?").get(botId) as { userId: string };
          await flights.barrier(row.userId);
        },
      });
      const refuseWrites = async () => {
        for (const name of ["shell_exec", "browser_click", "desktop_type", "foreign_mcp"]) {
          let ran = false;
          await expect(trackExecution("u", effectTool(name, () => { ran = true; }), flights).execute(name, {})).rejects.toThrow("用户正在接管，已拒绝执行");
          expect(ran).toBe(false);
        }
      };

      const held = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const running = trackExecution("u", shellTool(async () => {
        started.resolve();
        await held.promise;
      }), flights).execute("hold", {});
      await started.promise;
      const takeover = leases.request({ botId: "b", userId: "u", taskId: "t" });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(leases.pending("b")).toEqual([]);
      expect(flights.paused("u")).toBe(true);
      await refuseWrites();
      let other = false;
      await trackExecution("v", shellTool(async () => { other = true; }), flights).execute("other", {});
      expect(other).toBe(true);
      held.resolve();
      await running;
      expect(flights.inflight("u")).toBe(0);
      for (let i = 0; i < 8 && leases.pending("b").length === 0; i += 1) await Promise.resolve();
      const lease = leases.pending("b")[0];
      expect(lease?.state).toBe("requested");
      expect(flights.paused("u")).toBe(true);
      expect(flights.tryEnter("u")).toBe(false);
      expect(flights.inflight("u")).toBe(0);
      await refuseWrites();
      leases.attach("socket", "b", "session");
      expect(leases.grant(lease!.id, "socket", "u", "session")).toBe(true);
      expect(flights.tryEnter("u")).toBe(false);
      await refuseWrites();
      expect(leases.release(lease!.id, "u", "session")).toBe(true);
      await takeover;
      expect(flights.paused("u")).toBe(false);
      expect(grantable()).toEqual([]);
      leases.detach("socket");

      const abortHeld = Promise.withResolvers<void>();
      const abortStarted = Promise.withResolvers<void>();
      const abortRun = trackExecution("u", shellTool(async () => {
        abortStarted.resolve();
        await abortHeld.promise;
      }), flights).execute("abort-hold", {});
      await abortStarted.promise;
      const signal = new AbortController();
      const aborted = leases.request({ botId: "b2", userId: "u", taskId: "t2", signal: signal.signal });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      expect(grantable()).toEqual([]);
      signal.abort();
      abortHeld.resolve();
      await abortRun;
      await expect(aborted).rejects.toThrow(/^接管已取消$/);
      expect(grantable()).toEqual([]);
      expect(leases.pending("b2")).toEqual([]);
      leases.attach("late", "b2", "session");
      expect(leases.grant("late-lease", "late", "u", "session")).toBe(false);
      expect(flights.paused("u")).toBe(false);
      leases.detach("late");

      const detachHeld = Promise.withResolvers<void>();
      const detachStarted = Promise.withResolvers<void>();
      const detachRun = trackExecution("u", shellTool(async () => {
        detachStarted.resolve();
        await detachHeld.promise;
      }), flights).execute("detach-hold", {});
      await detachStarted.promise;
      leases.attach("viewer", "b", "session");
      const disconnected = leases.request({ botId: "b", userId: "u", taskId: "t" });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      leases.detach("viewer");
      expect(grantable()).toEqual([]);
      detachHeld.resolve();
      await detachRun;
      await expect(disconnected).rejects.toThrow(/^接管已取消$/);
      expect(grantable()).toEqual([]);
      leases.attach("viewer2", "b", "session");
      expect(leases.grant("after-disconnect", "viewer2", "u", "session")).toBe(false);
      expect(flights.paused("u")).toBe(false);
      leases.detach("viewer2");

      const stopHeld = Promise.withResolvers<void>();
      const stopStarted = Promise.withResolvers<void>();
      const stopRun = trackExecution("u", shellTool(async () => {
        stopStarted.resolve();
        await stopHeld.promise;
      }), flights).execute("stop-hold", {});
      await stopStarted.promise;
      const stopped = leases.request({ botId: "b", userId: "u", taskId: "t" });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      leases.stop("b");
      stopHeld.resolve();
      await stopRun;
      await expect(stopped).rejects.toThrow(/^接管已取消$/);
      expect(grantable()).toEqual([]);
      expect(flights.paused("u")).toBe(false);
      expect(flights.tryEnter("u")).toBe(true);
      flights.leave("u");
    } finally {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
