import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { api, rememberCsrf, type Me } from "./api.js";
import { BotList } from "./bots.js";
import { ChatPage } from "./chat.js";

const rootRoute = createRootRoute({
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: BotList,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/b/$botId",
  component: function ChatRoute() {
    const { botId } = chatRoute.useParams();
    return <ChatPage botId={botId} />;
  },
});

export const routeTree = rootRoute.addChildren([indexRoute, chatRoute]);

function Shell() {
  const queryClient = useQueryClient();
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

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3 text-sm">
        <span>viate-bot</span>
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
