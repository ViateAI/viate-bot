import assert from "node:assert/strict";
import type { Browser, Locator, Page } from "playwright-core";

const first = { id: "first", name: "alpha", source: "catalog", visibility: "all", userIds: [], versions: [] };
const second = { ...first, id: "second", name: "beta" };
const newApp = { ...first, id: "new", name: "new-tool", visibility: "hidden" };
const secretName = "a".repeat(64);
const longError = "error".repeat(100);
const value = "test-only-value";
const stamp = "2026-01-01T00:00:00.000Z";
const review = { id: "first", name: "alpha", version: "1.0.0", kinds: ["MCP"], requester: "Ada", bot: null, createdAt: stamp, state: "pending" };
const catalog = [first, second, ...Array.from({ length: 22 }, (_, i) => ({ id: `tool-${i}`, name: `tool-${String(i).padStart(2, "0")}`, visibility: "private" }))]
  .map((app) => ({ ...app, source: "catalog", version: { id: `v-${app.id}`, version: "1.0.0", recommended: true } }));

async function fixtures(page: Page, options: { meStatus?: number; isAdmin?: boolean; emptySecrets?: boolean } = {}) {
  let adminApps = [first, second];
  let catalogApps = catalog;
  let failApps = false;
  let failUpdate = true;
  let requests = [review];
  const secrets = options.emptySecrets ? [] : [{ name: secretName, updatedAt: stamp }, { name: "beta", updatedAt: stamp }];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const send = (json: object, status = 200) => route.fulfill({ status, json });
    if (path === "/api/me") return options.meStatus
      ? send({ error: "not signed in" }, options.meStatus)
      : send({ id: "u1", name: "Ada", email: "ada@example.com", isAdmin: options.isAdmin ?? true, provisioned: true, csrf: "fixture-csrf" });
    if (path === "/api/apps") return send({ apps: catalogApps });
    if (path === "/api/apps/installs") return send({ installs: [] });
    if (path === "/api/apps/private") {
      const app = { ...newApp, visibility: "private" };
      catalogApps = [...catalogApps, { ...app, version: { id: "v-new", version: "1.0.0", recommended: true } }];
      return send({ appId: app.id, name: app.name, version: "1.0.0", warnings: [] });
    }
    if (path === "/api/admin/apps") return failApps ? send({ error: "refresh failed" }, 500) : send({ apps: adminApps });
    if (path === "/api/admin/apps/upload") {
      adminApps = [...adminApps, newApp];
      return send({ appId: newApp.id, name: newApp.name, version: "1.0.0", warnings: [] });
    }
    if (path === "/api/admin/users") return send({ users: [] });
    if (path === "/api/admin/app-reviews") return send({ pendingCount: requests.length, requests });
    if (path === "/api/admin/app-reviews/first/approve") {
      requests = [];
      return send({});
    }
    if (path === "/api/admin/app-reviews/first") return send({ ...review, manifest: "{}", note: "测试说明", sha256: "a".repeat(64), files: [], mcp: [], config: [], routines: [], diff: null });
    if (path === "/api/approvals") return send({ approvals: [{ id: "tool-approval", taskId: "test-task", tool: "mcp_call", args: { tool: "search" } }] });
    if (path === "/api/secrets") return send({ secrets });
    if (path.startsWith("/api/secrets/")) {
      const name = path.slice("/api/secrets/".length);
      if (method === "DELETE") return send({ error: longError }, 400);
      if (name === secretName && failUpdate) {
        failUpdate = false;
        return send({ error: longError }, 400);
      }
      if (!secrets.some((item) => item.name === name)) secrets.push({ name, updatedAt: stamp });
      return send({ value }); // Deliberately hostile response: never render the value.
    }
    return send({});
  });
  return { rejectAppRefresh: () => { failApps = true; } };
}

async function visible(locator: Locator) {
  await locator.waitFor({ state: "visible" });
}

async function noOverflow(page: Page) {
  const overflows = await page.locator("html, .stage-fill, .work-page, .work-page-wide").evaluateAll((nodes) =>
    nodes.filter((node) => node.scrollWidth > node.clientWidth).map((node) => node.className || node.tagName));
  assert.deepEqual(overflows, [], "横向溢出");
}

