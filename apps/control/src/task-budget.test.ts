import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db/index.js";
import { quotaRepository } from "./db/quotas.js";
import { adminScope } from "./scope.js";
import { budgetFailure, resolveTaskTokenBudget, saveGlobalTaskTokenBudget } from "./task-budget.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("task token budget", () => {
  it("counts a positive cap and treats 0 as unlimited", () => {
    expect(budgetFailure({ tokensUsed: 12, tokenBudget: 10 })).toBe("已达到单任务 token 预算（已用 12 / 上限 10）");
    expect(budgetFailure({ tokensUsed: 12, tokenBudget: 0 })).toBeUndefined();
    expect(budgetFailure({ tokensUsed: 9, tokenBudget: 10 })).toBeUndefined();
    expect(budgetFailure({ tokensUsed: 100 }, 0)).toBeUndefined();
  });

  it("prefers the user override, then the global setting, then the environment default", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-budget-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "t.sqlite"));
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    db.$client.exec("insert into users (id,email,name,status,created_at) values ('u','u@x','u','active','now')");
    quotaRepository(db).insert(adminScope("admin"), "u", {
      maxBots: 1,
      spec: { cpu: 1, memMb: 1024, diskGb: 10 },
      maxConcurrentTasks: 1,
      maxRoutines: 1,
    });
    expect(resolveTaskTokenBudget(db, "u", 2_000_000)).toBe(2_000_000);
    saveGlobalTaskTokenBudget(db, 50_000);
    expect(resolveTaskTokenBudget(db, "u", 2_000_000)).toBe(50_000);
    quotaRepository(db).update(adminScope("admin"), "u", { taskTokenBudget: 0 });
    expect(resolveTaskTokenBudget(db, "u", 2_000_000)).toBe(0);
    quotaRepository(db).update(adminScope("admin"), "u", { taskTokenBudget: 80 });
    expect(resolveTaskTokenBudget(db, "u", 2_000_000)).toBe(80);
    expect(() => saveGlobalTaskTokenBudget(db, -1)).toThrow(/非负整数/);
    db.$client.close();
  });
});
