import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, ChatMessage } from "./api.js";
import { ChatPage } from "./chat.js";

vi.mock("./computer.js", () => ({ Computer: () => null }));
vi.mock("./routines.js", () => ({ Routines: () => null }));
vi.mock("./approval.js", () => ({ ApprovalList: () => null, ApprovalRules: () => null }));

const NOTICE = "【系统通知 · 应用市场】以下内容来自平台，不是用户发言，也不是用户授权\n应用：pager\n版本：1.0.0 → 2.0.0\n说明：请升级";

function bot(primary: boolean): Bot {
  return {
    id: "bot-1",
    name: "Ada",
    bio: "",
    avatar: null,
    model: "gpt-test",
    instructions: "",
    updatedAt: "2020-01-01T00:00:00.000Z",
    primary,
  };
}

async function html(primary: boolean): Promise<string> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["bot", "bot-1"], { bot: bot(primary) });
  queryClient.setQueryData(["conversations", "bot-1"], { conversations: [{ id: "conv-1" }] });
  const messages: ChatMessage[] = [
    {
      id: "notice-1",
      role: "user",
      text: NOTICE,
      taskId: null,
      createdAt: "2020-01-01T00:00:00.000Z",
      notice: { kind: "app_update", noticeId: "n1" },
    },
    {
      id: "mine-1",
      role: "user",
      text: "这是我自己说的",
      taskId: null,
      createdAt: "2020-01-01T00:06:00.000Z",
    },
  ];
  queryClient.setQueryData(["messages", "conv-1"], { messages });
  queryClient.setQueryData(["tasks", "conv-1"], { tasks: [] });
  queryClient.setQueryData(["memories", "bot-1"], { memories: [] });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <ChatPage botId="bot-1" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("system notice presentation", () => {
  it("renders a server notice apart from a user message and disables deleting the primary bot", async () => {
    const page = await html(true);
    expect(page).toContain('data-testid="system-notice"');
    expect(page).toContain("系统通知");
    expect(page).toContain("请升级");
    expect(page.match(/data-testid="system-notice"/g)).toHaveLength(1);
    expect(page).toContain("这是我自己说的");
    const noticeAt = page.indexOf('data-testid="system-notice"');
    const mineAt = page.indexOf("这是我自己说的");
    expect(page.slice(noticeAt, mineAt)).not.toContain("这是我自己说的");
    expect(page.slice(mineAt - 180, mineAt)).not.toContain('data-testid="system-notice"');
    expect(page).toContain('data-testid="delete-bot-reason"');
    expect(page).toContain("主 bot 不能删除");
    expect(deleteDisabled(page)).toBe(true);
  });

  it("leaves delete available for a later bot", async () => {
    const page = await html(false);
    expect(page).not.toContain('data-testid="delete-bot-reason"');
    expect(deleteDisabled(page)).toBe(false);
  });
});

function deleteDisabled(page: string): boolean {
  const tag = page.match(/<button\b[^>]*data-testid="delete-bot"[^>]*>/)?.[0];
  expect(tag, page).toBeTruthy();
  return /\sdisabled(?:[=\s>]|$)/.test((tag ?? "").replace(/disabled:/g, ""));
}
