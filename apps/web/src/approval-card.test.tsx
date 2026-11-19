import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalCard, type Approval } from "./approval.js";

function markup(item: Approval): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ApprovalCard item={item} pending={false} onDecide={() => {}} />
    </QueryClientProvider>,
  );
}

function allowTag(html: string, id: string): string {
  const marker = `data-testid="allow-approval-${id}"`;
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  const end = html.indexOf("</button>", at);
  return html.slice(start, end).replace(/\sclass="[^"]*"/g, "");
}

function expectGrantBeforeAllow(html: string, id: string, grant: string): void {
  const grantAt = html.indexOf(grant);
  const allowAt = html.indexOf(`data-testid="allow-approval-${id}"`);
  expect(grantAt).toBeGreaterThan(-1);
  expect(allowAt).toBeGreaterThan(grantAt);
}

const installSummary = JSON.stringify({
  source: "catalog",
  title: `calendar-${"n".repeat(80)}`,
  command: "npx calendar-mcp",
  reason: "需要读日历",
  config: [{ key: "TOKEN", display: "已填写" }],
  riskyTools: ["shell"],
  runsInstallScript: true,
});

const publishWarning = "批准后会提交给管理员审核，通过后所有用户可见可安装。";

describe("ApprovalCard", () => {
  it("states the tool grant before allow", () => {
    const html = markup({ id: "shell", taskId: "task-1", tool: "shell_exec", args: { cmd: `echo ${"x".repeat(80)}` } });
    expectGrantBeforeAllow(html, "shell", "批准后将执行工具 shell_exec。");
    expect(allowTag(html, "shell")).not.toContain("disabled");
  });

  it("states the install permission before allow", () => {
    const html = markup({ id: "install", taskId: "task-1", tool: "install_mcp", args: {}, summary: installSummary });
    expectGrantBeforeAllow(html, "install", "批准后，该 MCP 会安装到你的机器上，并对你的所有 bot 启用。");
    expect(html).toContain(`calendar-${"n".repeat(80)}`);
    expect(html).toContain("会在你的机器上运行安装脚本");
    expect(allowTag(html, "install")).not.toContain("disabled");
  });

  it("keeps an incomplete install from being allowed", () => {
    const html = markup({ id: "broken", taskId: "task-1", tool: "install_mcp", args: {}, summary: "not-json" });
    expectGrantBeforeAllow(html, "broken", "安装详情不完整，不能批准。请拒绝后重新申请。");
    expect(allowTag(html, "broken")).toContain("disabled");
  });

  it("states the publish warning before allow", () => {
    const html = markup({
      id: "publish",
      taskId: "task-1",
      tool: "request_app_publish",
      args: {},
      summary: JSON.stringify({
        kind: "app_publish",
        name: `pub-${"n".repeat(40)}`,
        version: "1.2.3",
        sha256: "ab".repeat(32),
        kinds: ["mcp"],
        files: 3,
        command: "node server.js",
        routines: 1,
        note: "说明",
        warning: publishWarning,
      }),
    });
    expectGrantBeforeAllow(html, "publish", publishWarning);
    expect(allowTag(html, "publish")).not.toContain("disabled");
  });

  it("keeps an incomplete publish from being allowed", () => {
    const html = markup({ id: "publish-bad", taskId: "task-1", tool: "request_app_publish", args: {}, summary: "{}" });
    expectGrantBeforeAllow(html, "publish-bad", "发布详情不完整，不能批准。请拒绝后重新申请。");
    expect(allowTag(html, "publish-bad")).toContain("disabled");
  });

  it("states the profile grant before allow", () => {
    const html = markup({
      id: "profile",
      taskId: "task-1",
      tool: "update_bot_profile",
      args: {},
      summary: JSON.stringify({ kind: "bot_profile", changes: [{ field: "name", before: "旧", after: "新" }] }),
    });
    expectGrantBeforeAllow(html, "profile", "批准后将按上面的差异修改这个 bot 的资料。");
    expect(allowTag(html, "profile")).not.toContain("disabled");
  });

  it("states the rule effect before allow", () => {
    const html = markup({
      id: "rule",
      taskId: "task-1",
      tool: "propose_approval_rule",
      args: { category: "shell" },
      summary: JSON.stringify({ kind: "approval_rule", category: "shell", match: { prefix: "echo" }, expiresAt: null }),
    });
    expectGrantBeforeAllow(html, "rule", "批准后规则生效。这次批准不能被其他规则、始终允许或全部免审批跳过。");
    expect(allowTag(html, "rule")).not.toContain("disabled");
  });
});
