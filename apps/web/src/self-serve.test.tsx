import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppsPage } from "./apps-page.js";
import { BotSidebar } from "./bots.js";

const me = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  isAdmin: false,
  provisioned: false,
  showProcess: false,
  csrf: "tok",
};

async function sidebar(data: Record<string, unknown>): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["me"], data);
  client.setQueryData(["bots"], { bots: [] });
  client.setQueryData(["models"], { models: ["fake"], unrestricted: false });
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
    component: () => <BotSidebar />,
  });
  const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function apps(data: Record<string, unknown>): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["me"], data);
  client.setQueryData(["apps"], { apps: [] });
  client.setQueryData(["app-installs"], { installs: [] });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppsPage />
    </QueryClientProvider>,
  );
}

describe("self-serve surfaces", () => {
  it("keeps the admin contact notice when self-serve is off", async () => {
    const html = await sidebar(me);
    expect(html).toContain('data-testid="not-provisioned"');
    expect(html).toContain("尚未开通，请联系管理员");
    expect(html).not.toContain('data-testid="self-serve-provision"');
    expect(html).not.toContain("开通我的助手");
    expect(html).not.toContain('aria-label="新建 bot"');
    expect(html).not.toContain('aria-label="关闭新建"');
  });

  it("offers one-click provisioning when self-serve is on", async () => {
    const html = await sidebar({ ...me, allowSelfServe: true, allowNewBot: true });
    expect(html).toContain('data-testid="not-provisioned"');
    expect(html).toContain("你还没有开通工作环境，可一键开通你的默认助手与专属机器。");
    expect(html).toContain('data-testid="self-serve-provision"');
    expect(html).toContain("开通我的助手");
    expect(html).not.toContain("尚未开通，请联系管理员");
    expect(html).not.toContain('aria-label="新建 bot"');
    expect(html).not.toContain('aria-label="关闭新建"');
  });

  it("hides the new-bot control when the server disallows it and shows it otherwise", async () => {
    const open = await sidebar({ ...me, provisioned: true, allowNewBot: true });
    expect(open).toContain('aria-label="新建 bot"');
    expect(open).not.toContain('data-testid="not-provisioned"');
    const legacy = await sidebar({ ...me, provisioned: true });
    expect(legacy).toContain('aria-label="新建 bot"');
    const closed = await sidebar({ ...me, provisioned: true, allowNewBot: false });
    expect(closed).not.toContain('aria-label="新建 bot"');
    expect(closed).not.toContain('aria-label="关闭新建"');
    expect(closed).not.toContain('data-testid="bot-name"');
    expect(closed).not.toContain("新建 bot");
    const unprovisioned = await sidebar({ ...me, allowSelfServe: true, allowNewBot: false });
    expect(unprovisioned).toContain('data-testid="self-serve-provision"');
    expect(unprovisioned).not.toContain('aria-label="新建 bot"');
  });

  it("links an unprovisioned apps page to self-serve only when that switch is on", () => {
    const closed = apps(me);
    expect(closed).toContain('data-testid="not-provisioned"');
    expect(closed).toContain("尚未开通，请联系管理员。开通前不能安装。");
    expect(closed).not.toContain("前往自助开通");
    const open = apps({ ...me, allowSelfServe: true });
    expect(open).toContain('data-testid="not-provisioned"');
    expect(open).toContain("尚未开通，请联系管理员。开通前不能安装。");
    expect(open).toContain("前往自助开通");
    expect(open).toMatch(/<a[^>]*href="\/"[^>]*>前往自助开通<\/a>/);
  });
});
