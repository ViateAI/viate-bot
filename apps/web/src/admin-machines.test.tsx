import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminMachines } from "./admin.js";

const machine = {
  id: "m1",
  userId: "u1",
  email: "ada@example.com",
  state: "running",
  spec: { cpu: 1, memMb: 1024, diskGb: 10 },
  image: "machine:dev",
  createdAt: "2026-11-01",
  lastHeartbeatAt: null,
};

async function renderMachines(initialDeleteId = ""): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["admin-machines"], { machines: [machine] });
  client.setQueryData(["admin-audit"], {
    audit: [{ id: "a1", ts: "2026-11-01", action: "machine.delete", target: machine.email }],
  });
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
    component: () => <AdminMachines initialDeleteId={initialDeleteId} />,
  });
  const audit = createRoute({ getParentRoute: () => root, path: "/admin/audit", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index, audit]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("admin machines", () => {
  it("hides the delete form and the duplicate audit list until a row asks to delete", async () => {
    const html = await renderMachines();
    expect(html).toContain('data-testid="machine-delete"');
    expect(html).not.toContain('data-testid="machine-delete-email"');
    expect(html).not.toContain('data-testid="machine-delete-submit"');
    expect(html).not.toContain("确认删除");
    expect(html).not.toContain('data-testid="audit-log"');
    expect(html).not.toContain("<h2");
    expect(html).toContain('href="/admin/audit"');
    expect(html).toContain("查看审计日志");
  });

  it("opens a danger confirm for the chosen machine email", async () => {
    const html = await renderMachines("m1");
    expect(html).toContain('data-testid="machine-delete-email"');
    const submit = html.match(/<button[^>]*data-testid="machine-delete-submit"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(submit.split(/[\s"]+/)).toContain("ui-btn-danger");
    expect(submit.split(/[\s"]+/)).not.toContain("ui-btn");
    expect(submit).toContain("确认删除");
    expect(html).toContain("取消");
    expect(html).toContain("ada@example.com");
    expect(html).not.toContain('data-testid="audit-log"');
  });
});
