import { describe, expect, it } from "vitest";
import { showContinueButton } from "./task-limit.js";

describe("continue after a run limit", () => {
  it("shows the button only for the latest step or duration stop", () => {
    const duration = "已运行 60 分钟，达到时长上限。回复“继续”可以接着做。";
    const steps = "已用 200 步，达到步数上限。回复“继续”可以接着做。";
    expect(showContinueButton([{ state: "failed", error: duration }])).toBe(true);
    expect(showContinueButton([{ state: "failed", error: steps }])).toBe(true);
    expect(showContinueButton([{ state: "succeeded", error: null }, { state: "failed", error: duration }])).toBe(false);
    expect(showContinueButton([{ state: "failed", error: "已达到单任务 token 预算（已用 2 / 上限 2）" }])).toBe(false);
    expect(showContinueButton([{ state: "failed", error: "remote_unconfirmed" }])).toBe(false);
    expect(showContinueButton([])).toBe(false);
  });
});
