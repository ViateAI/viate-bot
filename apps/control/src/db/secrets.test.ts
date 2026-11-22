import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { userScope } from "../scope.js";
import { openDatabase, type AppDatabase } from "./index.js";
import { secrets } from "./schema.js";
import { secretRepository } from "./secrets.js";
import { ensureDevUser } from "./users.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "vb-secrets-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  ensureDevUser(db, "user-a");
  ensureDevUser(db, "user-b");
  return db;
}

describe("secretRepository user secrets", () => {
  it("keeps every ciphertext for masking and exposes createdAt", () => {
    const db = database();
    try {
      const store = secretRepository(db);
      store.upsert(userScope("user-a"), { id: "s1", name: "zeta", valueEnc: "enc-zeta", scope: "browser" });
      db.insert(secrets).values({
        id: "s-app",
        userId: "user-a",
        name: "app:install:TOKEN",
        valueEnc: "enc-app",
        scope: "app",
        createdAt: "2020-01-01T00:00:00.000Z",
      }).run();
      const rows = store.list(userScope("user-a"));
      expect(rows.map((row) => row.name).sort()).toEqual(["app:install:TOKEN", "zeta"]);
      const zeta = rows.find((row) => row.name === "zeta");
      expect(zeta?.valueEnc).toBe("enc-zeta");
      expect(zeta?.scope).toBe("browser");
      expect(zeta?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const app = rows.find((row) => row.name === "app:install:TOKEN");
      expect(app?.valueEnc).toBe("enc-app");
      expect(app?.createdAt).toBe("2020-01-01T00:00:00.000Z");
    } finally {
      db.$client.close();
    }
  });

  it("lists only the current user's non-app metadata in name order", () => {
    const db = database();
    try {
      const store = secretRepository(db);
      store.upsert(userScope("user-a"), { id: "s2", name: "beta", valueEnc: "enc-beta", scope: "browser" });
      store.upsert(userScope("user-a"), { id: "s1", name: "alpha", valueEnc: "enc-alpha", scope: "browser" });
      store.upsert(userScope("user-b"), { id: "s3", name: "other", valueEnc: "enc-other", scope: "browser" });
      db.insert(secrets).values([
        {
          id: "s-app",
          userId: "user-a",
          name: "plain_app_scope",
          valueEnc: "enc-plain-app",
          scope: "app",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
        {
          id: "s-prefix",
          userId: "user-a",
          name: "app:legacy",
          valueEnc: "enc-legacy",
          scope: "browser",
          createdAt: "2020-01-02T00:00:00.000Z",
        },
      ]).run();
      const listed = store.listUser(userScope("user-a"));
      expect(listed.map((row) => row.name)).toEqual(["alpha", "beta"]);
      for (const row of listed) {
        expect(row).toEqual({
          id: expect.any(String),
          name: expect.any(String),
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        });
        expect(JSON.stringify(row)).not.toContain("enc-");
      }
    } finally {
      db.$client.close();
    }
  });

  it("removes only the caller's non-app secret", () => {
    const db = database();
    try {
      const store = secretRepository(db);
      store.upsert(userScope("user-a"), { id: "s1", name: "alpha", valueEnc: "enc-alpha", scope: "browser" });
      store.upsert(userScope("user-b"), { id: "s2", name: "alpha", valueEnc: "enc-b", scope: "browser" });
      db.insert(secrets).values([
        {
          id: "s-app",
          userId: "user-a",
          name: "plain_app_scope",
          valueEnc: "enc-plain-app",
          scope: "app",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
        {
          id: "s-prefix",
          userId: "user-a",
          name: "app:legacy",
          valueEnc: "enc-legacy",
          scope: "browser",
          createdAt: "2020-01-02T00:00:00.000Z",
        },
      ]).run();
      expect(store.remove(userScope("user-a"), "alpha")).toBe(true);
      expect(store.find(userScope("user-a"), "alpha")).toBeUndefined();
      expect(store.find(userScope("user-b"), "alpha")?.valueEnc).toBe("enc-b");
      expect(store.remove(userScope("user-a"), "alpha")).toBe(false);
      expect(store.remove(userScope("user-a"), "plain_app_scope")).toBe(false);
      expect(store.remove(userScope("user-a"), "app:legacy")).toBe(false);
      expect(store.find(userScope("user-a"), "plain_app_scope")?.valueEnc).toBe("enc-plain-app");
      expect(store.find(userScope("user-a"), "app:legacy")?.valueEnc).toBe("enc-legacy");
    } finally {
      db.$client.close();
    }
  });
});
