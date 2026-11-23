import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, createRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AdminApps } from "./admin-apps.js";
import { AdminReviews } from "./admin-reviews.js";
import { AdminLayout, AdminMachines, AdminNav, AdminSettings, AdminTemplates, AdminUsers } from "./admin.js";
import { AppsPage } from "./apps-page.js";
import { SecretsPage } from "./secrets-page.js";
import { AdminAudit, AdminMetrics } from "./admin-metrics.js";
import { Approvals } from "./approval.js";
import { api, rememberCsrf, type Me } from "./api.js";
import { BotSidebar } from "./bots.js";
import { ChatPage } from "./chat.js";
import { initials } from "./presence.js";
import { useTheme } from "./theme.js";
import { workPageFrame } from "./work-layout.js";

const ShellUI = createContext<{ openDrawer: () => void }>({ openDrawer: () => {} });

const rootRoute = createRootRoute({
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: function Home() {
    const { openDrawer } = useContext(ShellUI);
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-6 text-center text-sm text-muted">
        <div className="grid gap-3">
          <p>从左侧选择一个 bot</p>
          <button type="button" className="home-open ui-btn-ghost mx-auto" onClick={openDrawer}>
            打开伙伴
          </button>
        </div>
      </div>
    );
  },
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/b/$botId",
  validateSearch: (search: Record<string, unknown>): { conversationId?: string } =>
    typeof search.conversationId === "string" ? { conversationId: search.conversationId } : {},
  component: function ChatRoute() {
    const { botId } = chatRoute.useParams();
    const { conversationId } = chatRoute.useSearch();
    return <ChatPage botId={botId} requestedConversationId={conversationId} />;
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

const secretsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/secrets",
  component: SecretsPage,
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

const adminReviewsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "app-reviews",
  component: AdminReviews,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  approvalsRoute,
  appsRoute,
  secretsRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    adminMachinesRoute,
    adminTemplatesRoute,
    adminSettingsRoute,
    adminMetricsRoute,
    adminAuditRoute,
    adminAppsRoute,
    adminReviewsRoute,
  ]),
]);

function Shell() {
  const queryClient = useQueryClient();
  const { workspace, admin, botId, pathname } = usePlace();
  const { theme, toggleTheme } = useTheme();
  const [drawer, setDrawer] = useState(false);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  const me = useQuery({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      const user = await api<Me>("/api/me");
      rememberCsrf(user.csrf);
      return user;
    },
  });

  useEffect(() => {
    const mobile = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 799px)").matches;
    setDrawer(mobile && pathname === "/");
  }, [pathname]);

  function openDrawer() {
    if (document.activeElement instanceof HTMLElement) drawerTriggerRef.current = document.activeElement;
    setDrawer(true);
  }

  function closeDrawer() {
    setDrawer(false);
    drawerTriggerRef.current?.focus();
  }

  useEffect(() => {
    if (!drawer) return;
    drawerCloseRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    queryClient.clear();
    window.location.assign("/auth/login");
  }

  const showRoster = workspace && Boolean(me.data);
  const showAdminNav = admin && Boolean(me.data?.isAdmin);
  const shellClass = showAdminNav ? "shell-admin" : showRoster ? "shell-user" : "shell-stage";
  const authFrame = workPageFrame(pathname) ?? "px-6 py-10";

  return (
    <ShellUI.Provider value={{ openDrawer }}>
      <div className={`app-shell ${shellClass}`}>
        <Rail
          me={me.data}
          workspace={workspace}
          admin={admin}
          pathname={pathname}
          theme={theme}
          onToggleTheme={toggleTheme}
          onLogout={() => void logout()}
        />
        {showRoster ? (
          <div
            className={`drawer-col ${drawer ? "is-open" : ""}`}
            onClick={(event) => {
              if (drawer && (event.target as HTMLElement).closest("a")) setDrawer(false);
            }}
          >
            <div className="drawer-close-bar">
              <button ref={drawerCloseRef} type="button" className="ui-btn-ghost" onClick={closeDrawer}>
                关闭
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <BotSidebar activeId={botId} />
            </div>
          </div>
        ) : null}
        {showAdminNav ? (
          <div
            className={`drawer-col ${drawer ? "is-open" : ""}`}
            onClick={(event) => {
              if (drawer && (event.target as HTMLElement).closest("a")) setDrawer(false);
            }}
          >
            <div className="drawer-close-bar">
              <button ref={drawerCloseRef} type="button" className="ui-btn-ghost" onClick={closeDrawer}>
                关闭
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <AdminNav />
            </div>
          </div>
        ) : null}
        <div className="stage-col">
          {showAdminNav ? (
            <div className="mobile-drawer-bar">
              <button type="button" className="ui-btn-ghost" onClick={openDrawer}>
                栏目
              </button>
            </div>
          ) : null}
          <div className="stage-fill">
            {me.isPending ? <p className={`${authFrame} text-muted`}>正在确认登录…</p> : null}
            {me.isError ? <p className={`${authFrame} text-muted`}>需要登录。</p> : null}
            {me.data ? <Outlet /> : null}
          </div>
        </div>
        {drawer && (showRoster || showAdminNav) ? (
          <button type="button" className="drawer-scrim" aria-label="关闭" onClick={closeDrawer} />
        ) : null}
      </div>
    </ShellUI.Provider>
  );
}

