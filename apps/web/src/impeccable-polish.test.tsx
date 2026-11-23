import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminSettings } from "./admin.js";
import { AdminMetrics } from "./admin-metrics.js";
import { ApprovalCard, Approvals, type Approval } from "./approval.js";
import { Routines } from "./routines.js";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const outOfRangeUlid = `8${ulid.slice(1)}`;

function render(node: React.ReactElement, seed?: (client: QueryClient) => void): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  seed?.(client);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("impeccable polish", () => {
  it("uses h2 under the approvals page h1 and keeps sidebar cards at h3", () => {
    const item: Approval = { id: "shell", taskId: "task-1", tool: "shell_exec", args: { cmd: "echo hi" } };
    const card = render(<ApprovalCard item={item} pending={false} onDecide={() => {}} />);
    expect(card).toContain("<h3");
    expect(card).not.toContain("<h2");
    const page = render(<Approvals />, (client) => {
      client.setQueryData(["approvals"], { approvals: [item] });
    });
    expect(page).toContain("<h1");
    expect(page).toContain("待批准操作");
    expect(page).toMatch(/<h2[^>]*>shell_exec<\/h2>/);
    expect(page).not.toContain("<h3");
  });

  it("keeps metrics sections at h2 and shortens long ids", () => {
    const html = render(<AdminMetrics />, (client) => {
      client.setQueryData(["admin-overview"], {
        provisionedUsers: 1,
        activeUsers1d: 1,
        machinesRunning: 1,
        tasksToday: 1,
        tasksSucceededToday: 1,
        costUsdToday: 0,
        anomalies: [
          { machineId: ulid, kind: "heartbeat" },
          { machineId: "m-short", kind: "disk" },
        ],
        failureClasses: [],
        activeTrend: [{ day: "2026-11-01", count: 1 }],
        alerts: [
          { kind: "routine", target: ulid },
          { kind: "machine", target: "ada@example.com" },
          { kind: "routine", target: outOfRangeUlid },
        ],
        routinePunctuality7d: { planned: 1, onTime: 1, late: 0, missed: 0, skipped: 0, onTimeRate: 1 },
      });
    });
    expect(html).toContain("<h1");
    for (const title of ["定时任务按时率（近 7 天）", "资源异常", "站内告警", "失败类别", "活跃趋势"]) {
      expect(html).toContain(`>${title}</h2>`);
    }
    expect(html).not.toContain("<h3");
    expect(html).toContain(`title="${ulid}"`);
    expect(html).toContain("01ARZ3…5FAV");
    expect(html).not.toContain(`>${ulid}<`);
    expect(html).toContain("m-short");
    expect(html).toContain("ada@example.com");
    expect(html).toContain(`>${outOfRangeUlid}<`);
    expect(html).not.toContain(`title="${outOfRangeUlid}"`);
    expect(html).toContain("心跳");
    expect(html).toContain("磁盘");
    expect(html).toContain("定时任务");
    expect(html).toContain("机器");
    expect(html).not.toContain("heartbeat");
  });

  it("separates the routine delete button from the other actions", () => {
    const html = render(<Routines botId="bot-1" />, (client) => {
      client.setQueryData(["routines", "bot-1"], {
        routines: [{ id: "r1", cron: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "每天看一眼", state: "active", enabled: 1, nextRunAt: null }],
      });
    });
    const remove = html.match(/<button[^>]*>删除<\/button>/)?.[0] ?? "";
    expect(remove.split(/[\s"]+/)).toContain("ml-auto");
    expect(html).toContain("运行记录");
    expect(html).toContain("暂停");
  });

  it("adds mobile stage padding without removing settings controls", () => {
    const start = css.indexOf("@media (max-width: 799px)");
    expect(start).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(css.slice(open, end)).toMatch(/\.stage-fill\s*\{[^}]*padding-bottom:\s*16px/);
    const settings = render(<AdminSettings />, (client) => {
      client.setQueryData(["admin-settings"], {
        integration: "none",
        defaultChannel: null,
        platformPrompt: { version: 1, text: "" },
        modelLimits: {},
        modelDefaults: { contextTokens: 8000, maxTokens: 2000 },
        taskTokenBudget: 0,
        taskMaxSteps: 0,
        taskMaxDurationSec: 0,
        models: ["fake"],
        modelRate: { userPerMin: 0, botPerMin: 0 },
        fsConfine: true,
        fsConfineConfig: { enabled: true, allow: [], deny: [] },
      });
    });
    expect(settings).toContain('data-testid="fs-confine"');
    expect(settings).toContain('data-testid="fs-confine-allow"');
    expect(settings).toContain('data-testid="fs-confine-deny"');
    expect(settings).toContain('data-testid="platform-prompt"');
    expect(settings).toContain('data-testid="task-token-budget"');
    expect(settings).toContain("0 表示不限制");
    expect(settings).toContain("/home/bot");
    expect(settings).toContain("只影响之后开始的任务");
    expect(settings).not.toContain("关闭后可以访问容器内 bot 用户读得到的路径");
  });
});
