import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@novnc/novnc", () => ({ default: class RFB {} }));
import {
  SECRET_UPDATE_NOTE,
  SecretDeleteDialog,
  SecretsPage,
  secretCreateError,
  secretNameError,
} from "./secrets-page.js";

const PLAIN = "vault-plain-9f3a";

function page(data: { secrets: Array<{ name: string; updatedAt: string; value?: string }> }): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["user-secrets"], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SecretsPage />
    </QueryClientProvider>,
  );
}

describe("secret page", () => {
  it("checks names before they are saved", () => {
    expect(secretNameError("corp_token")).toBeNull();
    expect(secretNameError("a".repeat(64))).toBeNull();
    expect(secretNameError("")).toMatch(/小写/);
    expect(secretNameError("Bad")).toMatch(/小写/);
    expect(secretNameError("bad-name")).toMatch(/小写/);
    expect(secretNameError("app:foo")).toMatch(/小写/);
    expect(secretNameError("a".repeat(65))).toMatch(/小写/);
    expect(secretCreateError("corp_token", ["corp_token"], "next")).toBe("该密钥已存在，请在列表中点击更新");
    expect(secretCreateError("corp_token", [], "")).toBe("密钥内容不能为空");
    expect(secretCreateError("corp_token", [], " ")).toBeNull();
  });

  it("shows names and times, never a stored value", () => {
    const empty = page({ secrets: [] });
    expect(empty).toContain("密钥");
    expect(empty).toContain("还没有保存的密钥");
    expect(empty).toContain("新增密钥");
    expect(empty).not.toContain(PLAIN);

    const html = page({
      secrets: [
        { name: "zeta", updatedAt: "2026-11-22T01:02:03.000Z", value: PLAIN },
        { name: "alpha", updatedAt: "2026-11-21T04:05:06.000Z" },
      ],
    });
    expect(html).toContain("alpha");
    expect(html).toContain("zeta");
    expect(html).toContain("{{secret:alpha}}");
    expect(html).toContain("{{secret:zeta}}");
    expect(html).toContain("2026-11-22T01:02:03.000Z");
    expect(html).toContain(SECRET_UPDATE_NOTE);
    expect(html).not.toContain(PLAIN);
    expect(html.indexOf("alpha")).toBeLessThan(html.indexOf("zeta"));
  });

  it("states what update and delete will do", () => {
    expect(SECRET_UPDATE_NOTE).toBe("保存后会覆盖旧值；正在运行的任务不受影响，下次启动应用或新任务时生效");
    const dialog = renderToStaticMarkup(
      <SecretDeleteDialog name="corp_token" busy={false} onConfirm={() => {}} onClose={() => {}} />,
    );
    expect(dialog).toContain("确定删除密钥 corp_token？如有应用引用它，下次启动该应用时会报错。");
    expect(dialog).not.toContain(PLAIN);
  });

  it("adds a secrets route and a rail link after apps", async () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("window", {
      console,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      location: { pathname: "/secrets", search: "", assign() {} },
      addEventListener() {},
      removeEventListener() {},
      localStorage: { getItem: () => null, setItem() {} },
    });
    vi.stubGlobal("document", {
      documentElement: { dataset: {} },
      activeElement: null,
      querySelector: () => null,
    });
    const { routeTree } = await import("./route-tree.js");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["me"], {
      id: "user-a",
      email: "user-a@example.com",
      name: "Ada",
      isAdmin: true,
      provisioned: true,
      showProcess: false,
      csrf: "tok",
    });
    client.setQueryData(["user-secrets"], { secrets: [] });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/secrets"] }),
    });
    await router.load();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(html).toContain('data-testid="secrets-link"');
    expect(html).toContain("密钥");
    const appsAt = html.indexOf(">应用<");
    const secretsAt = html.indexOf('data-testid="secrets-link"');
    const adminAt = html.indexOf('data-testid="admin-link"');
    expect(appsAt).toBeGreaterThan(-1);
    expect(secretsAt).toBeGreaterThan(appsAt);
    expect(adminAt).toBeGreaterThan(secretsAt);
  });
});
