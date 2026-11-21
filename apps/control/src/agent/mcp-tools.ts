import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { installsForModelContext, type CatalogDeps } from "../apps/catalog.js";
import {
  mcpFailureCategory,
  type MachinedMcpClient,
  type McpToolDefinition,
} from "./mcp-client.js";

const APP_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const SCHEMA_LIMIT = 1200;
const SUMMARY_LIMIT = 500;

const inspectSchema = obj({
  app: str({ description: "已安装且对当前 bot 启用的应用名" }),
});

const callSchema = obj({
  app: str({ description: "已安装且对当前 bot 启用的应用名" }),
  tool: str({ description: "mcp_inspect 列出的工具名" }),
  arguments: opt(unknown({ description: "传给该工具的参数对象" })),
});

interface CachedServer {
  name: string;
  server: string;
  tools: McpToolDefinition[];
}

interface CachedApp {
  servers: CachedServer[];
  risky: ReadonlySet<string>;
}

export interface TaskMcp {
  close(): void;
  stopApp(appName: string): void;
  inspectTool: AgentTool<typeof inspectSchema>;
  callTool: AgentTool<typeof callSchema>;
}

export function createTaskMcp(options: {
  client: MachinedMcpClient;
  files: { inspectApp(name: string, signal?: AbortSignal): Promise<{ mcpServers: string[] }> };
  catalog: CatalogDeps;
  userId: string;
  botId: string;
  taskId: string;
}): TaskMcp {
  const cache = new Map<string, CachedApp>();
  const inflight = new Map<string, Promise<CachedApp>>();
  const epoch = new Map<string, number>();

  const ensure = (app: string, signal?: AbortSignal): Promise<CachedApp> => {
    const cached = cache.get(app);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(app);
    if (pending) return pending;
    const stamp = epoch.get(app) ?? 0;
    const loading = openApp(app, signal).then((session) => {
      if ((epoch.get(app) ?? 0) !== stamp) throw new Error("MCP 通道已关闭");
      cache.set(app, session);
      return session;
    });
    inflight.set(app, loading);
    void loading.finally(() => {
      if (inflight.get(app) === loading) inflight.delete(app);
    }).catch(() => undefined);
    return loading;
  };

  const openApp = async (app: string, signal?: AbortSignal): Promise<CachedApp> => {
    if (!APP_NAME.test(app) || app.includes("..") || app.includes("--")) throw new Error("应用名无效");
    const install = installsForModelContext(options.catalog, options.userId, options.botId).find((item) => item.name === app);
    if (!install) throw new Error(`应用 ${app} 未安装或当前 bot 未启用`);
    const loading = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const info = await options.files.inspectApp(app, loading);
    const servers: CachedServer[] = [];
    try {
      for (const serverName of info.mcpServers) {
        const started = await options.client.launchApp(app, serverName, loading, options.taskId);
        const listed = await options.client.listTools(started.server, loading);
        servers.push({ name: serverName, server: started.server, tools: listed.tools });
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "MCP 通道已关闭") options.client.stopApp(app);
      throw error;
    }
    return { servers, risky: new Set(install.riskyTools) };
  };

  const inspectTool: AgentTool<typeof inspectSchema> = {
    name: "mcp_inspect",
    label: "查看应用工具",
    description: "按需启动一个已安装应用的 MCP，返回工具名、说明和参数。不会在任务开始时展开全部应用。",
    parameters: inspectSchema,
    execute: async (_id, params, signal) => {
      try {
        const session = await ensure(params.app, signal);
        return textResult(formatInspect(params.app, session));
      } catch (error) {
        return fail(failureText(params.app, error));
      }
    },
  };

  const callTool: AgentTool<typeof callSchema> = {
    name: "mcp_call",
    label: "调用应用工具",
    description: "调用已安装应用里的一个 MCP 工具。普通调用走 mcp 审批，riskyTools 里的工具走高风险审批。",
    parameters: callSchema,
    execute: async (_id, params, signal) => {
      const name = params.tool;
      if (name.length === 0 || name.length > 256 || name.includes("\0") || /[\r\n]/.test(name)) return fail("工具名无效");
      const args = params.arguments;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return fail("工具参数必须是对象");
      try {
        const session = await ensure(params.app, signal);
        const owners = session.servers.filter((server) => server.tools.some((tool) => tool.name === name));
        if (owners.length === 0) return fail(`应用 ${params.app} 没有工具 ${name}。请先调用 mcp_inspect。`);
        if (owners.length > 1) return fail(`应用 ${params.app} 的多个服务都有工具 ${name}。请先调用 mcp_inspect 确认。`);
        const owner = owners[0];
        if (!owner) return fail(`应用 ${params.app} 没有工具 ${name}。请先调用 mcp_inspect。`);
        const result = await options.client.callTool(
          owner.server,
          name,
          args === undefined ? undefined : args as Record<string, unknown>,
          signal,
        );
        const text = result.content.map((block) => block.text ?? "").filter((line) => line.length > 0).join("\n");
        const payload: AgentToolResult = {
          content: [{ type: "text", text: text.length > 0 ? text : "（无文本）" }],
          details: { app: params.app, tool: name, isError: result.isError === true },
        };
        if (result.isError === true) payload.isError = true;
        return payload;
      } catch (error) {
        if (error instanceof Error && error.message === "remote_unconfirmed") throw error;
        return fail(failureText(params.app, error));
      }
    },
  };

  return {
    close: () => options.client.close(),
    stopApp(appName: string) {
      epoch.set(appName, (epoch.get(appName) ?? 0) + 1);
      cache.delete(appName);
      inflight.delete(appName);
      options.client.stopApp(appName);
    },
    inspectTool,
    callTool,
  };
}

