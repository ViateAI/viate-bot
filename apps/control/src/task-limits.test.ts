import { describe, expect, it } from "vitest";
import {
  durationLimitText,
  elapsedActiveMs,
  isRunLimitError,
  pauseActive,
  restoreActive,
  resumeActive,
  showContinueButton,
  remainingActiveMs,
  reportedElapsedMs,
  stepLimitText,
  watchActiveLimit,
} from "./task-limits.js";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach } from "vitest";
import { openDatabase } from "./db/index.js";
import { quotaRepository } from "./db/quotas.js";
import { adminScope } from "./scope.js";
import { resolveTaskMaxDurationSec, resolveTaskMaxSteps, runLimitFailure, saveGlobalTaskMaxDurationSec, saveGlobalTaskMaxSteps } from "./task-limits.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("task run limits", () => {
  it("does not count paused waits and does not count time before a restored segment", () => {
    const started = resumeActive({ activeMs: 0, segmentStartedAt: null }, 1_000);
    const running = { ...started, activeMs: elapsedActiveMs(started, 11_000) - 0 };
    const paused = pauseActive({ activeMs: 0, segmentStartedAt: 1_000 }, 11_000);
    expect(paused).toEqual({ activeMs: 10_000, segmentStartedAt: null });
    expect(elapsedActiveMs(paused, 3_611_000)).toBe(10_000);
    const restored = restoreActive(paused.activeMs, 3_611_000);
    expect(elapsedActiveMs(restored, 3_611_000)).toBe(10_000);
    expect(elapsedActiveMs(restored, 3_616_000)).toBe(15_000);
    expect(running.segmentStartedAt).toBe(1_000);
  });

  it("names the limit and how much was used", () => {
    expect(durationLimitText(3_600_000)).toBe("已运行 60 分钟，达到时长上限。回复“继续”可以接着做。");
    expect(durationLimitText(133_000)).toBe("已运行 2 分 13 秒，达到时长上限。回复“继续”可以接着做。");
    expect(durationLimitText(40_000)).toBe("已运行 40 秒，达到时长上限。回复“继续”可以接着做。");
    expect(stepLimitText(200)).toBe("已用 200 步，达到步数上限。回复“继续”可以接着做。");
  });

  it("adds the open segment to saved running time and ignores a missing clock", () => {
    expect(reportedElapsedMs(JSON.stringify({ activeMs: 10_000 }), { activeMs: 10_000, segmentStartedAt: 1_000 }, 6_000)).toBe(15_000);
    expect(reportedElapsedMs(JSON.stringify({ activeMs: 40_000 }), undefined, 999_999)).toBe(40_000);
    expect(reportedElapsedMs(null, undefined, 1)).toBe(0);
  });

  it("shows continue only for the latest task stopped by a step or duration limit", () => {
    const duration = durationLimitText(60_000);
    const steps = stepLimitText(16);
    expect(showContinueButton([{ state: "failed", error: duration }])).toBe(true);
    expect(showContinueButton([{ state: "failed", error: steps }])).toBe(true);
    expect(showContinueButton([{ state: "succeeded", error: null }, { state: "failed", error: duration }])).toBe(false);
    expect(showContinueButton([{ state: "failed", error: "已达到单任务 token 预算（已用 2 / 上限 2）" }])).toBe(false);
    expect(showContinueButton([{ state: "failed", error: "模型请求失败" }])).toBe(false);
    expect(isRunLimitError(duration)).toBe(true);
    expect(isRunLimitError(steps)).toBe(true);
  });

  it("prefers the user override, then the global setting, then the environment default", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-limits-"));
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
    expect(resolveTaskMaxSteps(db, "u", 200)).toBe(200);
    expect(resolveTaskMaxDurationSec(db, "u", 3600)).toBe(3600);
    saveGlobalTaskMaxSteps(db, 50);
    saveGlobalTaskMaxDurationSec(db, 120);
    expect(resolveTaskMaxSteps(db, "u", 200)).toBe(50);
    expect(resolveTaskMaxDurationSec(db, "u", 3600)).toBe(120);
    quotaRepository(db).update(adminScope("admin"), "u", { taskMaxSteps: 0, taskMaxDurationSec: 0 });
    expect(resolveTaskMaxSteps(db, "u", 200)).toBe(0);
    expect(resolveTaskMaxDurationSec(db, "u", 3600)).toBe(0);
    quotaRepository(db).update(adminScope("admin"), "u", { taskMaxSteps: 9, taskMaxDurationSec: 15 });
    expect(resolveTaskMaxSteps(db, "u", 200)).toBe(9);
    expect(resolveTaskMaxDurationSec(db, "u", 3600)).toBe(15);
    expect(() => saveGlobalTaskMaxSteps(db, -1)).toThrow(/非负整数/);
    expect(() => saveGlobalTaskMaxDurationSec(db, 1.5)).toThrow(/非负整数/);
    db.$client.close();
  });

  it("fails on the active running time and treats 0 as unlimited", () => {
    expect(runLimitFailure({ modelCalls: 9, activeMs: 0, segmentStartedAt: null, nowMs: 0, maxSteps: 9, maxDurationSec: 15 })).toBe(stepLimitText(9));
    expect(runLimitFailure({ modelCalls: 1, activeMs: 10_000, segmentStartedAt: 0, nowMs: 5_000, maxSteps: 20, maxDurationSec: 15 })).toBe(durationLimitText(15_000));
    expect(runLimitFailure({ modelCalls: 1, activeMs: 10_000, segmentStartedAt: null, nowMs: 100_000, maxSteps: 20, maxDurationSec: 15 })).toBeUndefined();
    expect(runLimitFailure({ modelCalls: 100, activeMs: 999_000, segmentStartedAt: null, nowMs: 0, maxSteps: 0, maxDurationSec: 0 })).toBeUndefined();
  });

  it("does not fire a duration watch while paused and fires once the open segment crosses the cap", async () => {
    let now = 1_000;
    const run: { activeMs: number; segmentStartedAt: number | null } = { activeMs: 0, segmentStartedAt: 1_000 };
    let hits = 0;
    const stop = watchActiveLimit(() => run, () => now, 30, () => {
      hits += 1;
    });
    run.activeMs = 10_000;
    run.segmentStartedAt = null;
    now = 200_000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hits).toBe(0);
    expect(remainingActiveMs(run, now, 30)).toBe(20_000);
    run.segmentStartedAt = now;
    now += 30_000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hits).toBe(1);
    stop();
    expect(remainingActiveMs({ activeMs: 0, segmentStartedAt: null }, 0, 0)).toBeNull();
  });
});
