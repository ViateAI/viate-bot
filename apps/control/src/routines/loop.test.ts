import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { buildApp, startRoutineLoop, type ControlContext } from "../app.js";
import { loadConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { createSession } from "../session.js";
import { routineService } from "./service.js";

describe("routine account eligibility", () => {
  it.each(["disabled", "unknown"])("does not enqueue scheduled or manual work when upstream is %s", async (status) => {
    const dir = mkdtempSync(join(tmpdir(), "vb-routine-status-"));
    const config = loadConfig({ VB_DATA_DIR: dir, VB_INTEGRATION: "viate", VB_VIATE_URL: "https://identity.test", VB_VIATE_CLIENT_ID: "test", VB_VIATE_CLIENT_SECRET: "test", VB_MAX_RUNNING_TASKS: "0" });
    const db = openDatabase(config.databasePath);
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    const key = loadOrCreateKey(config.secretKeyPath);
    const ctx: ControlContext = { db, config, key, driver: {} as ControlContext["driver"] };
    db.$client.exec(`insert into users(id,email,name,status,created_at) values ('u','u@example.com','U','active','now');
      insert into identities(provider,subject,user_id,email,email_verified,created_at) values ('viate','external-u','u','u@example.com',1,'now');
      insert into bots(id,user_id,name,model,created_at,updated_at) values ('b','u','B','m','now','now');
      insert into quotas(user_id,max_bots,spec_json,max_concurrent_tasks,max_routines) values ('u',1,'{}',1,2);`);
    const service = routineService(db);
    const start = new Date(Date.now() - 120_000);
    const id = service.propose("u", "b", { cron: "* * * * *", timezone: "UTC", prompt: "private" }, start);
    service.confirm("u", id, start);
    const app = buildApp(ctx, { fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/oauth/token") return Response.json({ access_token: "service-token", expires_in: 3600 });
      if (path === "/api/service/users/external-u") return status === "unknown" ? new Response(null, { status: 404 }) : Response.json({ status });
      throw new Error(`Unexpected network request: ${path}`);
    } });
    let stop = () => {};
    try {
      await app.ready();
      const session = createSession(db, key, "u", "refresh", new Date());
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      stop = startRoutineLoop(app, ctx, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(db.$client.prepare("select count(*) as n from tasks").get()).toEqual({ n: 0 });
      const history = service.history("u", id) as Array<{ state: string }>;
      if (status === "disabled") {
        expect(history.length).toBeGreaterThan(0);
        expect(history.every((row) => row.state === "skipped")).toBe(true);
      } else {
        expect(history).toEqual([]);
      }
      const manual = await app.inject({ method: "POST", url: `/api/routines/${id}/run`, headers: { cookie: `vb_session=${session.token}`, "x-vb-csrf": session.csrf } });
      expect(manual.statusCode).toBe(status === "disabled" ? 403 : 503);
      expect(db.$client.prepare("select count(*) as n from tasks").get()).toEqual({ n: 0 });
    } finally {
      stop();
      vi.useRealTimers();
      await app.close();
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
