import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminUsers } from "./admin.js";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function braceBlock(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("unclosed block");
}

function wideUserTableCss(): string {
  const marker = "@container (min-width: 52rem)";
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return braceBlock(css, css.indexOf("{", start));
}

async function renderUsers(): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["admin-users"], {
    users: [{
      id: "u1",
      email: "ada@example.com",
      name: "Ada",
      status: "active",
      provisioned: true,
      machineState: "running",
      botCount: 1,
      tasks7d: 2,
      subject: null,
      maxBots: 5,
      maxConcurrentTasks: 2,
      maxRoutines: 10,
      taskTokenBudget: null,
      taskMaxSteps: null,
      taskMaxDurationSec: null,
      showProcess: false,
    }],
  });
  client.setQueryData(["admin-app-reviews"], { pendingCount: 0 });
  client.setQueryData(["admin-machines"], { machines: [] });
  client.setQueryData(["admin-templates"], { templates: [] });
  client.setQueryData(["admin-settings"], {
    integration: "none",
    defaultChannel: null,
    provisionDefaults: { maxBots: 5, maxConcurrentTasks: 2, maxRoutines: 10, models: ["fake"] },
  });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: AdminUsers });
  const reviews = createRoute({ getParentRoute: () => root, path: "/admin/app-reviews", component: () => null });
  const machines = createRoute({ getParentRoute: () => root, path: "/admin/machines", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index, reviews, machines]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("admin user table", () => {
  it("keeps a real cell for the email and a quota editor inside the row", async () => {
    const html = await renderUsers();
    const row = html.match(/<tr[^>]*data-testid="user-row"[^>]*>[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(row).toContain("<td");
    expect(row).toContain("ada@example.com");
    expect(row).toContain('data-testid="quota-editor"');
    expect(html).not.toMatch(/table-layout:\s*fixed/);
    const scroller = html.match(/<div class="([^"]*@container[^"]*)"/)?.[1] ?? "";
    expect(scroller).toContain("overflow-x-auto");
    expect(scroller).toMatch(/\bp-[34]\b|\bpx-[34]\b/);
  });

  it("scrolls a content-sized wide table and keeps the email on one line", () => {
    const wide = wideUserTableCss();
    expect(wide).toMatch(/table-layout:\s*auto/);
    expect(wide).not.toMatch(/table-layout:\s*fixed/);
    expect(wide).toMatch(/width:\s*max-content/);
    const email = wide.match(/\.vb-user-table th:nth-child\(1\),\s*\.vb-user-table td:nth-child\(1\)\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(email).toMatch(/white-space:\s*nowrap/);
    expect(email).toMatch(/min-width:\s*max-content/);
    const quota = wide.match(/\.vb-user-table th:nth-child\(8\),\s*\.vb-user-table td:nth-child\(8\)\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(quota).toMatch(/min-width:\s*20rem/);
    expect(css).toMatch(/\.quota-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
  });
});
