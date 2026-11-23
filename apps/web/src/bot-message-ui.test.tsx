import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, ChatMessage } from "./api.js";
import { ChatPage } from "./chat.js";

vi.mock("./computer.js", () => ({ Computer: () => null }));
vi.mock("./routines.js", () => ({ Routines: () => null }));
vi.mock("./approval.js", () => ({ ApprovalList: () => null, ApprovalRules: () => null }));

const LONG = "甲".repeat(80);

function message(kind: "bot_message" | "bot_reply", shown = false): ChatMessage {
  return {
    id: kind,
    role: "user",
    text: `${LONG}\n正文`,
    taskId: shown ? null : "task-1",
    createdAt: "2020-01-01T00:00:00.000Z",
    notice: {
      kind,
      noticeId: "m-1",
      peerBotId: "bot-a",
      peerName: "Ada",
      peerConversationId: "conv-older",
      ...(shown ? { shown: true } : {}),
    },
  };
}

async function html(messages: ChatMessage[], requestedConversationId?: string): Promise<string> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const bot: Bot = { id: "bot-1", name: "Bea", bio: "", avatar: null, model: "gpt-test", instructions: "", updatedAt: "2020-01-01T00:00:00.000Z" };
  queryClient.setQueryData(["bot", "bot-1"], { bot });
  queryClient.setQueryData(["conversations", "bot-1"], { conversations: [{ id: "conv-1" }, { id: "conv-older" }] });
  queryClient.setQueryData(["messages", "conv-1"], { messages: requestedConversationId ? [{ ...message("bot_message"), text: "最新对话的正文", notice: undefined }] : messages });
  queryClient.setQueryData(["messages", "conv-older"], { messages });
  queryClient.setQueryData(["tasks", "conv-1"], { tasks: [] });
  queryClient.setQueryData(["tasks", "conv-older"], { tasks: [] });
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
    component: () => <ChatPage botId="bot-1" requestedConversationId={requestedConversationId} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("bot message cards", () => {
  it("renders an incoming bot message as a card that links to the sender", async () => {
    const page = await html([message("bot_message")]);
    expect(page).toContain('data-testid="bot-message"');
    expect(page).toContain("来自Ada的 bot 消息");
    expect(page).toContain('data-testid="bot-message-jump"');
    expect(page).toContain('href="/b/bot-a?conversationId=conv-older"');
    expect(page).not.toContain("未自动继续处理");
    expect(page).toContain(LONG);
    const card = page.slice(page.indexOf('data-testid="bot-message"'), page.indexOf(LONG) + LONG.length);
    expect(card).not.toContain("bubble");
  });

  it("renders a held reply with the same card and a note that it was not continued", async () => {
    const page = await html([message("bot_reply", true)]);
    expect(page).toContain('data-testid="bot-reply"');
    expect(page).toContain("来自Ada的回复");
    expect(page).toContain('data-testid="bot-reply-held"');
    expect(page).toContain("未自动继续处理");
    expect(page).toContain('href="/b/bot-a?conversationId=conv-older"');
  });

  it("renders the requested older conversation instead of the newest one", async () => {
    const page = await html([message("bot_message")], "conv-older");
    expect(page).toContain("来自Ada的 bot 消息");
    expect(page).not.toContain("最新对话的正文");
  });

  it("does not interpret card contents as markup", async () => {
    const page = await html([{ ...message("bot_message"), text: "<em>示例</em>" }]);
    expect(page).toContain("&lt;em&gt;示例&lt;/em&gt;");
    expect(page).not.toContain("<em>示例</em>");
  });
});
