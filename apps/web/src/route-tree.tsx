import { createRootRoute, createRoute, Outlet } from "@tanstack/react-router";

const rootRoute = createRootRoute({
  component: () => (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Outlet />
    </main>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <section className="mx-auto max-w-lg px-6 py-24">
      <h1 className="text-2xl font-semibold">viate-bot</h1>
      <p className="mt-3 text-neutral-400">控制面骨架。登录和对话界面还没做。</p>
    </section>
  ),
});

export const routeTree = rootRoute.addChildren([indexRoute]);
