import { describe, expect, it } from "vitest";
import { activityLine } from "./activity.js";

const secret = "secret-path-do-not-show";

describe("activity line", () => {
  it("names the server state and the elapsed running time", () => {
    expect(activityLine({ state: "queued", stream: "", detail: false, elapsedMs: 0, steps: [] })).toBe("排队中 · 0 秒");
    expect(activityLine({ state: "running", stream: "", detail: false, elapsedMs: 133000, steps: [] })).toBe("思考中 · 2 分 13 秒");
    expect(activityLine({ state: "running", waitingRate: true, stream: "", detail: true, elapsedMs: 5000, steps: [] })).toBe("请求较多，等待中 · 5 秒");
    expect(activityLine({ state: "running", stream: "正在写", detail: false, elapsedMs: 2000, steps: [] })).toBeNull();
    expect(activityLine({ state: "waiting_approval", stream: "", detail: true, elapsedMs: 8000, steps: [] })).toBeNull();
    expect(activityLine({ state: "succeeded", stream: "", detail: false, elapsedMs: 8000, steps: [] })).toBeNull();
  });

  it("names a running tool only when process detail is on and never prints arguments", () => {
    const steps = [{
      kind: "tool",
      status: "running",
      request: { name: "browser_open", args: { url: secret }, label: "正在打开网页" },
    }];
    const hidden = activityLine({ state: "running", stream: "刚才的文字", detail: false, elapsedMs: 40000, steps });
    const shown = activityLine({ state: "running", stream: "刚才的文字", detail: true, elapsedMs: 40000, steps });
    expect(hidden).toBe("正在操作 · 40 秒");
    expect(shown).toBe("正在使用浏览器 · 40 秒");
    expect(hidden).not.toContain(secret);
    expect(shown).not.toContain(secret);
    expect(hidden).not.toContain("browser_open");
  });
});
