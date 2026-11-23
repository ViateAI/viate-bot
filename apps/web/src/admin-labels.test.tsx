import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminSettings, AdminTemplates } from "./admin.js";

function render(node: React.ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["admin-templates"], { templates: [] });
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
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function labeled(html: string, name: string, testId?: string): string {
  const labels = [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map((match) => match[0]);
  const found = labels.find((label) => {
    const text = label.replace(/<[^>]+>/g, "");
    if (!text.includes(name)) return false;
    if (testId && !label.includes(`data-testid="${testId}"`)) return false;
    return /<(?:input|textarea)\b/.test(label);
  });
  return found ?? "";
}

describe("admin field labels", () => {
  it("gives every template field a visible label and keeps the name required", () => {
    const html = render(<AdminTemplates />);
    const name = labeled(html, "名字", "template-name");
    expect(name).toContain("required");
    expect(name).not.toContain('placeholder="名字"');
    for (const field of ["说明", "指令", "默认模型", "欢迎消息", "初始记忆"]) {
      expect(labeled(html, field), field).not.toBe("");
    }
    const memories = labeled(html, "初始记忆");
    expect(memories).toContain("一行一条");
    expect(html).toContain("添加模板");
  });

  it("labels the model limit fields without dropping their test ids or required checks", () => {
    const html = render(<AdminSettings />);
    const form = html.match(/<form[^>]*class="[^"]*md:grid-cols-4[^"]*"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).not.toBe("");
    for (const [name, testId] of [
      ["模型 ID", "model-limit-name"],
      ["上下文窗口", "model-context"],
      ["单次输出上限", "model-output"],
    ] as const) {
      const label = labeled(form, name, testId);
      expect(label, name).toContain("required");
      expect(label).not.toContain(`placeholder="${name}"`);
    }
  });

  it("explains what directory confinement covers and which permissions remain when off", () => {
    const html = render(<AdminSettings />);
    expect(html).toMatch(/文件工具和 shell 工作目录/);
    expect(html).toMatch(/关闭后[^<]*bot 用户的权限/);
    expect(html).toContain("shell 正文不按目录拦截");
  });
});
