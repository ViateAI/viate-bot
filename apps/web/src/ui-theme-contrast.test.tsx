import { readFileSync } from "node:fs";
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
import { BotSidebar } from "./bots.js";

vi.mock("./computer.js", () => ({ Computer: () => null }));
vi.mock("./routines.js", () => ({ Routines: () => null }));
vi.mock("./approval.js", () => ({ ApprovalList: () => null, ApprovalRules: () => null }));

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

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

type Rgb = { r: number; g: number; b: number; a: number };

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

function themeVars(theme: "light" | "dark"): Record<string, string> {
  const marker = theme === "dark" ? '[data-theme="dark"]' : ":root";
  const start = css.indexOf(marker);
  const open = css.indexOf("{", start);
  const body = braceBlock(css, open);
  const vars: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[match[1]!] = match[2]!.trim();
  return vars;
}

function parseColor(input: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(input);
  if (hex) {
    const n = hex[1]!;
    return { r: Number.parseInt(n.slice(0, 2), 16), g: Number.parseInt(n.slice(2, 4), 16), b: Number.parseInt(n.slice(4, 6), 16), a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(input);
  if (!rgba) throw new Error(`unparsed color ${input}`);
  return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
}

function resolveColor(input: string, vars: Record<string, string>): Rgb {
  const value = input.trim();
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  return parseColor(ref ? vars[ref[1]!]! : value);
}

function composite(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrast(fg: Rgb, bg: Rgb): number {
  const lum = (color: Rgb) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  const a = lum(fg);
  const b = lum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function cssRules(): Array<{ selector: string; body: string }> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
}

function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) out[match[1]!] = match[2]!.trim();
  return out;
}

function fontPx(className: string): number {
  const arbitrary = /(?:^|\s)text-\[(\d+(?:\.\d+)?)px\](?:\s|$)/.exec(className);
  if (arbitrary) return Number(arbitrary[1]);
  const named: Record<string, number> = { "text-xs": 12, "text-sm": 14, "text-base": 16 };
  for (const token of className.split(/\s+/)) {
    if (named[token] !== undefined) return named[token];
  }
  return 0;
}

describe("light theme AA and functional text size", () => {
  it("keeps muted text, placeholders, and the selected app badge at 4.5:1 without flattening the type ramp", () => {
    const light = themeVars("light");
    const dark = themeVars("dark");
    const pairs: Array<[string, string]> = [
      ["fg-muted", "bg-canvas"],
      ["fg-muted", "bg-surface"],
      ["fg-muted", "bg-chrome"],
      ["fg-muted", "bg-active"],
    ];
    for (const [fg, bg] of pairs) {
      expect(contrast(resolveColor(light[fg]!, light), resolveColor(light[bg]!, light)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    const onWhite = (name: string) => contrast(resolveColor(light[name]!, light), resolveColor("#ffffff", light));
    expect(onWhite("fg-muted")).toBeLessThan(onWhite("fg-secondary"));
    expect(onWhite("fg-secondary")).toBeLessThan(onWhite("fg-primary"));

    const placeholder = cssRules().find((rule) => /(^|,)\s*input::placeholder/.test(rule.selector) && rule.selector.includes("textarea::placeholder") && !rule.selector.includes('data-theme="dark"'));
    expect(placeholder, "light input/textarea placeholder color").toBeTruthy();
    const placeholderDecls = decls(placeholder!.body);
    expect(placeholderDecls.opacity).toBe("1");
    const placeholderInk = resolveColor(placeholderDecls.color!, light);
    expect(contrast(placeholderInk, resolveColor("#ffffff", light))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(placeholderInk, resolveColor(light["bg-surface"]!, light))).toBeGreaterThanOrEqual(4.5);

    const badgeRules = cssRules().filter((rule) => rule.selector.includes(".app-row.is-selected") && rule.selector.includes(".app-row-badge"));
    const badge: Record<string, string> = {};
    for (const rule of badgeRules) {
      const lightOnly = rule.selector.includes('data-theme="light"');
      const darkOnly = rule.selector.includes('data-theme="dark"');
      if (darkOnly && !lightOnly) continue;
      Object.assign(badge, decls(rule.body));
    }
    const row = resolveColor(light["bg-active"]!, light);
    const badgeBg = composite(resolveColor(badge.background!, light), row);
    const badgeFg = resolveColor(badge.color!, light);
    expect(contrast(badgeFg, badgeBg)).toBeGreaterThanOrEqual(4.5);

    for (const [fg, bg] of [
      ["fg-muted", "bg-chrome"],
      ["fg-muted", "bg-canvas"],
      ["fg-muted", "bg-surface"],
      ["fg-muted", "bg-elevated"],
    ] as const) {
      expect(contrast(resolveColor(dark[fg]!, dark), resolveColor(dark[bg]!, dark)), `dark ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("sizes rail labels and the primary-bot mark at the 11px functional floor", async () => {
    const rail = cssRules().find((rule) => rule.selector === ".rail-btn");
    expect(rail).toBeTruthy();
    const size = /^(\d+(?:\.\d+)?)px$/.exec(decls(rail!.body)["font-size"] ?? "");
    expect(size).toBeTruthy();
    expect(Number(size![1])).toBeGreaterThanOrEqual(11);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const bot = { id: "bot-1", name: "通用助手", bio: "", avatar: null, model: "fake", instructions: "", primary: true };
    client.setQueryData(["me"], { id: "u1", name: "Ada", email: "ada@example.com", isAdmin: false, provisioned: true, csrf: "tok" });
    client.setQueryData(["bots"], { bots: [bot] });
    client.setQueryData(["models"], { models: ["fake"], unrestricted: false });
    client.setQueryData(["bot", "bot-1"], { bot });
    client.setQueryData(["conversations", "bot-1"], { conversations: [] });
    client.setQueryData(["memories", "bot-1"], { memories: [] });
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
      component: () => (
        <>
          <BotSidebar activeId="bot-1" />
          <ChatPage botId="bot-1" />
        </>
      ),
    });
    const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }) });
    await router.load();
    const html = renderToStaticMarkup(<RouterProvider router={router} />);
    const marks = [...html.matchAll(/<span[^>]*data-testid="primary-bot"[^>]*>/g)].map((match) => match[0]);
    expect(marks.length).toBeGreaterThanOrEqual(2);
    for (const mark of marks) {
      const className = /class="([^"]*)"/.exec(mark)?.[1] ?? "";
      expect(fontPx(className)).toBeGreaterThanOrEqual(11);
    }
  });
});
