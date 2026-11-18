import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditRepository } from "../db/audit.js";
import { eventRepository } from "../db/events.js";
import { appPublishRequests, appVersions, apps, bots, users } from "../db/schema.js";
import { ulid } from "../id.js";
import { AUDIT_ACTIONS, M2_EVENTS } from "../m2/events.js";
import { adminScope, type AdminScope } from "../scope.js";
import { readPackageFiles, validatePackage, type PackageFile, type ValidatedPackage } from "./archive.js";
import { CatalogRejected, type CatalogDeps } from "./catalog.js";
import { packageKinds } from "./package-app.js";

const FILE_CAP = 256 * 1024;

export interface PublishReviewListItem {
  id: string;
  name: string;
  version: string;
  kinds: string[];
  requester: string;
  bot: string | null;
  createdAt: string;
  state: string;
}

export interface PublishReviewDetail {
  id: string;
  name: string;
  version: string;
  note: string;
  sha256: string;
  manifest: string;
  files: Array<{ path: string; size: number; executable: boolean }>;
  mcp: Array<{ name: string; command?: string; args?: string[]; url?: string }>;
  config: Array<{ key: string; secret: boolean }>;
  routines: Array<{ cron: string; timezone: string; prompt: string }>;
  diff: { added: string[]; removed: string[]; modified: string[] } | null;
}

export interface PublishReviewFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
  binary: boolean;
  text?: string;
  truncated?: boolean;
}

export function listPublishReviews(deps: CatalogDeps, scope: AdminScope): { pendingCount: number; requests: PublishReviewListItem[] } {
  assertAdmin(scope);
  const requests = deps.db
    .select({
      id: appPublishRequests.id,
      state: appPublishRequests.state,
      note: appPublishRequests.note,
      createdAt: appPublishRequests.createdAt,
      version: appVersions.version,
      archivePath: appVersions.archivePath,
      sha256: appVersions.sha256,
      name: apps.name,
      requester: users.name,
      bot: bots.name,
    })
    .from(appPublishRequests)
    .innerJoin(appVersions, eq(appVersions.id, appPublishRequests.appVersionId))
    .innerJoin(apps, eq(apps.id, appVersions.appId))
    .innerJoin(users, eq(users.id, appPublishRequests.requesterUserId))
    .leftJoin(bots, eq(bots.id, appPublishRequests.botId))
    .all()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return {
    pendingCount: requests.filter((row) => row.state === "pending").length,
    requests: requests.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      kinds: kindsOf(row.archivePath, row.sha256),
      requester: row.requester,
      bot: row.bot,
      createdAt: row.createdAt,
      state: row.state,
    })),
  };
}

export function publishReviewDetail(deps: CatalogDeps, scope: AdminScope, requestId: string): PublishReviewDetail {
  assertAdmin(scope);
  const found = findRequest(deps, requestId);
  const pkg = loadPackage(found.version.archivePath, found.version.sha256);
  const previous = previousApproved(deps, found.app.id, found.version.id);
  return {
    id: found.request.id,
    name: found.app.name,
    version: found.version.version,
    note: found.request.note,
    sha256: found.version.sha256,
    manifest: pretty(found.version.manifestJson),
    files: pkg.files.map((file) => ({ path: file.path, size: file.data.length, executable: file.executable === true })),
    mcp: mcpServers(pkg.files),
    config: configKeys(pkg.extension),
    routines: routinesOf(pkg.extension),
    diff: previous ? diffFiles(loadPackage(previous.archivePath, previous.sha256).files, pkg.files) : null,
  };
}

export function publishReviewFile(deps: CatalogDeps, scope: AdminScope, requestId: string, rawPath: string): PublishReviewFile {
  assertAdmin(scope);
  const path = safeFilePath(rawPath);
  const found = findRequest(deps, requestId);
  const file = loadPackage(found.version.archivePath, found.version.sha256).files.find((item) => item.path === path);
  if (!file) throw new CatalogRejected("找不到文件", 404);
  const binary = file.data.includes(0);
  const view: PublishReviewFile = {
    path: file.path,
    size: file.data.length,
    sha256: createHash("sha256").update(file.data).digest("hex"),
    executable: file.executable === true,
    binary,
  };
  if (!binary) {
    view.text = file.data.subarray(0, FILE_CAP).toString("utf8");
    view.truncated = file.data.length > FILE_CAP;
  }
  return view;
}