function Rail({
  me,
  workspace,
  admin,
  pathname,
  theme,
  onToggleTheme,
  onLogout,
}: {
  me: Me | undefined;
  workspace: boolean;
  admin: boolean;
  pathname: string;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onLogout: () => void;
}) {
  return (
    <nav className="rail" aria-label="主导航">
      <span className="rail-logo" aria-hidden>
        <Mark />
      </span>
      <RailLink label="对话" active={workspace} to="/">
        <ChatIcon />
      </RailLink>
      <RailLink label="批准" active={pathname === "/approvals"} to="/approvals">
        <CheckIcon />
      </RailLink>
      <RailLink label="应用" active={pathname === "/apps"} to="/apps">
        <GridIcon />
      </RailLink>
      <RailLink label="密钥" active={pathname === "/secrets"} to="/secrets" testId="secrets-link">
        <KeyIcon />
      </RailLink>
      {me?.isAdmin ? (
        <RailLink label="管理" active={admin} to="/admin" testId="admin-link">
          <ShieldIcon />
        </RailLink>
      ) : null}
      <span className="rail-spacer" />
      <button type="button" className="rail-btn" onClick={onToggleTheme}>
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        {theme === "dark" ? "晨雾" : "夜航"}
      </button>
      {me ? (
        <details className="me">
          <summary aria-label={`${me.name} 菜单`}>
            <span className="person">{initials(me.name)}</span>
          </summary>
          <div className="me-pop">
            <strong>{me.name}</strong>
            <p>{me.email}</p>
            <button type="button" className="ui-btn-ghost" onClick={onLogout}>
              退出
            </button>
          </div>
        </details>
      ) : null}
    </nav>
  );
}

function RailLink({
  to,
  label,
  active,
  testId,
  children,
}: {
  to: "/" | "/approvals" | "/apps" | "/secrets" | "/admin";
  label: string;
  active: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} data-testid={testId} className={`rail-btn${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined}>
      {children}
      {label}
    </Link>
  );
}

function usePlace(): { workspace: boolean; admin: boolean; botId?: string | undefined; pathname: string } {
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
  return {
    workspace: pathname === "/" || Boolean(botId),
    admin: pathname === "/admin" || pathname.startsWith("/admin/"),
    botId,
    pathname,
  };
}

function Mark() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
      <rect x="3" y="3" width="26" height="26" rx="8" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="16" cy="16" r="4" fill="currentColor" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M5 6.5h14v8.2a2 2 0 0 1-2 2H9l-4 3v-3.2" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="7.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m8.8 12.2 2.2 2.2 4.3-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.6" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="8.2" cy="14.2" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 14.2h8.5M16.2 14.2v2.5M19 14.2v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M12 4.5 18.5 7v5.2c0 3.4-2.4 5.8-6.5 7.3-4.1-1.5-6.5-3.9-6.5-7.3V7L12 4.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 4.5v1.8M12 17.7v1.8M4.5 12h1.8M17.7 12h1.8M6.7 6.7l1.3 1.3M16 16l1.3 1.3M17.3 6.7 16 8M8 16l-1.3 1.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M15.5 5.2A7.2 7.2 0 1 0 18.8 15 5.6 5.6 0 0 1 15.5 5.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
