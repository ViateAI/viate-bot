import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatPage } from "./chat.js";

vi.mock("./computer.js", () => ({ Computer: () => null }));
vi.mock("./routines.js", () => ({ Routines: () => null }));
vi.mock("./approval.js", () => ({ ApprovalList: () => null, ApprovalRules: () => null }));

describe("send mode control", () => {
  it("defaults the composer to 引导 and keeps queue and stop separate", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    const html = renderToStaticMarkup(<RouterProvider router={router} />);
    expect(html).toContain('data-testid="send-mode"');
    expect(html).toMatch(/<option(?=[^>]*value="steer")(?=[^>]*selected)[^>]*>引导<\/option>/);
    expect(html).not.toMatch(/<option(?=[^>]*value="queue")(?=[^>]*selected)/);
    expect(html).toContain(">排队</option>");
    expect(html).not.toContain("打断");
    expect(html).toContain('data-testid="stop-task"');
    expect(html).toContain(">停止<");
    expect(html).not.toContain("停止重发");
    expect(html).not.toContain("停止并");
  });
});
