import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db/index.js";
import { assertModelLimit, readModelLimits, resolveModelLimit, saveModelLimit } from "./model-limits.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("model limits", () => {
  it("rejects an output cap above the context window", () => {
    expect(() => assertModelLimit(1000, 1001)).toThrow(/不得超过/);
  });

  it("stores a model and falls back to the environment default", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-limits-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "t.sqlite"));
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    saveModelLimit(db, "deepseek-flash", { contextTokens: 128_000, maxTokens: 8192 });
    const stored = readModelLimits(db);
    expect(resolveModelLimit(stored, "deepseek-flash", { contextTokens: 256_000, maxTokens: 4096 })).toEqual({
      contextTokens: 128_000,
      maxTokens: 8192,
    });
    expect(resolveModelLimit(stored, "other", { contextTokens: 256_000, maxTokens: 4096 })).toEqual({
      contextTokens: 256_000,
      maxTokens: 4096,
    });
    saveModelLimit(db, "deepseek-flash", null);
    expect(readModelLimits(db)["deepseek-flash"]).toBeUndefined();
    db.$client.close();
  });
});
