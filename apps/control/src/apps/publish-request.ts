import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";
import { and, eq } from "drizzle-orm";
import { ulid } from "../id.js";
import { appPublishRequests, appVersions, apps } from "../db/schema.js";
import { readPackageFiles, validatePackage, type PackageFile } from "./archive.js";
import { APP_SOURCE_USER, CatalogRejected, type CatalogDeps } from "./catalog.js";
import { packageKinds } from "./package-app.js";

const NOTE_LIMIT = 2000;
const ACTIVE = "active";
export const PUBLISH_WARNING = "批准后会提交给管理员，审批通过后所有用户可见可安装";

export interface PublishCard {
  kind: "app_publish";
  name: string;
  version: string;
  sha256: string;
  kinds: string[];
  files: number;
  command: string;
  routines: number;
  note: string;
  warning: string;
}

export interface PublishRequestResult {
  id: string;
  state: "pending";
  note: string;
  botId: string | null;
  taskId: string | null;
}

export function describePublish(deps: CatalogDeps, userId: string, args: unknown): PublishCard | undefined {
  const input = readArgs(args);
  if (!input) return undefined;
  const found = findOwnedVersion(deps, userId, input.name, input.version);
  if (!found || found.version.status !== ACTIVE) return undefined;
  try {
    const files = readPackageFiles(found.version.archivePath, found.version.sha256);
    const pkg = validatePackage(files);
    const routines = Array.isArray(pkg.extension.routines) ? pkg.extension.routines.length : 0;
    return {
      kind: "app_publish",
      name: found.app.name,
      version: found.version.version,
      sha256: found.version.sha256,
      kinds: packageKinds(pkg),
      files: pkg.files.length,
      command: mcpCommand(files),
      routines,
      note: input.note,
      warning: PUBLISH_WARNING,
    };
  } catch {
    return undefined;
  }
}

export function requestAppPublish(
  deps: CatalogDeps,
  userId: string,
  input: { name: string; version: string; note: string; botId?: string; taskId?: string },
): PublishRequestResult {
  const note = requireNote(input.note);
  const found = findOwnedVersion(deps, userId, input.name, input.version);
  if (!found) throw new CatalogRejected("找不到应用", 404);
  if (found.version.status !== ACTIVE) throw new CatalogRejected("版本已下架", 409);
  try {
    readPackageFiles(found.version.archivePath, found.version.sha256);
  } catch {
    throw new CatalogRejected("应用包校验失败", 409);
  }
  const existing = deps.db
    .select({ state: appPublishRequests.state })
    .from(appPublishRequests)
    .where(eq(appPublishRequests.appVersionId, found.version.id))
    .all();
  if (existing.some((row) => row.state === "pending" || row.state === "approved")) {
    throw new CatalogRejected("该版本已有待审批或已通过的申请", 409);
  }
  if (existing.some((row) => row.state === "rejected")) throw new CatalogRejected("被驳回的版本必须出新版本", 409);
  const id = ulid();
  const botId = input.botId ?? null;
  const taskId = input.taskId ?? null;
  const now = (deps.now?.() ?? new Date()).toISOString();
  deps.db.insert(appPublishRequests).values({
    id,
    appVersionId: found.version.id,
    requesterUserId: userId,
    botId,
    taskId,
    note,
    state: "pending",
    reason: null,
    reviewerUserId: null,
    createdAt: now,
    decidedAt: null,
  }).run();
  return { id, state: "pending", note, botId, taskId };
}

const requestSchema = obj({
  name: str({ description: "自己的私有应用名" }),
  version: str({ description: "要申请公开的版本" }),
  note: str({ description: "给管理员的说明，必填，最多 2000 字。批准后才会提交" }),
});

export function requestAppPublishTool(binding: {
  userId: string;
  botId: string;
  taskId: string;
  catalog: CatalogDeps;
}): AgentTool<typeof requestSchema> {
  return {
    name: "request_app_publish",
    label: "申请公开应用",
    description: "请用户批准把一个私有版本提交给管理员公开。批准前不会写入申请。审批通过前其他用户看不见。",
    parameters: requestSchema,
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const saved = requestAppPublish(binding.catalog, binding.userId, {
        name: params.name,
        version: params.version,
        note: params.note,
        botId: binding.botId,
        taskId: binding.taskId,
      });
      return {
        content: [{ type: "text" as const, text: `${saved.note}\n已提交公开申请，等待管理员审批。通过前其他用户看不见。` }],
        details: saved,
      };
    },
  };
}

function findOwnedVersion(deps: CatalogDeps, userId: string, name: string, version: string) {
  const app = deps.db.select().from(apps).where(eq(apps.name, name)).get();
  if (!app || app.source !== APP_SOURCE_USER || app.ownerUserId !== userId) return undefined;
  const row = deps.db
    .select()
    .from(appVersions)
    .where(and(eq(appVersions.appId, app.id), eq(appVersions.version, version)))
    .get();
  if (!row) return undefined;
  return { app, version: row };
}

function readArgs(args: unknown): { name: string; version: string; note: string } | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as { name?: unknown; version?: unknown; note?: unknown };
  if (typeof record.name !== "string" || typeof record.version !== "string" || typeof record.note !== "string") return undefined;
  if (noteLength(record.note) === 0 || noteLength(record.note) > NOTE_LIMIT) return undefined;
  return { name: record.name, version: record.version, note: record.note };
}

function requireNote(note: string): string {
  const length = noteLength(note);
  if (length === 0) throw new CatalogRejected("说明不能为空", 400);
  if (length > NOTE_LIMIT) throw new CatalogRejected("说明过长", 400);
  return note;
}

function noteLength(note: string): number {
  return [...note.trim()].length;
}

function mcpCommand(files: PackageFile[]): string {
  const mcp = files.find((file) => file.path === "mcp.json");
  if (!mcp || mcp.data.includes(0)) return "（没有 MCP）";
  let parsed: { mcpServers?: Record<string, { command?: unknown; args?: unknown; url?: unknown }> };
  try {
    parsed = JSON.parse(mcp.data.toString("utf8")) as typeof parsed;
  } catch {
    return "（没有 MCP）";
  }
  const lines: string[] = [];
  for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
    if (!server || typeof server !== "object") continue;
    if (typeof server.url === "string") lines.push(`${name}: ${server.url}`);
    else if (typeof server.command === "string") {
      const args = Array.isArray(server.args) ? server.args.filter((item): item is string => typeof item === "string") : [];
      lines.push(`${name}: ${[server.command, ...args].join(" ")}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "（没有 MCP）";
}