export function summarizeMcpCall(args: unknown): string {
  const app = stringField(args, "app") ?? "未知应用";
  const tool = stringField(args, "tool") ?? "未知工具";
  const parameters = args && typeof args === "object" && "arguments" in args
    ? (args as { arguments?: unknown }).arguments
    : undefined;
  let shown = "{}";
  try {
    shown = JSON.stringify(parameters ?? {});
  } catch {
    shown = "{}";
  }
  if (shown.length > SUMMARY_LIMIT) shown = `${shown.slice(0, SUMMARY_LIMIT)}…`;
  return `调用 ${app} · ${tool}\n参数：${shown}`;
}

function formatInspect(app: string, session: CachedApp): string {
  const tools = session.servers.flatMap((server) => server.tools.map((tool) => ({ server, tool })));
  if (tools.length === 0) return `应用 ${app} 当前没有工具`;
  const lines = [`应用 ${app} 的工具：`];
  for (const item of tools) {
    const risk = session.risky.has(item.tool.name) || session.risky.has(`${app}:${item.tool.name}`) ? "（高风险，调用需要审批）" : "";
    const where = session.servers.length > 1 ? ` [${item.server.name}]` : "";
    lines.push(`- ${item.tool.name}${where}${risk}：${item.tool.description && item.tool.description.length > 0 ? item.tool.description : "无描述"}`);
    lines.push(`  参数：${truncateSchema(item.tool.inputSchema)}`);
  }
  return lines.join("\n");
}

function truncateSchema(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "{}";
  let text = "{}";
  try {
    text = JSON.stringify(schema);
  } catch {
    return "{}";
  }
  if (text.length <= SCHEMA_LIMIT) return text;
  return `${text.slice(0, SCHEMA_LIMIT)}…（schema 已截断）`;
}

function failureText(app: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("引用的密钥") || message.startsWith("应用 ")) return message;
  return `应用 ${app} 的工具当前不可用（${mcpFailureCategory(error)}）`;
}

function textResult(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function fail(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}

function stringField(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
