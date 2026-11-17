import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, createRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { AdminApps } from "./admin-apps.js";
import { AdminLayout, AdminMachines, AdminSettings, AdminTemplates, AdminUsers } from "./admin.js";
import { AppsPage } from "./apps-page.js";
import { AdminAudit, AdminMetrics } from "./admin-metrics.js";
import { Approvals } from "./approval.js";
import { api, rememberCsrf, type Me } from "./api.js";
import { BotSidebar } from "./bots.js";
import { ChatPage } from "./chat.js";

const rootRoute = createRootRoute({
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: function Home() {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center px-8 text-sm text-neutral-500">
        从左侧选择一个 bot
      </div>
    );
  },
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/b/$botId",
  component: function ChatRoute() {
    const { botId } = chatRoute.useParams();
    return <ChatPage botId={botId} />;
  },
});

const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals",
  component: Approvals,
});

const appsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps",
  component: AppsPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminLayout,
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminUsers,
});

const adminMachinesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "machines",
  component: AdminMachines,
});

const adminTemplatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "templates",
  component: AdminTemplates,
});

const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "settings",
  component: AdminSettings,
});

const adminMetricsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "metrics",
  component: AdminMetrics,
});

const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "audit",
  component: AdminAudit,
});

const adminAppsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "apps",
  component: AdminApps,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  approvalsRoute,
  appsRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    adminMachinesRoute,
    adminTemplatesRoute,
    adminSettingsRoute,
    adminMetricsRoute,
    adminAuditRoute,
    adminAppsRoute,
  ]),
]);

function Shell() {
  const queryClient = useQueryClient();
  const { workspace, botId } = useWorkspace();
  const me = useQuery({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      const user = await api<Me>("/api/me");
      rememberCsrf(user.csrf);
      return user;
    },
  });

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    queryClient.clear();
    window.location.assign("/auth/login");
  }

  if (workspace && me.data) {
    return (
      <main className="flex h-dvh overflow-hidden bg-[#f5f5f5] text-neutral-900" style={{ colorScheme: "light" }}>
        <BotSidebar activeId={botId} onLogout={() => void logout()} />
        <div className={`${botId ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1`}>
          <Outlet />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3 text-sm">
        <span className="flex items-center gap-4">
          <Link to="/" className="font-medium text-neutral-100">
            viate-bot
          </Link>
          <Link to="/approvals" className="text-neutral-300">
            批准
          </Link>
          <Link to="/apps" className="text-neutral-300">
            应用
          </Link>
          {me.data?.isAdmin ? (
            <Link to="/admin" data-testid="admin-link" className="text-neutral-300">
              管理
            </Link>
          ) : null}
        </span>
        {me.data ? (
          <button className="text-neutral-400" type="button" onClick={() => void logout()}>
            退出 {me.data.name}
          </button>
        ) : null}
      </header>
      {me.isPending ? <p className="px-6 py-10 text-neutral-400">正在确认登录…</p> : null}
      {me.isError ? <p className="px-6 py-10 text-neutral-400">需要登录。</p> : null}
      {me.data ? <Outlet /> : null}
    </main>
  );
}

function useWorkspace(): { workspace: boolean; botId?: string | undefined } {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const botMatch = /^\/b\/([^/]+)$/.exec(pathname);
  let botId: string | undefined;
  if (botMatch?.[1]) {
    try {
      botId = decodeURIComponent(botMatch[1]);
    } catch {
      botId = botMatch[1];
    }
  }
  return { workspace: pathname === "/" || Boolean(botId), botId };
}