export function decidePublishReview(
  deps: CatalogDeps,
  scope: AdminScope,
  requestId: string,
  input: { decision: "approve" } | { decision: "reject"; reason: string },
): { id: string; state: "approved" | "rejected"; reason: string | null } {
  assertAdmin(scope);
  const found = findRequest(deps, requestId);
  if (found.request.state !== "pending") throw new CatalogRejected("申请已处理", 409);
  if (input.decision === "approve") loadPackage(found.version.archivePath, found.version.sha256);
  const reason = input.decision === "reject" ? requireReason(input.reason) : null;
  const state = input.decision === "approve" ? "approved" : "rejected";
  const now = (deps.now?.() ?? new Date()).toISOString();
  deps.db.transaction(() => {
    const changed = deps.db
      .update(appPublishRequests)
      .set({ state, reason, reviewerUserId: scope.actorUserId, decidedAt: now })
      .where(and(eq(appPublishRequests.id, requestId), eq(appPublishRequests.state, "pending")))
      .run();
    if (changed.changes !== 1) throw new CatalogRejected("申请已处理", 409);
    auditRepository(deps.db).write(adminScope(scope.actorUserId), AUDIT_ACTIONS.appPublishReview, requestId, {
      requestId,
      versionId: found.version.id,
      state,
    });
    eventRepository(deps.db).insert({
      id: ulid(),
      ts: now,
      userId: scope.actorUserId,
      type: M2_EVENTS.appPublishReviewed,
      attrs: { requestId, state },
    });
  });
  return { id: requestId, state, reason };
}

function findRequest(deps: CatalogDeps, requestId: string) {
  const request = deps.db.select().from(appPublishRequests).where(eq(appPublishRequests.id, requestId)).get();
  if (!request) throw new CatalogRejected("找不到", 404);
  const version = deps.db.select().from(appVersions).where(eq(appVersions.id, request.appVersionId)).get();
  const app = version ? deps.db.select().from(apps).where(eq(apps.id, version.appId)).get() : undefined;
  if (!version || !app) throw new CatalogRejected("找不到", 404);
  return { request, version, app };
}

function previousApproved(deps: CatalogDeps, appId: string, versionId: string) {
  const approved = new Set(
    deps.db
      .select({ id: appPublishRequests.appVersionId })
      .from(appPublishRequests)
      .where(eq(appPublishRequests.state, "approved"))
      .all()
      .map((row) => row.id),
  );
  return deps.db
    .select()
    .from(appVersions)
    .where(eq(appVersions.appId, appId))
    .all()
    .filter((version) => version.id !== versionId && approved.has(version.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
}

function loadPackage(archivePath: string, sha256: string): ValidatedPackage {
  try {
    return validatePackage(readPackageFiles(archivePath, sha256));
  } catch (error) {
    throw new CatalogRejected("应用包校验失败", 400, { cause: error });
  }
}

function kindsOf(archivePath: string, sha256: string): string[] {
  try {
    return packageKinds(loadPackage(archivePath, sha256));
  } catch {
    return [];
  }
}

function mcpServers(files: PackageFile[]): PublishReviewDetail["mcp"] {
  const mcp = files.find((file) => file.path === "mcp.json");
  if (!mcp || mcp.data.includes(0)) return [];
  try {
    const parsed = JSON.parse(mcp.data.toString("utf8")) as { mcpServers?: Record<string, { command?: unknown; args?: unknown; url?: unknown }> };
    return Object.entries(parsed.mcpServers ?? {}).flatMap(([name, server]) => {
      if (!server || typeof server !== "object") return [];
      const item: PublishReviewDetail["mcp"][number] = { name };
      if (typeof server.command === "string") item.command = server.command;
      if (Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")) item.args = server.args;
      if (typeof server.url === "string") item.url = server.url;
      return [item];
    });
  } catch {
    return [];
  }
}

function configKeys(extension: Record<string, unknown>): PublishReviewDetail["config"] {
  if (!Array.isArray(extension.config)) return [];
  return extension.config.flatMap((item) => {
    if (!item || typeof item !== "object" || !("key" in item) || typeof item.key !== "string") return [];
    return [{ key: item.key, secret: "secret" in item && item.secret === true }];
  });
}

function routinesOf(extension: Record<string, unknown>): PublishReviewDetail["routines"] {
  if (!Array.isArray(extension.routines)) return [];
  return extension.routines.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { cron?: unknown; timezone?: unknown; prompt?: unknown };
    if (typeof row.cron !== "string" || typeof row.timezone !== "string" || typeof row.prompt !== "string") return [];
    return [{ cron: row.cron, timezone: row.timezone, prompt: row.prompt }];
  });
}

function diffFiles(previous: PackageFile[], current: PackageFile[]): NonNullable<PublishReviewDetail["diff"]> {
  const before = new Map(previous.map((file) => [file.path, file]));
  const after = new Map(current.map((file) => [file.path, file]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [path, file] of after) {
    const old = before.get(path);
    if (!old) added.push(path);
    else if (!old.data.equals(file.data) || (old.executable === true) !== (file.executable === true)) modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  added.sort();
  removed.sort();
  modified.sort();
  return { added, removed, modified };
}

function pretty(manifestJson: string): string {
  try {
    return JSON.stringify(JSON.parse(manifestJson) as unknown, null, 2);
  } catch {
    return manifestJson;
  }
}

function safeFilePath(path: string): string {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.split("/").includes("..")) {
    throw new CatalogRejected("找不到文件", 404);
  }
  return path;
}

function requireReason(reason: string): string {
  const text = reason.trim();
  if (text.length === 0 || [...text].length > 2000) throw new CatalogRejected("驳回原因不能为空", 400);
  return text;
}

function assertAdmin(scope: AdminScope): void {
  if (scope.kind !== "admin" || scope.actorUserId.length === 0) throw new CatalogRejected("找不到", 404);
}
