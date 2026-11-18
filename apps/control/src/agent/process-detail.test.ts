import { describe, expect, it } from "vitest";
import { redactMessages, redactStep, toolLabel } from "./process-detail.js";
import type { MessageView, StepView, TaskView } from "./view.js";

function step(partial: Partial<StepView> & Pick<StepView, "kind" | "request">): StepView {
  return {
    id: "s",
    taskId: "t",
    seq: 1,
    status: "succeeded",
    response: { text: "secret-output", args: { cmd: "rm -rf /" } },
    startedAt: "now",
    endedAt: "now",
    ...partial,
  };
}

describe("process detail", () => {
  it("maps a tool to a short label and drops arguments, results, and screenshots", () => {
    const hidden = redactStep(
      step({
        kind: "tool",
        request: { name: "shell_exec", args: { cmd: "echo secret" }, toolCallId: "c" },
        response: { text: "secret-output" },
      }),
      false,
    );
    expect(hidden.request).toEqual({ name: "shell_exec", label: toolLabel("shell_exec") });
    expect(hidden.response).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain("echo secret");
    expect(JSON.stringify(hidden)).not.toContain("secret-output");
  });

  it("keeps approval, secret, takeover, and install cards intact", () => {
    const request = { name: "request_secret", args: { name: "otp", label: "验证码", kind: "otp", reason: "登录" } };
    const full = redactStep(step({ kind: "tool", request, response: { text: "已提供" } }), false);
    expect(full.request).toEqual(request);
    expect(redactStep(step({ kind: "tool", request: { name: "install_mcp", args: { reason: "装" } } }), false).request).toMatchObject({
      name: "install_mcp",
    });
  });

  it("hides intermediate assistant text and tool results, and keeps the final reply", () => {
    const messages: MessageView[] = [
      { id: "u", role: "user", text: "做一下", taskId: "t", createdAt: "1" },
      { id: "a1", role: "assistant", text: "我先调用工具", taskId: "t", createdAt: "2", toolCalls: [{ id: "c", name: "shell_exec", arguments: { cmd: "x" } }] },
      { id: "r", role: "toolResult", text: "工具原文", taskId: "t", createdAt: "3", toolName: "shell_exec" },
      { id: "a2", role: "assistant", text: "最终结论", taskId: "t", createdAt: "4" },
    ];
    const tasks: TaskView[] = [{ id: "t", botId: "b", conversationId: "c", state: "succeeded", error: null, stepCount: 2, startedAt: null, endedAt: null }];
    const hidden = redactMessages(messages, tasks, false);
    expect(hidden.map((item) => item.id)).toEqual(["u", "a2"]);
    expect(hidden[1]?.text).toBe("最终结论");
    expect(JSON.stringify(hidden)).not.toContain("工具原文");
    expect(JSON.stringify(hidden)).not.toContain("我先调用工具");
    const running = redactMessages(messages, [{ ...tasks[0]!, state: "running" }], false);
    expect(running.map((item) => item.text)).toEqual(["做一下"]);
  });

  it("returns the current shape when detail is on", () => {
    const original = step({ kind: "tool", request: { name: "fs_write", args: { path: "/home/bot/a" } } });
    expect(redactStep(original, true)).toBe(original);
  });

  it("does not fall back to an earlier reply when the last assistant called a tool", () => {
    const messages: MessageView[] = [
      { id: "a1", role: "assistant", text: "private intermediate", taskId: "t", createdAt: "1" },
      { id: "a2", role: "assistant", text: "tool planning", taskId: "t", createdAt: "2", toolCalls: [{ id: "c", name: "shell_exec", arguments: {} }] },
    ];
    const tasks: TaskView[] = [{ id: "t", botId: "b", conversationId: "c", state: "failed", error: "stopped", stepCount: 2, startedAt: null, endedAt: null }];
    expect(redactMessages(messages, tasks, false)).toEqual([]);
  });

  it("keeps interactive card inputs but never returns install tool output", () => {
    const hidden = redactStep(step({ kind: "tool", request: { name: "install_mcp", args: { app: "demo" } } }), false);
    expect(hidden.request).toMatchObject({ name: "install_mcp", args: { app: "demo" } });
    expect(hidden.response).toBeNull();
  });
});
