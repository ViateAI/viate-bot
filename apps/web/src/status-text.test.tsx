import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatPage } from "./chat.js";
import { Routines } from "./routines.js";

vi.mock("./computer.js", () => ({ Computer: () => null }));
vi.mock("./approval.js", () => ({ ApprovalList: () => null, ApprovalRules: () => null }));

const bot = { id: "bot-1", name: "通用助手", bio: "", avatar: null, model: "fake", instructions: "", primary: true };

async function renderChat(): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["me"], { id: "u1", name: "Ada", email: "ada@example.com", isAdmin: false, provisioned: true, csrf: "tok" });
  client.setQueryData(["bot", "bot-1"], { bot });
  client.setQueryData(["bots"], { bots: [bot] });
  client.setQueryData(["conversations", "bot-1"], { conversations: [{ id: "c1" }] });
  client.setQueryData(["messages", "c1"], { messages: [] });
  client.setQueryData(["memories", "bot-1"], { memories: [] });
  client.setQueryData(["routines", "bot-1"], { routines: [] });
  client.setQueryData(["tasks", "c1"], { tasks: [{ id: "t1", state: "succeeded", error: null, conversationId: "c1" }], showProcess: true });
  client.setQueryData(["steps", "t1"], {
    steps: [
      { id: "s1", seq: 1, kind: "model", status: "succeeded", request: { label: "正在回复" }, response: null },
      { id: "s2", seq: 2, kind: "tool", status: "running", request: { label: "正在执行命令" }, response: null },
      { id: "s3", seq: 3, kind: "tool", status: "failed", request: { label: "失败步骤" }, response: null },
      { id: "s4", seq: 4, kind: "tool", status: "cancelled", request: { label: "停止步骤" }, response: null },
      { id: "s5", seq: 5, kind: "tool", status: "interrupted", request: { label: "中断步骤" }, response: null },
      { id: "s6", seq: 6, kind: "tool", status: "waiting_approval", request: { label: "批准步骤" }, response: null },
      { id: "s7", seq: 7, kind: "tool", status: "waiting_input", request: { label: "输入步骤" }, response: null },
      { id: "s8", seq: 8, kind: "tool", status: "waiting_takeover", request: { label: "接管步骤" }, response: null },
      { id: "s9", seq: 9, kind: "tool", status: "queued", request: { label: "排队步骤" }, response: null },
      { id: "s10", seq: 10, kind: "tool", status: "pending", request: { label: "待处理步骤" }, response: null },
      { id: "s11", seq: 11, kind: "tool", status: "custom_status", request: { label: "未知步骤" }, response: null },
    ],
  });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => <ChatPage botId="bot-1" /> });
  const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function renderRoutines(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["routines", "bot-1"], {
    routines: [{ id: "r1", cron: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "每天看一眼", state: "active", enabled: 1, nextRunAt: null }],
  });
  client.setQueryData(["routine-runs", "r1"], {
    runs: [
      { id: "run-ok", scheduledAt: "2026-11-01T01:00:00.000Z", state: "succeeded", error: null, taskId: "t" },
      { id: "run-bad", scheduledAt: "2026-11-01T02:00:00.000Z", state: "failed", error: "上游不可用", taskId: "t" },
      { id: "run-go", scheduledAt: "2026-11-01T03:00:00.000Z", state: "claimed", error: null, taskId: null },
      { id: "run-skip", scheduledAt: "2026-11-01T04:00:00.000Z", state: "skipped", error: null, taskId: null },
      { id: "run-miss", scheduledAt: "2026-11-01T05:00:00.000Z", state: "missed", error: null, taskId: null },
      { id: "run-new", scheduledAt: "2026-11-01T06:00:00.000Z", state: "brand_new", error: null, taskId: null },
    ],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Routines botId="bot-1" initialHistory="r1" />
    </QueryClientProvider>,
  );
}

describe("chinese status text", () => {
  it("maps profile step statuses to Chinese and leaves unknown values alone", async () => {
    const html = await renderChat();
    const list = html.match(/<ol[^>]*data-testid="step-list"[^>]*>[\s\S]*?<\/ol>/)?.[0] ?? "";
    expect(list).toContain("正在回复 · 已完成");
    expect(list).toContain("正在执行命令 · 执行中");
    expect(list).toContain("失败步骤 · 失败");
    expect(list).toContain("停止步骤 · 已停止");
    expect(list).toContain("中断步骤 · 已中断");
    expect(list).toContain("批准步骤 · 等待批准");
    expect(list).toContain("输入步骤 · 等待输入");
    expect(list).toContain("接管步骤 · 等待接管");
    expect(list).toContain("排队步骤 · 排队中");
    expect(list).toContain("待处理步骤 · 排队中");
    expect(list).toContain("未知步骤 · custom_status");
    expect(list).not.toMatch(/· (succeeded|running|failed|cancelled|interrupted|waiting_approval|waiting_input|waiting_takeover|queued|pending)/);
  });

  it("maps routine run states to Chinese", () => {
    const html = renderRoutines();
    expect(html).toContain("已完成");
    expect(html).toContain("失败");
    expect(html).toContain("执行中");
    expect(html).toContain("已跳过");
    expect(html).toContain("已错过");
    expect(html).toContain("brand_new");
    expect(html).not.toMatch(/· (succeeded|failed|claimed|skipped|missed)/);
  });
});