const cases = {
  async "work route auth states use the same left-aligned frame"(page: Page, baseURL: string) {
    await fixtures(page, { meStatus: 403 });
    await page.goto(`${baseURL}/apps`);
    const auth = page.getByText("需要登录。", { exact: true });
    await visible(auth);
    assert.equal(await auth.evaluate((el) => el.getBoundingClientRect().width), 1360);
    assert.equal(await auth.evaluate((el) => el.getBoundingClientRect().left), await page.locator(".stage-fill").evaluate((el) => el.getBoundingClientRect().left));
    await fixtures(page, { isAdmin: false });
    await page.goto(`${baseURL}/admin/templates`);
    const denied = page.getByTestId("not-found");
    await visible(denied);
    assert.equal(await denied.evaluate((el) => el.getBoundingClientRect().width), 1120);
  },

  async "apps default, empty results, breakpoint changes, and mobile return"(page: Page, baseURL: string) {
    await fixtures(page);
    await page.goto(`${baseURL}/apps`);
    const detail = page.getByTestId("app-detail");
    const search = page.getByTestId("apps-search");
    const rows = page.getByTestId("app-card");
    await visible(detail.getByRole("heading", { name: "alpha", exact: true }));
    await visible(search);
    assert.equal(await rows.count(), catalog.length);
    assert.equal(await detail.getByRole("heading", { name: "beta", exact: true }).count(), 0);
    assert.equal(await search.evaluate((input) => input.getBoundingClientRect().left) < await detail.evaluate((panel) => panel.getBoundingClientRect().left), true);
    await rows.filter({ hasText: "beta" }).click();
    await search.fill("no match");
    assert.equal(await page.getByText("没有匹配的应用。", { exact: true }).count(), 2, "详情应显示无匹配，而非一直刷新");
    await search.fill("alpha");
    await visible(detail.getByRole("heading", { name: "alpha", exact: true }));
    await page.setViewportSize({ width: 1023, height: 812 });
    await visible(search);
    await detail.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 1024, height: 812 });
    await visible(detail.getByRole("heading", { name: "alpha", exact: true }));
    await page.setViewportSize({ width: 375, height: 812 });
    await detail.waitFor({ state: "detached" });
    await page.getByTestId("apps-filter-private").click();
    await search.fill("tool-");
    const row = rows.filter({ hasText: "tool-15" });
    await row.scrollIntoViewIfNeeded();
    const scroll = await page.locator(".stage-fill").evaluate((el) => el.scrollTop);
    assert.ok(scroll > 0);
    await row.press("Enter");
    await visible(detail.getByRole("heading", { name: "tool-15", exact: true }));
    assert.equal(await search.isVisible(), false);
    await detail.getByRole("button", { name: "返回", exact: true }).press("Enter");
    await visible(search);
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-app-id") === "tool-15");
    assert.equal(await search.inputValue(), "tool-");
    assert.equal(await page.getByTestId("apps-filter-private").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".stage-fill").evaluate((el) => el.scrollTop), scroll);
    await noOverflow(page);
  },

  async "private app creation selects the new item despite old filters"(page: Page, baseURL: string) {
    await fixtures(page);
    await page.goto(`${baseURL}/apps`);
    const search = page.getByTestId("apps-search");
    await search.fill("alpha");
    await page.getByTestId("app-private-open").click();
    await page.getByRole("button", { name: /MCP/ }).click();
    await page.getByTestId("app-private-name").fill(newApp.name);
    await page.getByTestId("app-private-url").fill("https://example.test/mcp");
    await page.getByTestId("app-private-submit").click();
    await visible(page.getByTestId("app-detail").getByRole("heading", { name: newApp.name, exact: true }));
    assert.equal(await search.inputValue(), "");
    assert.equal(await page.getByTestId("apps-filter-private").getAttribute("aria-pressed"), "true");
  },

  async "admin default editor survives filtering, resize and refresh failure until discard"(page: Page, baseURL: string) {
    const { rejectAppRefresh } = await fixtures(page);
    await page.goto(`${baseURL}/admin/apps`);
    const detail = page.getByRole("article", { name: "应用详情" });
    const search = page.getByTestId("admin-app-search");
    const alpha = detail.getByRole("heading", { name: "alpha", exact: true });
    const scope = detail.getByRole("button", { name: "仅推送", exact: true });
    await visible(alpha);
    await visible(search);
    assert.equal(await page.getByTestId("admin-app-row").count(), 2);
    assert.equal(await detail.getByRole("heading", { name: "beta", exact: true }).count(), 0);
    assert.equal(await search.evaluate((input) => input.getBoundingClientRect().left) < await detail.evaluate((panel) => panel.getBoundingClientRect().left), true);
    await scope.click();
    await search.fill("beta");
    assert.equal(await alpha.isVisible(), true, "筛选不得卸载未保存的桌面默认编辑器");
    assert.equal(await scope.getAttribute("aria-pressed"), "true");
    await page.setViewportSize({ width: 375, height: 812 });
    await visible(alpha);
    await detail.getByRole("button", { name: "返回", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "还有未保存的修改" });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await scope.getAttribute("aria-pressed"), "true");
    rejectAppRefresh();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await visible(page.getByRole("alert").filter({ hasText: "refresh failed" }));
    await visible(alpha);
    await detail.getByRole("button", { name: "返回", exact: true }).click();
    await dialog.getByRole("button", { name: "离开", exact: true }).click();
    await visible(search);
    assert.equal(await search.inputValue(), "beta");
    assert.equal(await detail.count(), 0);
    await page.getByTestId("admin-app-row").filter({ hasText: "beta" }).click();
    await visible(detail.getByRole("heading", { name: "beta", exact: true }));
  },

  async "admin upload selects the new app even after a prior search"(page: Page, baseURL: string) {
    await fixtures(page);
    await page.goto(`${baseURL}/admin/apps`);
    const search = page.getByTestId("admin-app-search");
    await search.fill("alpha");
    await page.getByRole("button", { name: "上传", exact: true }).click();
    await page.getByTestId("admin-app-file").setInputFiles({ name: "test.zip", mimeType: "application/zip", buffer: Buffer.from("mock upload") });
    await page.getByTestId("admin-upload-submit").click();
    await visible(page.getByText("已上传 new-tool 1.0.0。新应用保持未公开，直到你保存可见范围。", { exact: true }));
    assert.equal(await search.inputValue(), "");
    await visible(page.getByRole("article", { name: "应用详情" }).getByRole("heading", { name: newApp.name, exact: true }));
  },

  async "review list does not open mobile detail and falls back after decision"(page: Page, baseURL: string) {
    await fixtures(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/admin/app-reviews`);
    const row = page.getByTestId("admin-review-first");
    const detail = page.getByTestId("admin-review-detail");
    await visible(row);
    assert.equal(await detail.count(), 0, "手机应停在列表");
    assert.equal(await row.getAttribute("aria-pressed"), null);
    assert.ok((await row.boundingBox())!.height >= 44);
    await row.press("Enter");
    await visible(detail);
    assert.equal(await row.isVisible(), false);
    const back = page.getByRole("button", { name: "返回", exact: true });
    assert.ok((await back.boundingBox())!.height >= 44);
    await back.press("Enter");
    await visible(row);
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "admin-review-first");
    await page.setViewportSize({ width: 1280, height: 800 });
    await visible(detail);
    await visible(row);
    assert.equal(await row.getAttribute("aria-pressed"), "true");
    await page.getByTestId("admin-review-approve").click();
    await visible(page.getByText("没有发布申请"));
    await detail.waitFor({ state: "detached" });
  },

  async "secret actions stay grouped and keyboard update closes after save"(page: Page, baseURL: string) {
    await fixtures(page);
    await page.goto(`${baseURL}/secrets`);
    const row = page.getByRole("list", { name: "密钥列表" }).getByRole("listitem").filter({ hasText: secretName });
    // Native summary was previously exposed as a disclosure, not a button.
    const edit = row.getByText("更新值", { exact: true });
    const remove = row.getByRole("button", { name: "删除", exact: true });
    await visible(edit);
    const before = (await edit.boundingBox())!;
    await edit.press("Enter");
    const after = (await edit.boundingBox())!;
    const removeBox = (await remove.boundingBox())!;
    assert.equal(after.y, before.y, "展开不应移动更新按钮");
    assert.equal(after.y, removeBox.y);
    assert.ok(removeBox.x - (after.x + after.width) <= 12);
    assert.ok(after.height >= 44 && removeBox.height >= 44);
    assert.equal(await edit.getAttribute("aria-expanded"), "true");
    await page.setViewportSize({ width: 375, height: 812 });
    const input = row.getByLabel("新的密钥值");
    assert.equal(await input.getAttribute("type"), "password");
    await input.fill(value);
    const save = row.getByRole("button", { name: "保存新值" });
    await save.click();
    await visible(row.getByRole("alert").filter({ hasText: longError }));
    await noOverflow(page);
    await save.click();
    await visible(page.getByRole("status").filter({ hasText: "已更新" }));
    assert.equal(await input.isVisible(), false);
    assert.equal(await edit.getAttribute("aria-expanded"), "false");
    await page.waitForFunction(() => document.activeElement?.textContent === "更新值");
    assert.equal(await page.getByText(value, { exact: true }).count(), 0);
    await remove.click();
    await page.getByRole("dialog", { name: "删除密钥" }).getByRole("button", { name: "删除", exact: true }).click();
    await visible(page.getByRole("alert").filter({ hasText: longError }));
    await noOverflow(page);
  },

  async "secret create clears cancelled input and focuses the empty-state CTA target"(page: Page, baseURL: string) {
    await fixtures(page, { emptySecrets: true });
    await page.goto(`${baseURL}/secrets`);
    const create = page.getByRole("button", { name: "新增密钥", exact: true, expanded: true });
    const emptyCTA = page.getByText("还没有保存的密钥").locator("..").getByRole("button", { name: "新增密钥" });
    const name = page.getByLabel(/^密钥名/);
    await emptyCTA.click();
    assert.equal(await name.evaluate((el) => el === document.activeElement), true);
    await name.fill("discarded");
    await page.getByLabel("密钥值", { exact: true }).fill(value);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    const closed = page.getByRole("button", { name: "新增密钥", exact: true, expanded: false });
    assert.equal(await closed.evaluate((el) => el === document.activeElement), true);
    await closed.press("Enter");
    await visible(create);
    assert.equal(await name.inputValue(), "");
    assert.equal(await page.getByLabel("密钥值", { exact: true }).inputValue(), "");
    await name.fill("alpha");
    await page.getByLabel("密钥值", { exact: true }).fill(value);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await visible(page.getByRole("status").filter({ hasText: "已保存" }));
    assert.equal(await name.isVisible(), false);
    await visible(page.getByText("{{secret:alpha}}", { exact: true }));
    assert.equal(await closed.evaluate((el) => el === document.activeElement), true);
  },

  async "work approval actions meet the mobile touch target"(page: Page, baseURL: string) {
    await fixtures(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/approvals`);
    const card = page.getByTestId("approval-item");
    await visible(card);
    for (const action of await card.getByRole("button").all()) assert.ok((await action.boundingBox())!.height >= 44);
    await noOverflow(page);
  },

  async "mobile user cards keep a long email readable without scrolling or overlapping status"(page: Page, baseURL: string) {
    await fixtures(page);
    await page.route("**/api/admin/machines", (route) => route.fulfill({ json: { machines: [] } }));
    const email = `${"long-account-name-".repeat(3)}@example.com`;
    await page.route("**/api/admin/users", (route) => route.fulfill({ json: {
      users: [{ id: "u1", email, name: "Ada", status: "active", provisioned: true, botCount: 1, tasks7d: 0 }],
    } }));
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/admin`);
    const row = page.getByTestId("user-row");
    await visible(row);
    assert.equal(await row.evaluate((el) => {
      const cell = el.firstElementChild!;
      const status = el.children[2]!;
      const container = el.closest("table")!.parentElement!;
      const range = document.createRange();
      range.selectNodeContents(cell);
      const cellRect = cell.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      return container.scrollWidth === container.clientWidth && [...range.getClientRects()].every((line) =>
        line.right <= cellRect.right + 1 && (line.right <= statusRect.left + 1 || line.bottom <= statusRect.top + 1));
    }), true, "长邮箱不得溢出卡片或遮挡状态");
    await visible(row.getByRole("cell", { name: email, exact: true }));
    await visible(row.getByTestId("quota-editor"));
    await noOverflow(page);
  },

  async "chat tables wrap prose but scroll many columns and long code locally"(page: Page, baseURL: string) {
    await fixtures(page);
    const longCell = "这是一段需要自然换行才能读完的正文说明".repeat(3);
    const shortCells = Array.from({ length: 8 }, () => "简短内容");
    const tablesMarkdown = [
      [["名称", "说明", "编号"], ["普通条目", longCell, "一"]],
      [shortCells, shortCells],
    ].map(([headers, row]) => [headers!, headers!.map(() => "---"), row!].map((columns) => `| ${columns.join(" | ")} |`).join("\n"));
    const text = [...tablesMarkdown,
      "行内 `example` 保持行内。", "```\nconst sample = '" + "abcdef0123456789".repeat(10) + "';\n```"].join("\n\n");
    const bot = { id: "b1", name: "通用", bio: "", instructions: "", avatar: null, model: "test", primary: true };
    await page.route("**/api/bots", (route) => route.fulfill({ json: { bots: [bot] } }));
    await page.route("**/api/bots/b1", (route) => route.fulfill({ json: { bot } }));
    await page.route("**/api/bots/b1/conversations", (route) => route.fulfill({ json: { conversations: [{ id: "c1" }] } }));
    await page.route("**/api/bots/b1/routines", (route) => route.fulfill({ json: { routines: [] } }));
    await page.route("**/api/bots/b1/approval-rules", (route) => route.fulfill({ json: { rules: [] } }));
    await page.route("**/api/conversations/c1/tasks", (route) => route.fulfill({ json: { tasks: [] } }));
    await page.route("**/api/conversations/c1/messages", (route) => route.fulfill({ json: {
      messages: [{ id: "a1", role: "assistant", text, taskId: null, createdAt: stamp }],
    } }));
    await page.goto(`${baseURL}/b/b1`);
    const prose = page.getByRole("cell", { name: longCell, exact: true });
    await visible(prose);
    assert.equal(await prose.evaluate((cell) => {
      const wrap = cell.closest("table")!.parentElement!;
      const range = document.createRange();
      range.selectNodeContents(cell);
      return wrap.scrollWidth === wrap.clientWidth && range.getClientRects().length > 1;
    }), true, "普通三列表格的长说明应自然换行，不应强制整表横滚");
    await page.setViewportSize({ width: 375, height: 812 });
    const tables = page.getByRole("table");
    assert.equal(await tables.count(), 2);
    assert.equal(await tables.nth(1).evaluate((el) => {
      const wrap = el.parentElement!;
      return wrap.scrollWidth > wrap.clientWidth && getComputedStyle(wrap).overflowX === "auto";
    }), true, "宽表格应在消息内局部横滚");
    assert.equal(await page.locator(".prose-msg pre").evaluate((pre) => {
      const code = pre.querySelector("code")!;
      return pre.scrollWidth > pre.clientWidth && getComputedStyle(pre).overflowX === "auto" &&
        getComputedStyle(code).whiteSpace === "pre" && getComputedStyle(code).overflowX === "visible";
    }), true, "长代码由 pre 而非 code 承载滚动");
    assert.equal(await page.locator(".prose-msg p code").evaluate((el) => getComputedStyle(el).display), "inline");
    await noOverflow(page);
  },

  async "machine delete clears confirmation after success and after the selected row disappears"(page: Page, baseURL: string) {
    await fixtures(page);
    const machine = (id: string, email: string) => ({ id, email, state: "running", spec: { cpu: 1, memMb: 1024, diskGb: 10 }, image: "test-machine", createdAt: stamp });
    const first = machine("first", "ada@example.com");
    const second = machine("second", "bea@example.com");
    let listed = [first, second];
    let audits = 0;
    await page.route("**/api/admin/machines", (route) => route.fulfill({ json: { machines: listed } }));
    await page.route("**/api/admin/machines/*/*", (route) => route.fulfill({ json: {} }));
    await page.route("**/api/admin/audit**", (route) => { audits++; return route.fulfill({ json: { audit: [] } }); });
    await page.goto(`${baseURL}/admin/machines`);
    const target = page.getByTestId("machine-row").filter({ hasText: first.email });
    const other = page.getByTestId("machine-row").filter({ hasText: second.email });
    const confirmation = page.getByTestId("machine-delete-email");
    await visible(target);
    assert.equal(await confirmation.count(), 0);
    assert.equal(await page.getByRole("link", { name: "查看审计日志" }).getAttribute("href"), "/admin/audit");
    await target.getByTestId("machine-delete").click();
    await visible(target.getByText(`删除 ${first.email} 的机器`, { exact: true }));
    await confirmation.fill(first.email);
    await target.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await confirmation.count(), 0);
    await target.getByTestId("machine-delete").click();
    assert.equal(await confirmation.inputValue(), "");
    await confirmation.fill(first.email);
    const deleted = page.waitForRequest("**/api/admin/machines/first/delete");
    await target.getByTestId("machine-delete-submit").click();
    assert.deepEqual((await deleted).postDataJSON(), { email: first.email });
    // The read model can still contain the row on the first refresh.
    await confirmation.waitFor({ state: "detached" });
    await visible(target);
    await target.getByTestId("machine-delete").click();
    await confirmation.fill(first.email);
    listed = [second];
    await other.getByTestId("machine-stop").click();
    await target.waitFor({ state: "detached" });
    listed = [first, second];
    await other.getByTestId("machine-start").click();
    await visible(target);
    assert.equal(await confirmation.count(), 0, "旧目标短暂消失后不能重新打开删除确认");
    assert.equal(audits, 0, "机器页不请求不再展示的审计列表");
  },
};

export async function checkWorkLayout(browser: Browser, baseURL: string): Promise<void> {
  const failures: unknown[] = [];
  for (const [name, check] of Object.entries(cases)) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
      await check(page, baseURL);
      console.log(`work layout: ${name}`);
    } catch (error) {
      failures.push(error);
      console.error(`work layout failed: ${name}`, error);
    } finally {
      await page.context().close();
    }
  }
  if (failures.length) throw new AggregateError(failures, "work layout regression");
}
