import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot, ChatMessage } from "./api.js";
import { ChatPage } from "./chat.js";

vi.mock("./computer.js", () => ({ Computer: () => null }));
vi.mock("./routines.js", () => ({ Routines: () => null }));
vi.mock("./approval.js", () => ({ ApprovalList: () => null, ApprovalRules: () => null }));

const messages: ChatMessage[] = [
  {
    id: "img-plain",
    role: "assistant",
    text: "",
    taskId: "task-1",
    createdAt: "2020-01-01T00:00:00.000Z",
    attachments: [{ id: "up-plain", name: "plain.png", size: 68, mime: "image/png", kind: "image" }],
  },
  {
    id: "img-cap",
    role: "assistant",
    text: "看这张图",
    taskId: "task-1",
    createdAt: "2020-01-01T00:01:00.000Z",
    attachments: [{ id: "up-cap", name: "cap.png", size: 80, mime: "image/png", kind: "image" }],
  },
  {
    id: "file-1",
    role: "assistant",
    text: "",
    taskId: "task-1",
    createdAt: "2020-01-01T00:02:00.000Z",
    attachments: [{ id: "up-file", name: "notes.bin", size: 12, mime: "application/octet-stream", kind: "file" }],
  },
];

async function page(): Promise<string> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const bot: Bot = {
    id: "bot-1",
    name: "Ada",
    bio: "",
    avatar: null,
    model: "gpt-test",
    instructions: "",
    updatedAt: "2020-01-01T00:00:00.000Z",
    primary: true,
  };
  queryClient.setQueryData(["bot", "bot-1"], { bot });
  queryClient.setQueryData(["conversations", "bot-1"], { conversations: [{ id: "conv-1" }] });
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

describe("assistant attachments", () => {
  it("renders image cards with and without a caption, and a file card", async () => {
    const html = await page();
    const images = html.match(/data-testid="message-image"/g) ?? [];
    expect(images).toHaveLength(2);
    expect(html).toContain('href="/api/uploads/up-plain"');
    expect(html).toContain('href="/api/uploads/up-cap"');
    expect(html).toContain('alt="plain.png"');
    expect(html).toContain('alt="cap.png"');
    expect(html).toContain("object-contain");
    expect(html).toContain("max-h-60");
    const plainAt = html.indexOf('alt="plain.png"');
    expect(html.slice(Math.max(0, plainAt - 500), plainAt)).not.toContain("<p");
    const capAt = html.indexOf('alt="cap.png"');
    expect(html.slice(Math.max(0, capAt - 800), capAt)).toContain("看这张图");
    expect(html).toContain('data-testid="message-file"');
    expect(html).toContain('href="/api/uploads/up-file"');
    expect(html).toContain("notes.bin");
    expect(html).toContain("下载");
    const fileAt = html.indexOf('data-testid="message-file"');
    expect(html.slice(Math.max(0, fileAt - 400), fileAt)).not.toContain("<p");
  });
});
