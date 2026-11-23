import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApps } from "./admin-apps.js";
import { AppsPage } from "./apps-page.js";
import { isWorkDesktop, resolveMasterId } from "./work-layout.js";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const pageSources = [
  "apps-page.tsx",
  "secrets-page.tsx",
  "admin-apps.tsx",
  "admin-reviews.tsx",
  "admin.tsx",
  "approval.tsx",
  "admin-metrics.tsx",
];

function catalogApp(id: string, name: string, visibility: "all" | "private" = "all") {
  return {
    id,
    name,
    source: "catalog",
    visibility,
    version: { id: `${id}-v`, version: "1.2.3", recommended: true },
  };
}

function renderApps(desktop: boolean): string {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: desktop && query === "(min-width: 1024px)",
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["me"], { id: "u1", name: "Ada", email: "ada@example.com", isAdmin: false, provisioned: true, csrf: "tok" });
  client.setQueryData(["apps"], {
    apps: [catalogApp("id-zeta", "zeta"), catalogApp("id-alpha", "alpha", "private")],
  });
  client.setQueryData(["app-installs"], { installs: [] });
  client.setQueryData(["user-secret-names"], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppsPage />
    </QueryClientProvider>,
  );
}

function renderAdminApps(desktop: boolean): string {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: desktop && query === "(min-width: 1024px)",
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["me"], { id: "u1", name: "Ada", email: "ada@example.com", isAdmin: true, provisioned: true, csrf: "tok" });
  client.setQueryData(["admin-users"], { users: [] });
  client.setQueryData(["admin-apps"], {
    apps: [
      { id: "id-zeta", name: "zeta", source: "catalog", visibility: "hidden", userIds: [], versions: [] },
      { id: "id-alpha", name: "alpha", source: "catalog", visibility: "all", userIds: [], versions: [{ id: "v-alpha", version: "1.0.0", status: "active", recommended: true, sha256: "abc" }] },
    ],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AdminApps />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("master selection", () => {
  it("opens the first visible row on a desktop work page when nothing is chosen", () => {
    expect(resolveMasterId(null, ["zeta", "alpha"], true)).toBe("zeta");
  });

  it("moves a desktop selection to the new first row when the current one is filtered out", () => {
    expect(resolveMasterId("gone", ["next", "later"], true)).toBe("next");
    expect(resolveMasterId("later", ["next", "later"], true)).toBe("later");
  });

  it("leaves the mobile list in place until a visible row is chosen", () => {
    expect(resolveMasterId(null, ["zeta", "alpha"], false)).toBeNull();
    expect(resolveMasterId("gone", ["next"], false)).toBeNull();
    expect(resolveMasterId("next", ["next"], false)).toBe("next");
  });

  it("clears the detail when the desktop list is empty", () => {
    expect(resolveMasterId("kept", [], true)).toBeNull();
  });

  it("treats a missing matchMedia as not desktop so static renders stay on the list", () => {
    expect(isWorkDesktop()).toBe(false);
  });

  it("uses the same initial HTML on a narrow and wide hydration target", () => {
    expect(renderApps(true)).toBe(renderApps(false));
    expect(renderAdminApps(true)).toBe(renderAdminApps(false));
  });
});

describe("apps master layout", () => {
  // Desktop detail and list are verified together in Chrome after hydration.
  it("renders the apps list and search without a detail in initial HTML", () => {
    const html = renderApps(false);
    expect(html).toContain("work-page-wide");
    expect(html).not.toContain("mx-auto");
    expect(html).not.toContain('data-testid="app-detail"');
    expect(html).toContain('data-testid="app-card"');
    expect(html).toContain('data-testid="apps-search"');
    expect(html).toContain(">alpha<");
    expect(html).toContain(">zeta<");
  });

  it("renders the admin list and search without a detail in initial HTML", () => {
    const html = renderAdminApps(false);
    expect(html).toContain("work-page-wide");
    expect(html).not.toContain("mx-auto");
    expect(html).toContain('data-testid="admin-app-search"');
    expect(html).toContain('data-testid="admin-app-row"');
    expect(html).toContain("刷新");
    expect(html).not.toContain('aria-label="应用详情"');
    expect(html).not.toContain("可见范围");
  });
});

describe("work page frame", () => {
  it("defines left-aligned standard and wide frames without auto margins", () => {
    expect(css).toMatch(/\.work-page,\s*\n\.work-page-wide\s*\{[^}]*width:\s*100%/);
    expect(css).toMatch(/\.work-page,\s*\n\.work-page-wide\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.work-page,\s*\n\.work-page-wide\s*\{[^}]*padding:\s*24px 16px/);
    expect(css).toMatch(/\.work-page\s*\{[^}]*max-width:\s*1120px/);
    expect(css).toMatch(/\.work-page-wide\s*\{[^}]*max-width:\s*1360px/);
    expect(css).toMatch(/@media \(min-width:\s*640px\)\s*\{[^}]*\.work-page,\s*\n\s*\.work-page-wide\s*\{[^}]*padding:\s*24px 28px/);
    expect(css).toMatch(/@media \(min-width:\s*1280px\)\s*\{[^}]*\.work-page,\s*\n\s*\.work-page-wide\s*\{[^}]*padding:\s*28px 32px/);
    expect(css).not.toMatch(/\.work-page[^{]*\{[^}]*margin(?:-inline)?:\s*auto/);
    expect(css).toMatch(/minmax\(19rem,\s*23rem\)\s+minmax\(0,\s*1fr\)/);
  });

  it("does not center the work pages with mx-auto", () => {
    for (const name of pageSources) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
      expect(source, name).not.toContain("mx-auto");
      expect(source, name).toMatch(/work-page(?:-wide)?/);
    }
  });
});
