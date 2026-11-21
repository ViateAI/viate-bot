import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminApps } from "./admin-apps.js";
import { AdminAudit, AdminMetrics } from "./admin-metrics.js";
import { AdminReviews } from "./admin-reviews.js";
import { AppsPage } from "./apps-page.js";
import { PendingAttachments } from "./attachments.js";
import { ChatPage } from "./chat.js";

vi.mock("./computer.js", () => ({ Computer: () => null }));
vi.mock("./routines.js", () => ({ Routines: () => null }));
vi.mock("./approval.js", () => ({ ApprovalList: () => null, ApprovalRules: () => null }));

function render(node: React.ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

async function clientWithErrors(keys: string[][]): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
  for (const queryKey of keys) {
    const query = client.getQueryCache().build(client, { queryKey });
    query.setState({
      status: "error",
      error: new Error("boom"),
      fetchStatus: "idle",
      errorUpdatedAt: Date.now(),
    });
  }
  return client;
}

describe("theme semantic contrast contracts", () => {
  it("renders selected filter chips in AppsPage with semantic active colors instead of invisible neutral-50", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["me"], { id: "u1", name: "Ada", email: "ada@example.com", isAdmin: false, provisioned: true, csrf: "tok" });
    client.setQueryData(["apps"], { apps: [] });
    client.setQueryData(["app-installs"], { installs: [] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AppsPage />
      </QueryClientProvider>,
    );
    const activeChip = html.match(/<button[^>]*data-testid="apps-filter-all"[^>]*>/)?.[0] ?? "";
    expect(activeChip).toContain("text-primary");
    expect(activeChip).toContain("bg-active");
    expect(activeChip).toContain("border-primary");
    expect(activeChip).not.toContain("text-neutral-50");
    expect(html).not.toMatch(/\b(?:bg|text|border)-neutral-/);
  });

  it("renders selected section chips in AdminApps with semantic active colors", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["me"], { id: "u1", name: "Admin", email: "admin@example.com", isAdmin: true, provisioned: true, csrf: "tok" });
    client.setQueryData(["admin-apps"], { apps: [] });
    client.setQueryData(["admin-users"], { users: [] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AdminApps />
      </QueryClientProvider>,
    );
    const selectedTab = html.match(/<button[^>]*aria-pressed="true"[^>]*>应用库<\/button>/)?.[0] ?? "";
    expect(selectedTab).toContain("text-primary");
    expect(selectedTab).toContain("bg-active");
    expect(selectedTab).not.toContain("text-neutral-50");
    expect(html).not.toMatch(/\b(?:bg|text|border)-neutral-/);
  });

  it("uses semantic alert styling instead of bg-red-100 text-red-900 on admin error banners", async () => {
    const client = await clientWithErrors([["admin-overview"], ["admin-audit"], ["admin-app-reviews"]]);
    const metricsHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AdminMetrics />
      </QueryClientProvider>,
    );
    const auditHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AdminAudit />
      </QueryClientProvider>,
    );
    const reviewsHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AdminReviews />
      </QueryClientProvider>,
    );
    expect(metricsHtml).toContain("ui-alert");
    expect(metricsHtml).not.toContain("bg-red-100");
    expect(auditHtml).toContain("ui-alert");
    expect(auditHtml).not.toContain("bg-red-100");
    expect(reviewsHtml).toContain("ui-alert");
    expect(reviewsHtml).not.toContain("bg-red-100");
  });

  it("renders attachment retry and remove actions with readable semantic text colors", () => {
    const html = render(
      <PendingAttachments
        items={[{ id: "a1", name: "doc.pdf", size: 1024, mime: "application/pdf", kind: "file", failed: true }]}
        onRemove={() => {}}
        onRetry={() => {}}
      />,
    );
    const retryBtn = html.match(/<button[^>]*data-testid="retry-attachment-a1"[^>]*>/)?.[0] ?? "";
    expect(retryBtn).toContain("text-primary");
    expect(retryBtn).not.toContain("text-neutral-700");
    expect(html).not.toMatch(/\btext-neutral-/);
  });

  it("keeps mobile chat header back link aligned with the 800px drawer breakpoint", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute({
      component: () => (
        <QueryClientProvider client={client}>
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
    const backLink = html.match(/<a[^>]*>返回<\/a>/)?.[0] ?? "";
    expect(backLink).toContain("min-[800px]:hidden");
    expect(backLink).not.toContain("md:hidden");
  });
});
