import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { maskSecrets } from "../agent/text.js";
import type { PrivateAppStorage } from "../agent/skill-tools.js";
import { authenticated } from "../auth.js";
import { decrypt, encrypt } from "../crypto.js";
import { auditRepository } from "../db/audit.js";
import { eventRepository } from "../db/events.js";
import type { AppDatabase } from "../db/index.js";
import {
  appInstalls,
  appPublishRequests,
  appPushTargets,
  appPushes,
  appVersions,
  appVisibility,
  apps,
  botApps,
  bots,
  machines,
  secrets,
  users,
} from "../db/schema.js";
import { userRepository } from "../db/users.js";
import { ulid } from "../id.js";
import { AUDIT_ACTIONS, M2_EVENTS } from "../m2/events.js";
import { deliverPendingNotices, insertAppUpdateNotice, type AppUpdatePayload } from "../agent/notices.js";
import { adminScope, type AdminScope, type UserScope } from "../scope.js";
import {
  readTar,
  readZip,
  storePackage,
  validatePackage,
  wrapMcpb,
  wrapMcpUrl,
  wrapSkill,
  type PackageFile,
  type ValidatedPackage,
} from "./archive.js";
import { ingestGit, ingestNpm } from "./ingest.js";
import { requestAppPublish } from "./publish-request.js";
import { decidePublishReview, listPublishReviews, publishReviewDetail, publishReviewFile } from "./publish-review.js";
import { nextCron } from "../routines/cron.js";
import { routineService } from "../routines/service.js";

/** 可见范围没有真实用户时用这个主键占位。NULL 不能当主键。 */
export const VISIBILITY_SENTINEL = "*";
export const APP_SOURCE_USER = "user";
export const APP_SOURCE_CATALOG = "catalog";

const VERSION_ACTIVE = "active";
const VERSION_RETIRED = "retired";
const DESIRED_PRESENT = "present";
const DESIRED_ABSENT = "absent";
const SECRET_SCOPE = "app";
const NAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const CONFIG_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const USER_SECRET_NAME = /^[a-z0-9_]{1,64}$/;
const CREDENTIAL_NAME = /^[a-z0-9_.-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const SOURCE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export class CatalogRejected extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogRejected";
    this.statusCode = statusCode;
  }
}

/** 安装请求不含配置明文。明文只在 resolveMcpLaunch 的返回值里，交给 POST /apps/:name/mcp/:server。 */
export interface CatalogMachineInstall {
  machineId: string;
  userId: string;
  installId: string;
  name: string;
  version: string;
  sha256: string;
  archivePath: string;
  signal?: AbortSignal;
}

/** launchMcp 当次使用的值。stdio 用 env，HTTP/SSE 的初始 origin 用 headers。调用方不得落盘或交给模型。 */
export interface CatalogMcpLaunch {
  installId: string;
  name: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}

export interface CatalogMachineUninstall {
  machineId: string;
  userId: string;
  installId: string;
  name: string;
}

/** 安装在 machined 上执行。控制面不读包、不拨远程 MCP。返回的 routines 只写成草稿。 */
export interface CatalogInstaller {
  install(command: CatalogMachineInstall): Promise<{ routines?: ReadonlyArray<{ cron: string; timezone: string; prompt: string }> } | void>;
  uninstall(command: CatalogMachineUninstall): Promise<void>;
}

export interface CatalogDeps {
  db: AppDatabase;
  key: Buffer;
  installer: CatalogInstaller;
  now?: () => Date;
  /** 推送 wake=1 时由集成方启动机器。 */
  wake?: (userId: string) => Promise<void> | void;
  /** 推送异步执行。缺省排到微任务。测试可改成收集任务。 */
  schedule?: (work: () => Promise<void>) => void;
  /** `$VB_DATA_DIR`。上传和外部获取把包写到 `apps/<appId>/<version>.tar.zst`。 */
  dataDir?: string;
  /** 通知写入对话后告诉已打开的页面刷新。不启动任务。 */
  onNotice?: (conversationId: string) => void;
}

export function privateSkillStorage(deps: CatalogDeps, userId: string): PrivateAppStorage {
  return {
    async saveUserSkill(draft) {
      if (draft.ownerUserId !== userId) throw new CatalogRejected("找不到", 404);
      let pkg: ValidatedPackage;
      try {
        pkg = wrapSkill(draft.name, [{ path: "SKILL.md", data: Buffer.from(draft.skillMarkdown) }]);
      } catch {
        throw new CatalogRejected("技能无效", 400);
      }
      if (!pkg.skills.includes(draft.name)) throw new CatalogRejected("技能无效", 400);
      const saved = await publishValidatedPackage(deps, userId, pkg, { version: draft.version, privateUserId: userId });
      return { id: saved.appId, versionId: saved.versionId, name: saved.name, source: APP_SOURCE_USER, ownerUserId: userId };
    },
  };
}

export type ConfigValue =
  | string
  | { secret: true; value?: string }
  | { secret: true; secretRef: string; prefix?: string };
export type ConfigInput = Record<string, ConfigValue>;
export type RedactedConfig = Record<
  string,
  string | { secret: true } | { secret: true; secretRef: string; prefix?: string }
>;

export interface ManifestConfigItem {
  key: string;
  secret: boolean;
  credential?: string;
  prefix?: string;
  env?: string;
  header?: string;
}

export interface SecretRefTarget {
  installId: string;
  key: string;
  prefix?: string;
}

export interface PublishCatalogInput {
  name: string;
  version: string;
  manifestJson: string;
  archivePath: string;
  sha256: string;
  /** 缺省 catalog。不能是 user。 */
  source?: string;
}

export interface PrivateAppInput {
  name: string;
  version: string;
  manifestJson: string;
  archivePath: string;
  sha256: string;
}

export interface PublishedVersion {
  appId: string;
  versionId: string;
}

export interface PackagePublishResult {
  appId: string;
  versionId: string;
  name: string;
  version: string;
  warnings: string[];
}

export type VisibilitySpec =
  | { scope: "all" }
  | { scope: "push" }
  | { scope: "user"; userIds: string[] };

export interface AdminCatalogEntry {
  id: string;
  name: string;
  source: string;
  ownerUserId: string | null;
  ownerName: string | null;
  visibility: "all" | "user" | "push" | "hidden";
  userIds: string[];
  versions: Array<{ id: string; version: string; status: string; recommended: boolean; sha256: string }>;
}

export interface UserCatalogEntry {
  id: string;
  name: string;
  source: string;
  visibility: "private" | "all" | "user";
  version: { id: string; version: string; recommended: boolean };
  publisher: string | null;
  privateVersions: Array<{ version: string; publishState: string; reason: string | null }>;
}

export interface InstallView {
  id: string;
  appId: string;
  name: string;
  versionId: string;
  version: string;
  machineId: string;
  forced: boolean;
  desired: string;
  state: string;
  config: RedactedConfig;
  error: string | null;
  /** 由 bot 安装时是当时的 bot 名称。 */
  installedByBot: string | null;
}

export interface InstallContextView {
  installId: string;
  name: string;
  version: string;
  state: string;
  desired: string;
  config: RedactedConfig;
  riskyTools: string[];
}

export interface UserInstallInput {
  version?: string;
  config?: ConfigInput;
  /** Bot installs may not replace or reconfigure an existing live installation. */
  onlyIfAbsent?: boolean;
  signal?: AbortSignal;
}

export interface PushInput {
  versionId: string;
  userIds: readonly string[];
  forced?: boolean;
  wake?: boolean;
}

export interface PushView {
  id: string;
  appVersionId: string;
  forced: boolean;
  wake: boolean;
  state: string;
  targets: Array<{
    userId: string;
    machineId: string | null;
    installId: string | null;
    state: string;
    error: string | null;
  }>;
}

export interface ReconcileResult {
  installIds: string[];
  failedIds: string[];
}

interface VersionRow {
  id: string;
  appId: string;
  version: string;
  manifestJson: string;
  archivePath: string;
  sha256: string;
  status: string;
  recommended: boolean;
  importantNote: string | null;
  importantAt: string | null;
  createdAt: string;
}

interface AppRow {
  id: string;
  name: string;
  source: string;
  ownerUserId: string | null;
  createdAt: string;
}

interface VisibilityRow {
  appId: string;
  scope: string;
  userId: string | null;
}

interface InstallRow {
  id: string;
  machineId: string;
  appVersionId: string;
  forced: boolean;
  desired: string;
  state: string;
  configJson: string;
  error: string | null;
  updatedAt: string;
  installedByBotId: string | null;
  installedByBotName: string | null;
  resolvedVersion: string | null;
}

const installGates = new Map<string, Promise<void>>();
const installStack = new AsyncLocalStorage<Set<string>>();

export function catalogSecretName(installId: string, key: string): string {
  return `app:${installId}:${key}`;
}

export function publishCatalogVersion(deps: CatalogDeps, scope: AdminScope, input: PublishCatalogInput): PublishedVersion {
  assertAdmin(scope);
  const name = assertName(input.name);
  const version = assertVersion(input.version);
  const manifestJson = assertManifest(input.manifestJson);
  const archivePath = assertArchive(input.archivePath);
  const sha256 = assertSha(input.sha256);
  const source = assertSource(input.source);
  const stamp = nowIso(deps);
  const published = deps.db.transaction(() => {
    const existing = deps.db.select().from(apps).where(eq(apps.name, name)).get();
    if (existing?.source === APP_SOURCE_USER) throw new CatalogRejected("名称已被占用", 409);
    const appId = existing?.id ?? ulid();
    if (!existing) {
      deps.db.insert(apps).values({ id: appId, name, source, ownerUserId: null, createdAt: stamp }).run();
    }
    const duplicate = deps.db
      .select({ id: appVersions.id })
      .from(appVersions)
      .where(and(eq(appVersions.appId, appId), eq(appVersions.version, version)))
      .get();
    if (duplicate) throw new CatalogRejected("版本已存在", 409);
    const versionId = ulid();
    deps.db.insert(appVersions).values({
      id: versionId,
      appId,
      version,
      manifestJson,
      archivePath,
      sha256,
      status: VERSION_ACTIVE,
      recommended: false,
      createdAt: stamp,
    }).run();
    return { appId, versionId };
  });
  audit(deps, scope.actorUserId, AUDIT_ACTIONS.appPublish, published.appId, { versionId: published.versionId });
  return published;
}

export function createPrivateApp(deps: CatalogDeps, scope: UserScope, input: PrivateAppInput): PublishedVersion {
  const name = assertName(input.name);
  const version = assertVersion(input.version);
  const manifestJson = assertManifest(input.manifestJson);
  const archivePath = assertArchive(input.archivePath);
  const sha256 = assertSha(input.sha256);
  const stamp = nowIso(deps);
  return deps.db.transaction(() => {
    const existing = deps.db.select().from(apps).where(eq(apps.name, name)).get();
    if (existing && (existing.source !== APP_SOURCE_USER || existing.ownerUserId !== scope.userId)) {
      throw new CatalogRejected("名称已被占用", 409);
    }
    const appId = existing?.id ?? ulid();
    if (!existing) {
      deps.db.insert(apps).values({
        id: appId,
        name,
        source: APP_SOURCE_USER,
        ownerUserId: scope.userId,
        createdAt: stamp,
      }).run();
    }
    const duplicate = deps.db
      .select({ id: appVersions.id })
      .from(appVersions)
      .where(and(eq(appVersions.appId, appId), eq(appVersions.version, version)))
      .get();
    if (duplicate) throw new CatalogRejected("版本已存在", 409);
    const versionId = ulid();
    deps.db.insert(appVersions).values({
      id: versionId,
      appId,
      version,
      manifestJson,
      archivePath,
      sha256,
      status: VERSION_ACTIVE,
      recommended: false,
      createdAt: stamp,
    }).run();
    return { appId, versionId };
  });
}

export function withdrawPublishRequest(
  deps: CatalogDeps,
  userId: string,
  requestId: string,
): { id: string; state: "withdrawn" } {
  const row = deps.db.select().from(appPublishRequests).where(eq(appPublishRequests.id, requestId)).get();
  if (!row || row.requesterUserId !== userId) throw new CatalogRejected("找不到", 404);
  const version = deps.db.select().from(appVersions).where(eq(appVersions.id, row.appVersionId)).get();
  const app = version ? deps.db.select().from(apps).where(eq(apps.id, version.appId)).get() : undefined;
  if (!app || app.source !== APP_SOURCE_USER || app.ownerUserId !== userId) throw new CatalogRejected("找不到", 404);
  if (row.state !== "pending") throw new CatalogRejected("只能撤回待审批的申请", 409);
  const decidedAt = nowIso(deps);
  const result = deps.db
    .update(appPublishRequests)
    .set({ state: "withdrawn", decidedAt })
    .where(and(eq(appPublishRequests.id, requestId), eq(appPublishRequests.state, "pending")))
    .run();
  if (result.changes !== 1) throw new CatalogRejected("只能撤回待审批的申请", 409);
  return { id: requestId, state: "withdrawn" };
}

export function setVisibility(deps: CatalogDeps, scope: AdminScope, appId: string, spec: VisibilitySpec): void {
  assertAdmin(scope);
  const app = requireCatalogApp(deps.db, appId);
  if (spec.scope === "all" || spec.scope === "push") ensureSentinel(deps.db);
  const userIds = spec.scope === "user" ? normalizeUserIds(deps.db, spec.userIds) : [];
  deps.db.transaction(() => {
    deps.db.delete(appVisibility).where(eq(appVisibility.appId, app.id)).run();
    if (spec.scope === "all" || spec.scope === "push") {
      deps.db.insert(appVisibility).values({ appId: app.id, scope: spec.scope, userId: VISIBILITY_SENTINEL }).run();
      return;
    }
    for (const userId of userIds) {
      deps.db.insert(appVisibility).values({ appId: app.id, scope: "user", userId }).run();
    }
  });
}

export function recommendVersion(deps: CatalogDeps, scope: AdminScope, appId: string, versionId: string): void {
  assertAdmin(scope);
  const app = requireExistingApp(deps.db, appId);
  deps.db.transaction(() => {
    const version = deps.db.select().from(appVersions).where(eq(appVersions.id, versionId)).get();
    if (!version || version.appId !== appId) throw new CatalogRejected("找不到", 404);
    if (app.source === APP_SOURCE_USER && !approvedVersionIds(deps.db).has(versionId)) throw new CatalogRejected("找不到", 404);
    if (version.status !== VERSION_ACTIVE) throw new CatalogRejected("不能推荐已下架的版本", 409);
    deps.db.update(appVersions).set({ recommended: false }).where(eq(appVersions.appId, appId)).run();
    const result = deps.db
      .update(appVersions)
      .set({ recommended: true })
      .where(and(eq(appVersions.id, versionId), eq(appVersions.status, VERSION_ACTIVE)))
      .run();
    if (result.changes !== 1) throw new CatalogRejected("不能推荐已下架的版本", 409);
  });
}

export function markImportantVersion(
  deps: CatalogDeps,
  scope: AdminScope,
  appId: string,
  versionId: string,
  note: string,
): void {
  assertAdmin(scope);
  const text = note.trim();
  if ([...text].length === 0) throw new CatalogRejected("说明不能为空", 400);
  if ([...text].length > 500) throw new CatalogRejected("说明不能超过 500 字", 400);
  const app = requireExistingApp(deps.db, appId);
  const markedAt = nowIso(deps);
  const conversations = new Set<string>();
  deps.db.transaction(() => {
    const version = deps.db.select().from(appVersions).where(eq(appVersions.id, versionId)).get();
    if (!version || version.appId !== appId) throw new CatalogRejected("找不到", 404);
    if (app.source === APP_SOURCE_USER && !approvedVersionIds(deps.db).has(versionId)) throw new CatalogRejected("找不到", 404);
    if (version.status !== VERSION_ACTIVE) throw new CatalogRejected("不能推荐已下架的版本", 409);
    deps.db.update(appVersions).set({ importantNote: text, importantAt: markedAt }).where(eq(appVersions.id, versionId)).run();
    for (const target of importantAudience(deps, app.id, app.name, version.id, version.version, text, markedAt)) {
      insertAppUpdateNotice(deps.db, target.userId, target.payload);
      const conversationId = deliverAppUpdateNotices(deps.db, target.userId);
      if (conversationId) conversations.add(conversationId);
    }
  });
  for (const conversationId of conversations) deps.onNotice?.(conversationId);
  audit(deps, scope.actorUserId, AUDIT_ACTIONS.appImportant, appId, { versionId });
}

interface ImportantInstall {
  userId: string;
  status: string;
  machineState: string;
  currentVersion: string;
  installedVersionId: string;
  desired: string;
  installState: string;
}

function importantInstalls(db: AppDatabase, appId: string, userId?: string): ImportantInstall[] {
  return db.$client.prepare(
    `select u.id as userId, u.status as status, m.state as machineState,
            cur.version as currentVersion, i.app_version_id as installedVersionId,
            i.desired as desired, i.state as installState
     from app_installs i
     join machines m on m.id = i.machine_id
     join users u on u.id = m.user_id
     join app_versions cur on cur.id = i.app_version_id
     where cur.app_id = ? ${userId === undefined ? "" : "and u.id = ?"}
     order by i.updated_at desc, i.id desc`,
  ).all(...(userId === undefined ? [appId] : [appId, userId])) as ImportantInstall[];
}

function eligibleImportantInstall(db: AppDatabase, row: ImportantInstall, appId: string, versionId: string): boolean {
  return row.status === "active" && row.machineState !== "deleted"
    && row.desired === DESIRED_PRESENT && row.installState !== "removed"
    && row.installedVersionId !== versionId
    && versionVisibleTo(db, row.userId, appId, versionId);
}

export function deliverAppUpdateNotices(db: AppDatabase, userId: string): string | undefined {
  return deliverPendingNotices(db, userId, (payload) => {
    const [row] = importantInstalls(db, payload.appId, userId);
    return row !== undefined && eligibleImportantInstall(db, row, payload.appId, payload.targetVersionId);
  });
}

function importantAudience(
  deps: CatalogDeps,
  appId: string,
  appName: string,
  versionId: string,
  targetVersion: string,
  note: string,
  markedAt: string,
): Array<{ userId: string; payload: AppUpdatePayload }> {
  const rows = importantInstalls(deps.db, appId);
  const seen = new Set<string>();
  const targets: Array<{ userId: string; payload: AppUpdatePayload }> = [];
  for (const row of rows) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    if (!eligibleImportantInstall(deps.db, row, appId, versionId)) continue;
    targets.push({
      userId: row.userId,
      payload: {
        appId,
        appName,
        currentVersion: row.currentVersion,
        targetVersion,
        targetVersionId: versionId,
        note,
        markedAt,
      },
    });
  }
  return targets;
}

function versionVisibleTo(db: AppDatabase, userId: string, appId: string, versionId: string): boolean {
  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  const version = db.select().from(appVersions).where(and(eq(appVersions.id, versionId), eq(appVersions.appId, appId))).get();
  if (!app || version?.status !== VERSION_ACTIVE) return false;
  const visibility = db.select().from(appVisibility).where(eq(appVisibility.appId, appId)).all();
  const approved = app.source === APP_SOURCE_USER && db.select({ id: appPublishRequests.id }).from(appPublishRequests)
    .where(and(eq(appPublishRequests.appVersionId, versionId), eq(appPublishRequests.state, "approved"))).get();
  return Boolean(selectableVersions({ app, versions: [version], visibility }, userId, new Set(approved ? [versionId] : []))?.length);
}

export function retireVersion(deps: CatalogDeps, scope: AdminScope, appId: string, versionId: string): void {
  assertAdmin(scope);
  const app = requireExistingApp(deps.db, appId);
  const version = deps.db.select().from(appVersions).where(eq(appVersions.id, versionId)).get();
  if (!version || version.appId !== appId) throw new CatalogRejected("找不到", 404);
  if (app.source === APP_SOURCE_USER && !approvedVersionIds(deps.db).has(versionId)) throw new CatalogRejected("找不到", 404);
  deps.db.update(appVersions).set({ status: VERSION_RETIRED, recommended: false }).where(eq(appVersions.id, versionId)).run();
  audit(deps, scope.actorUserId, AUDIT_ACTIONS.appRetire, appId, { versionId });
}

export function listAdminCatalog(deps: CatalogDeps, scope: AdminScope): AdminCatalogEntry[] {
  assertAdmin(scope);
  const grouped = groupApps(deps.db);
  const approved = approvedVersionIds(deps.db);
  const names = new Map(deps.db.select({ id: users.id, name: users.name }).from(users).all().map((user) => [user.id, user.name]));
  const entries: AdminCatalogEntry[] = [];
  for (const item of grouped.values()) {
    const userSource = item.app.source === APP_SOURCE_USER;
    const versions = userSource ? item.versions.filter((version) => approved.has(version.id)) : item.versions;
    if (userSource && versions.length === 0) continue;
    const mode = adminVisibility(item.visibility);
    entries.push({
      id: item.app.id,
      name: item.app.name,
      source: item.app.source,
      ownerUserId: item.app.ownerUserId,
      ownerName: item.app.ownerUserId ? names.get(item.app.ownerUserId) ?? null : null,
      visibility: mode,
      userIds: item.visibility.flatMap((row) =>
        row.scope === "user" && row.userId && row.userId !== VISIBILITY_SENTINEL ? [row.userId] : [],
      ),
      versions: versions
        .slice()
        .sort(newest)
        .map((version) => ({
          id: version.id,
          version: version.version,
          status: version.status,
          recommended: version.recommended,
          importantNote: version.importantNote,
          importantAt: version.importantAt,
          sha256: version.sha256,
        })),
    });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

export function listUserCatalog(deps: CatalogDeps, userId: string): UserCatalogEntry[] {
  const approved = approvedVersionIds(deps.db);
  const names = ownerNames(deps.db);
  const requests = deps.db.select().from(appPublishRequests).all();
  const entries: UserCatalogEntry[] = [];
  for (const item of groupApps(deps.db).values()) {
    const versions = selectableVersions(item, userId, approved);
    if (!versions) continue;
    const visibility = item.app.source === APP_SOURCE_USER
      ? item.app.ownerUserId === userId ? "private" as const : "all" as const
      : visibilityFor(item.app, item.visibility, userId);
    if (visibility !== "private" && visibility !== "all" && visibility !== "user") continue;
    const version = preferredActive(versions);
    if (!version) continue;
    const ownerView = item.app.source === APP_SOURCE_USER && item.app.ownerUserId === userId;
    entries.push({
      id: item.app.id,
      name: item.app.name,
      source: item.app.source,
      visibility,
      version: { id: version.id, version: version.version, recommended: version.recommended },
      publisher: item.app.source === APP_SOURCE_USER && !ownerView ? names.get(item.app.ownerUserId ?? "") ?? null : null,
      privateVersions: ownerView ? versionStates(item.versions, requests) : [],
    });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

export interface AppSearchHit {
  name: string;
  version: string;
  description: string;
  installed: boolean;
  mcpServers: Array<{ name: string; type: string; command?: string; args?: string[]; url?: string }>;
  config: Array<{ key: string; description: string; secret: boolean }>;
  riskyTools: string[];
  publisher?: string;
  publishVersions?: Array<{ version: string; publishState: string; reason: string | null }>;
}

/** 精确名称。别人的私有应用返回 undefined。 */
export function findVisibleApp(deps: CatalogDeps, userId: string, name: string, selectedVersion?: string): {
  version: string; versions: string[]; config: AppSearchHit["config"]; mcpServers: AppSearchHit["mcpServers"]; riskyTools: string[]; runsInstallScript: boolean;
} | undefined {
  const approved = approvedVersionIds(deps.db);
  for (const item of groupApps(deps.db).values()) {
    if (item.app.name !== name) continue;
    const versions = selectableVersions(item, userId, approved);
    if (!versions) return undefined;
    const active = versions.filter((version) => version.status === VERSION_ACTIVE);
    const preferred = selectedVersion ? active.find((version) => version.version === selectedVersion) : preferredActive(versions);
    if (!preferred) return undefined;
    const declared = readManifestConfig(preferred.manifestJson);
    return {
      version: preferred.version, versions: active.map((version) => version.version),
      config: [...declared.keys].map((key) => ({ key, description: configDescription(preferred.manifestJson, key), secret: declared.secret.has(key) || /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i.test(declared.header.get(key) ?? "") })),
      mcpServers: serversFromArchive(preferred.archivePath),
      riskyTools: riskyToolsFromManifest(preferred.manifestJson),
      runsInstallScript: /"setup"\s*:/.test(preferred.manifestJson),
    };
  }
  return undefined;
}

/** 只查这个用户能看见的目录应用和他自己的私有应用。不访问网络，不调用机器。 */
export function searchApps(deps: CatalogDeps, userId: string, query: string): AppSearchHit[] {
  const needle = query.trim().toLowerCase();
  const installed = new Set(
    loadUserInstalls(deps.db, userId)
      .filter((item) => item.install.desired === DESIRED_PRESENT && item.install.state === "installed")
      .map((item) => item.app.name),
  );
  const hits: AppSearchHit[] = [];
  const approved = approvedVersionIds(deps.db);
  const names = ownerNames(deps.db);
  const requests = deps.db.select().from(appPublishRequests).all();
  for (const item of groupApps(deps.db).values()) {
    const versions = selectableVersions(item, userId, approved);
    if (!versions) continue;
    const version = preferredActive(versions);
    if (!version) continue;
    const description = manifestDescription(version.manifestJson);
    const declared = readManifestConfig(version.manifestJson);
    const config = [...declared.keys].sort().map((key) => ({
      key,
      description: configDescription(version.manifestJson, key),
      secret: declared.secret.has(key),
    }));
    const riskyTools = riskyToolsFromManifest(version.manifestJson);
    const mcpServers = serversFromArchive(version.archivePath);
    const haystack = [item.app.name, description, ...mcpServers.map((server) => server.name), ...config.map((item) => item.key)]
      .join("\n")
      .toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    hits.push({
      name: item.app.name,
      version: version.version,
      description,
      installed: installed.has(item.app.name),
      mcpServers,
      config,
      riskyTools,
      ...(item.app.source === APP_SOURCE_USER && item.app.ownerUserId !== userId && names.get(item.app.ownerUserId ?? "")
        ? { publisher: names.get(item.app.ownerUserId ?? "") as string }
        : {}),
      ...(item.app.source === APP_SOURCE_USER && item.app.ownerUserId === userId
        ? { publishVersions: versionStates(item.versions, requests) }
        : {}),
    });
    if (hits.length >= 40) break;
  }
  hits.sort((left, right) => left.name.localeCompare(right.name));
  return hits;
}

export function noteBotInstall(deps: CatalogDeps, installId: string, bot: { id: string; name: string }): void {
  const name = bot.name.replace(/[\r\n\0]/g, " ").trim().slice(0, 80);
  if (!name) return;
  deps.db.update(appInstalls).set({
    installedByBotId: bot.id,
    installedByBotName: name,
  }).where(eq(appInstalls.id, installId)).run();
}

/** 实际包版本属于安装记录；不能改审批绑定的归档版本标识。 */
export function recordResolvedVersion(deps: CatalogDeps, versionId: string, resolved: string): string {
  const version = resolved.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.!_+-]{0,63}$/.test(version) || version.includes("..")) throw new CatalogRejected("实际版本无效", 400);
  deps.db.update(appInstalls).set({ resolvedVersion: version }).where(eq(appInstalls.appVersionId, versionId)).run();
  return version;
}

export function listUserInstalls(deps: CatalogDeps, userId: string): InstallView[] {
  return loadUserInstalls(deps.db, userId).map(toInstallView);
}

export function installsForModelContext(deps: CatalogDeps, userId: string, botId?: string): InstallContextView[] {
  const views: InstallContextView[] = [];
  const disabled = botId ? new Set((deps.db.$client.prepare("select ba.app_install_id as id from bot_apps ba join bots b on b.id=ba.bot_id where ba.bot_id=? and b.user_id=? and ba.enabled=0").all(botId, userId) as Array<{ id: string }>).map((row) => row.id)) : undefined;
  for (const item of loadUserInstalls(deps.db, userId)) {
    if (item.install.desired !== DESIRED_PRESENT || item.install.state !== "installed") continue;
    if (disabled?.has(item.install.id)) continue;
    views.push({
      installId: item.install.id,
      name: item.app.name,
      version: item.version.version,
      state: item.install.state,
      desired: item.install.desired,
      config: toRedacted(item.install.configJson),
      riskyTools: riskyToolsFromManifest(item.version.manifestJson),
    });
  }
  return views;
}

export async function installForUser(
  deps: CatalogDeps,
  userId: string,
  name: string,
  input: UserInstallInput = {},
): Promise<InstallView> {
  input.signal?.throwIfAborted();
  const resolved = resolveForUser(deps.db, userId, name);
  const picked = pickVersion(resolved.versions, input.version);
  const machine = requireMachine(deps.db, userId);
  const config = input.config;
  const plan = planUserInstall(deps, machine.id, resolved.app.id, picked, config !== undefined, input.onlyIfAbsent);
  if (plan.action !== "dispatch") return mustInstallView(deps.db, plan.id);
  const ran = await runLocked(plan.id, "join", async () => {
    if (config) {
      try {
        storeConfig(deps, userId, plan.id, picked.manifestJson, config);
      } catch (error) {
        markInstall(deps, plan.id, "failed", "config");
        throw error;
      }
    }
    await performInstall(deps, {
      actorUserId: userId,
      userId,
      machineId: machine.id,
      installId: plan.id,
      appId: resolved.app.id,
      name: resolved.app.name,
      version: picked.version,
      versionId: picked.id,
      sha256: picked.sha256,
      archivePath: picked.archivePath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  });
  if (!ran) return mustInstallView(deps.db, plan.id);
  return mustInstallView(deps.db, plan.id);
}

export async function uninstallForUser(deps: CatalogDeps, userId: string, installId: string): Promise<InstallView> {
  const owned = findOwnedInstall(deps.db, userId, installId);
  if (!owned) throw new CatalogRejected("找不到", 404);
  if (owned.install.forced) throw new CatalogRejected("管理员推送的应用不能卸载", 403);
  if (owned.install.desired === DESIRED_ABSENT && owned.install.state === "removed") return toInstallView(owned);
  markInstall(deps, installId, "removing", null, DESIRED_ABSENT);
  try {
    await deps.installer.uninstall({
      machineId: owned.install.machineId,
      userId,
      installId,
      name: owned.app.name,
    });
  } catch {
    markInstall(deps, installId, "failed", "uninstall_failed", DESIRED_ABSENT);
    throw new CatalogRejected("卸载失败", 502);
  }
  markInstall(deps, installId, "removed", null, DESIRED_ABSENT);
  deps.db.delete(botApps).where(eq(botApps.appInstallId, installId)).run();
  emit(deps, {
    type: M2_EVENTS.appUninstalled,
    userId,
    machineId: owned.install.machineId,
    attrs: { installId, appId: owned.app.id, versionId: owned.version.id, state: "removed" },
  });
  audit(deps, userId, AUDIT_ACTIONS.appUninstall, installId, { appId: owned.app.id, versionId: owned.version.id });
  return mustInstallView(deps.db, installId);
}

export async function updateInstallConfig(
  deps: CatalogDeps,
  userId: string,
  installId: string,
  config: ConfigInput,
): Promise<InstallView> {
  const owned = findOwnedInstall(deps.db, userId, installId);
  if (!owned) throw new CatalogRejected("找不到", 404);
  if (!canReceivePackage(deps.db, userId, owned.version.id)) throw new CatalogRejected("找不到", 404);
  storeConfig(deps, userId, installId, owned.version.manifestJson, config);
  if (owned.install.desired !== DESIRED_PRESENT) return mustInstallView(deps.db, installId);
  await runLocked(installId, "follow", async () => {
    markInstall(deps, installId, "installing", null, DESIRED_PRESENT);
    await performInstall(deps, {
      actorUserId: userId,
      userId,
      machineId: owned.install.machineId,
      installId,
      appId: owned.app.id,
      name: owned.app.name,
      version: owned.version.version,
      versionId: owned.version.id,
      sha256: owned.version.sha256,
      archivePath: owned.version.archivePath,
    });
  });
  return mustInstallView(deps.db, installId);
}

export function createPush(deps: CatalogDeps, scope: AdminScope, appId: string, input: PushInput): PushView {
  assertAdmin(scope);
  const version = deps.db.select().from(appVersions).where(eq(appVersions.id, input.versionId)).get();
  if (!version || version.appId !== appId) throw new CatalogRejected("找不到", 404);
  requireCatalogApp(deps.db, appId);
  if (version.status !== VERSION_ACTIVE) throw new CatalogRejected("版本已下架", 409);
  const userIds = normalizeUserIds(deps.db, input.userIds);
  const stamp = nowIso(deps);
  const pushId = ulid();
  const forced = input.forced === true;
  const wake = input.wake === true;
  deps.db.transaction(() => {
    deps.db.insert(appPushes).values({
      id: pushId,
      appVersionId: version.id,
      actorUserId: scope.actorUserId,
      forced,
      wake,
      state: "pending",
      createdAt: stamp,
    }).run();
    for (const userId of userIds) {
      deps.db.insert(appPushTargets).values({
        pushId,
        userId,
        machineId: null,
        installId: null,
        state: "pending",
        error: null,
        updatedAt: stamp,
      }).run();
    }
  });
  audit(deps, scope.actorUserId, AUDIT_ACTIONS.appPush, pushId, {
    versionId: version.id,
    targetCount: userIds.length,
    forced,
  });
  emit(deps, {
    type: M2_EVENTS.appPushed,
    userId: scope.actorUserId,
    attrs: { pushId, versionId: version.id, targetCount: userIds.length, forced },
  });
  const work = () => runPush(deps, pushId);
  if (deps.schedule) deps.schedule(work);
  else queueMicrotask(() => void work().catch(() => undefined));
  return mustPush(deps.db, pushId);
}

export async function runPush(deps: CatalogDeps, pushId: string): Promise<void> {
  const push = deps.db.select().from(appPushes).where(eq(appPushes.id, pushId)).get();
  if (!push || push.state === "done") return;
  const version = deps.db.select().from(appVersions).where(eq(appVersions.id, push.appVersionId)).get();
  const app = version ? deps.db.select().from(apps).where(eq(apps.id, version.appId)).get() : undefined;
  deps.db.update(appPushes).set({ state: "running" }).where(eq(appPushes.id, pushId)).run();
  const targets = deps.db.select().from(appPushTargets).where(eq(appPushTargets.pushId, pushId)).all();
  for (const target of targets) {
    if (target.state === "installed") continue;
    if (!version || !app || version.status !== VERSION_ACTIVE || app.source === APP_SOURCE_USER) {
      markTarget(deps, pushId, target.userId, { state: "failed", error: "retired" });
      continue;
    }
    const user = userRepository(deps.db).findById(target.userId);
    if (!user || user.status === "disabled" || user.id === VISIBILITY_SENTINEL) {
      markTarget(deps, pushId, target.userId, { state: "failed", error: "user_disabled" });
      continue;
    }
    if (push.wake && deps.wake) {
      try {
        await deps.wake(target.userId);
      } catch {
        markTarget(deps, pushId, target.userId, { state: "failed", error: "wake_failed" });
        continue;
      }
    }
    const machine = findLiveMachine(deps.db, target.userId);
    if (!machine) {
      markTarget(deps, pushId, target.userId, { state: "failed", error: "no_machine" });
      continue;
    }
    const installId = ensureInstallRow(deps, {
      machineId: machine.id,
      version,
      forced: push.forced,
      state: "installing",
    });
    markTarget(deps, pushId, target.userId, { state: "installing", machineId: machine.id, installId, error: null });
    try {
      await runLocked(installId, "follow", async () => {
        await performInstall(deps, {
          actorUserId: push.actorUserId,
          userId: target.userId,
          machineId: machine.id,
          installId,
          appId: app.id,
          name: app.name,
          version: version.version,
          versionId: version.id,
          sha256: version.sha256,
          archivePath: version.archivePath,
        });
      });
      markTarget(deps, pushId, target.userId, { state: "installed", machineId: machine.id, installId, error: null });
    } catch {
      markTarget(deps, pushId, target.userId, { state: "failed", machineId: machine.id, installId, error: "install_failed" });
    }
  }
  const after = deps.db.select().from(appPushTargets).where(eq(appPushTargets.pushId, pushId)).all();
  const state = after.every((row) => row.state === "installed") ? "done" : "failed";
  deps.db.update(appPushes).set({ state }).where(eq(appPushes.id, pushId)).run();
}

export function readPush(deps: CatalogDeps, scope: AdminScope, pushId: string): PushView {
  assertAdmin(scope);
  const push = deps.db.select().from(appPushes).where(eq(appPushes.id, pushId)).get();
  if (!push) throw new CatalogRejected("找不到", 404);
  return mustPush(deps.db, pushId);
}

/** 机器重建后由集成方调用。只重装 desired=present，不把已卸载的应用装回去。 */
export async function reconcileMachineApps(deps: CatalogDeps, machineId: string): Promise<ReconcileResult> {
  const machine = deps.db
    .select({ id: machines.id, userId: machines.userId, state: machines.state })
    .from(machines)
    .where(eq(machines.id, machineId))
    .get();
  if (!machine) throw new CatalogRejected("找不到", 404);
  if (machine.state === "deleted") throw new CatalogRejected("没有可用的机器", 409);
  const rows = deps.db
    .select({
      installId: appInstalls.id,
      desired: appInstalls.desired,
      versionId: appVersions.id,
      version: appVersions.version,
      sha256: appVersions.sha256,
      archivePath: appVersions.archivePath,
      appId: apps.id,
      name: apps.name,
    })
    .from(appInstalls)
    .innerJoin(appVersions, eq(appVersions.id, appInstalls.appVersionId))
    .innerJoin(apps, eq(apps.id, appVersions.appId))
    .where(eq(appInstalls.machineId, machineId))
    .all();
  const installIds: string[] = [];
  const failedIds: string[] = [];
  for (const row of rows) {
    if (row.desired !== DESIRED_PRESENT) continue;
    if (!canReceivePackage(deps.db, machine.userId, row.versionId)) continue;
    installIds.push(row.installId);
    markInstall(deps, row.installId, "installing", null, DESIRED_PRESENT);
    try {
      await runLocked(row.installId, "follow", async () => {
        await performInstall(deps, {
          actorUserId: machine.userId,
          userId: machine.userId,
          machineId,
          installId: row.installId,
          appId: row.appId,
          name: row.name,
          version: row.version,
          versionId: row.versionId,
          sha256: row.sha256,
          archivePath: row.archivePath,
        });
      });
    } catch {
      failedIds.push(row.installId);
    }
  }
  return { installIds, failedIds };
}

const UPLOAD_LIMIT = 200 * 1024 * 1024;

export async function publishUploadedPackage(
  deps: CatalogDeps,
  actorUserId: string,
  bytes: Buffer,
  input: { kind?: string; version?: string; privateUserId?: string; source?: string } = {},
): Promise<PackagePublishResult> {
  if (bytes.length === 0 || bytes.length > UPLOAD_LIMIT) throw new CatalogRejected("应用包不合法", 400);
  let pkg: ValidatedPackage;
  try {
    pkg = packageFromBytes(input.kind ?? "archive", bytes);
  } catch (error) {
    rethrowArchive(error);
  }
  return publishValidatedPackage(deps, actorUserId, pkg, input);
}

export async function publishMcpUrl(
  deps: CatalogDeps,
  actorUserId: string,
  input: { name: string; version: string; url: string; privateUserId?: string },
): Promise<PackagePublishResult> {
  let pkg: ValidatedPackage;
  try {
    pkg = wrapMcpUrl(input.name, input.url);
  } catch (error) {
    rethrowArchive(error);
  }
  return publishValidatedPackage(deps, actorUserId, pkg, {
    version: input.version,
    ...(input.privateUserId !== undefined ? { privateUserId: input.privateUserId } : {}),
  });
}

export async function ingestCatalogSource(
  deps: CatalogDeps,
  actorUserId: string,
  body: Record<string, unknown>,
): Promise<PackagePublishResult> {
  try {
    if (body.kind === "git") {
      if (typeof body.gitUrl !== "string") throw new CatalogRejected("无法获取应用包", 400);
      const version = typeof body.version === "string" && body.version.length > 0 ? body.version : undefined;
      return await ingestGit(body.gitUrl, (archive) => publishUploadedPackage(deps, actorUserId, archive.bytes, {
        kind: archive.format === "tgz" ? "tgz" : "archive",
        source: "git",
        ...(version !== undefined ? { version } : {}),
      }));
    }
    if (body.kind === "npm") {
      if (typeof body.name !== "string" || typeof body.version !== "string") throw new CatalogRejected("无法获取应用包", 400);
      const pluginVersion = typeof body.pluginVersion === "string" && body.pluginVersion.length > 0 ? body.pluginVersion : undefined;
      return await ingestNpm(body.name, body.version, (archive) => publishUploadedPackage(deps, actorUserId, archive.bytes, {
        kind: "tgz",
        source: "npm",
        ...(pluginVersion !== undefined ? { version: pluginVersion } : {}),
      }));
    }
  } catch (error) {
    if (error instanceof CatalogRejected) throw error;
    throw new CatalogRejected("无法获取应用包", 400);
  }
  throw new CatalogRejected("无法获取应用包", 400);
}

export async function publishValidatedPackage(
  deps: CatalogDeps,
  actorUserId: string,
  pkg: ValidatedPackage,
  input: { version?: string; privateUserId?: string; source?: string },
): Promise<PackagePublishResult> {
  if (!deps.dataDir) throw new CatalogRejected("请求失败", 500);
  const manifestVersion = typeof pkg.manifest.version === "string" ? pkg.manifest.version : undefined;
  const version = input.version ?? manifestVersion ?? pkg.sha256;
  const name = assertName(pkg.name);
  const source = input.privateUserId ? APP_SOURCE_USER : assertSource(input.source);
  const manifestJson = JSON.stringify(catalogManifest(pkg));
  if (manifestJson.length > 256_000) throw new CatalogRejected("清单不合法", 400);
  const existing = deps.db.select().from(apps).where(eq(apps.name, name)).get();
  if (input.privateUserId) {
    if (existing && (existing.source !== APP_SOURCE_USER || existing.ownerUserId !== input.privateUserId)) {
      throw new CatalogRejected("名称已被占用", 409);
    }
  } else if (existing?.source === APP_SOURCE_USER) {
    throw new CatalogRejected("名称已被占用", 409);
  }
  const appId = existing?.id ?? ulid();
  if (existing) {
    const duplicate = deps.db.select({ id: appVersions.id }).from(appVersions)
      .where(and(eq(appVersions.appId, appId), eq(appVersions.version, version))).get();
    if (duplicate) throw new CatalogRejected("版本已存在", 409);
  }
  let archivePath: string;
  try {
    archivePath = await storePackage(deps.dataDir, appId, storageVersion(version, pkg.sha256), pkg);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") throw new CatalogRejected("版本已存在", 409);
    rethrowArchive(error);
  }
  const versionId = ulid();
  try {
    const stamp = nowIso(deps);
    const ownerUserId = input.privateUserId;
    deps.db.transaction(() => {
      const current = deps.db.select().from(apps).where(eq(apps.name, name)).get();
      if (current && current.id !== appId) throw new CatalogRejected("名称已被占用", 409);
      if (!current) {
        deps.db.insert(apps).values({ id: appId, name, source, ownerUserId: ownerUserId ?? null, createdAt: stamp }).run();
      } else if (ownerUserId) {
        if (current.source !== APP_SOURCE_USER || current.ownerUserId !== ownerUserId) throw new CatalogRejected("名称已被占用", 409);
      } else if (current.source === APP_SOURCE_USER) {
        throw new CatalogRejected("名称已被占用", 409);
      }
      const duplicate = deps.db.select({ id: appVersions.id }).from(appVersions)
        .where(and(eq(appVersions.appId, appId), eq(appVersions.version, version))).get();
      if (duplicate) throw new CatalogRejected("版本已存在", 409);
      deps.db.insert(appVersions).values({
        id: versionId,
        appId,
        version,
        manifestJson,
        archivePath,
        sha256: pkg.sha256,
        status: VERSION_ACTIVE,
        recommended: false,
        createdAt: stamp,
      }).run();
    });
  } catch (error) {
    await rm(archivePath, { force: true }).catch(() => undefined);
    if (error instanceof CatalogRejected) throw error;
    throw error;
  }
  if (!input.privateUserId) audit(deps, actorUserId, AUDIT_ACTIONS.appPublish, appId, { versionId });
  return { appId, versionId, name, version, warnings: pkg.warnings.slice(0, 50) };
}

function packageFromBytes(kind: string, bytes: Buffer): ValidatedPackage {
  if (kind === "mcpb") return wrapMcpb(bytes);
  const raw = kind === "zip" ? readZip(bytes) : readTar(bytes);
  if (kind === "zip" && raw.some((file) => file.path === "manifest.json") && !raw.some((file) => file.path === "plugin.json")) {
    return wrapMcpb(bytes);
  }
  const files = stripSingleRoot(raw);
  if (files.some((file) => file.path === "plugin.json")) return validatePackage(files);
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) throw new Error("Invalid plugin manifest");
  const text = skill.data.toString("utf8");
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const skillName = /^name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(head)?.[1] ?? "";
  return wrapSkill(skillName, files);
}

function stripSingleRoot(files: PackageFile[]): PackageFile[] {
  if (files.some((file) => file.path === "plugin.json" || file.path === "manifest.json" || file.path === "SKILL.md")) return files;
  const roots = new Set(files.map((file) => file.path.split("/")[0] ?? "").filter((part) => part.length > 0));
  if (roots.size !== 1) return files;
  const root = [...roots][0];
  if (!root) return files;
  const stripped = files.flatMap((file) => {
    if (!file.path.startsWith(`${root}/`)) return [];
    const path = file.path.slice(root.length + 1);
    return path.length > 0 ? [{ ...file, path }] : [];
  });
  return stripped.length > 0 ? stripped : files;
}

function catalogManifest(pkg: ValidatedPackage): Record<string, unknown> {
  const manifest: Record<string, unknown> = { ...pkg.manifest };
  const extensions = isRecord(manifest.extensions) ? { ...manifest.extensions } : {};
  extensions["ai.viate.bot"] = pkg.extension;
  manifest.extensions = extensions;
  return manifest;
}

function rethrowArchive(error: unknown): never {
  if (error instanceof CatalogRejected) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/too large|Too many/i.test(message)) throw new CatalogRejected("归档超过限制", 400);
  throw new CatalogRejected("应用包不合法", 400);
}

function uploadQuery(query: { kind?: string; version?: string; filename?: string }): { kind?: string; version?: string } {
  let kind = typeof query.kind === "string" && query.kind.length > 0 ? query.kind : undefined;
  if (!kind && typeof query.filename === "string") {
    const lower = query.filename.toLowerCase();
    if (lower.endsWith(".mcpb")) kind = "mcpb";
    else if (lower.endsWith(".zip")) kind = "zip";
    else if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) kind = "tgz";
    else if (lower.endsWith(".tar.zst") || lower.endsWith(".tzst") || lower.endsWith(".tar")) kind = "archive";
  }
  const version = typeof query.version === "string" && query.version.length > 0 ? query.version : undefined;
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogDeps): void {
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: UPLOAD_LIMIT }, (_request, body, done) => {
      done(null, body);
    });
  }
  app.get("/api/apps", async (request, reply) => {
    const user = sessionUser(request);
    if (!user) return reply.code(401).send({ error: "未登录" });
    return { apps: listUserCatalog(deps, user.id) };
  });

  app.get("/api/apps/installs", async (request, reply) => {
    const user = sessionUser(request);
    if (!user) return reply.code(401).send({ error: "未登录" });
    return { installs: listUserInstalls(deps, user.id) };
  });

  app.post<{ Params: { name: string } }>("/api/apps/:name/install", async (request, reply) => {
    const user = sessionUser(request);
    if (!user) return reply.code(401).send({ error: "未登录" });
    const body = asRecord(request.body);
    try {
      const install = await installForUser(deps, user.id, request.params.name, {
        ...(typeof body.version === "string" ? { version: body.version } : {}),
        ...(body.config !== undefined ? { config: parseConfigInput(body.config) } : {}),
      });
      return { install };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/apps/installs/:id/uninstall", async (request, reply) => {
    const user = sessionUser(request);
    if (!user) return reply.code(401).send({ error: "未登录" });
    try {
      return { install: await uninstallForUser(deps, user.id, request.params.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/apps/installs/:id/config", async (request, reply) => {
    const user = sessionUser(request);
    if (!user) return reply.code(401).send({ error: "未登录" });
    try {
      const config = parseConfigInput(asRecord(request.body).config);
      return { install: await updateInstallConfig(deps, user.id, request.params.id, config) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Querystring: { kind?: string; version?: string; filename?: string } }>(
    "/api/apps/private/upload",
    { bodyLimit: UPLOAD_LIMIT },
    async (request, reply) => {
      const user = sessionUser(request);
      if (!user) return reply.code(401).send({ error: "未登录" });
      try {
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes)) throw new CatalogRejected("应用包不合法", 400);
        const published = await publishUploadedPackage(deps, user.id, bytes, { ...uploadQuery(request.query), privateUserId: user.id });
        return reply.code(201).send(published);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string; versionId: string } }>(
    "/api/admin/apps/:id/versions/:versionId/important",
    async (request, reply) => {
      const scope = adminActor(request);
      if (!scope) return reply.code(404).send({ error: "找不到" });
      const body = asRecord(request.body);
      if (typeof body.note !== "string") return reply.code(400).send({ error: "说明不能为空" });
      try {
        markImportantVersion(deps, scope, request.params.id, request.params.versionId, body.note);
        return { ok: true };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post("/api/apps/private", async (request, reply) => {
    const user = sessionUser(request);
    if (!user) return reply.code(401).send({ error: "未登录" });
    const body = asRecord(request.body);
    if (typeof body.name !== "string" || typeof body.version !== "string" || typeof body.mcpUrl !== "string") {
      return reply.code(400).send({ error: "应用包不合法" });
    }
    try {
      const published = await publishMcpUrl(deps, user.id, {
        name: body.name,
        version: body.version,
        url: body.mcpUrl,
        privateUserId: user.id,
      });
      return reply.code(201).send(published);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { name: string } }>("/api/apps/:name/publish", async (request, reply) => {
    const user = sessionUser(request);
    if (!user) return reply.code(401).send({ error: "未登录" });
    const body = asRecord(request.body);
    if (typeof body.version !== "string" || typeof body.note !== "string") return reply.code(400).send({ error: "发布说明不合法" });
    try {
      const created = requestAppPublish(deps, user.id, { name: request.params.name, version: body.version, note: body.note });
      return reply.code(201).send(created);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/admin/app-reviews", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    return listPublishReviews(deps, scope);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/admin/app-reviews/:id/files", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    if (typeof request.query.path !== "string") return reply.code(400).send({ error: "找不到文件" });
    try {
      return publishReviewFile(deps, scope, request.params.id, request.query.path);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/admin/app-reviews/:id", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      return publishReviewDetail(deps, scope, request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/admin/app-reviews/:id/approve", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      return decidePublishReview(deps, scope, request.params.id, { decision: "approve" });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/admin/app-reviews/:id/reject", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    const body = asRecord(request.body);
    if (typeof body.reason !== "string") return reply.code(400).send({ error: "驳回原因不能为空" });
    try {
      return decidePublishReview(deps, scope, request.params.id, { decision: "reject", reason: body.reason });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/admin/apps", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    return { apps: listAdminCatalog(deps, scope) };
  });

  app.put<{ Params: { id: string } }>("/api/admin/apps/:id/visibility", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      setVisibility(deps, scope, request.params.id, parseVisibility(request.body));
      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string; versionId: string } }>(
    "/api/admin/apps/:id/versions/:versionId/recommend",
    async (request, reply) => {
      const scope = adminActor(request);
      if (!scope) return reply.code(404).send({ error: "找不到" });
      try {
        recommendVersion(deps, scope, request.params.id, request.params.versionId);
        return { ok: true };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string; versionId: string } }>(
    "/api/admin/apps/:id/versions/:versionId/retire",
    async (request, reply) => {
      const scope = adminActor(request);
      if (!scope) return reply.code(404).send({ error: "找不到" });
      try {
        retireVersion(deps, scope, request.params.id, request.params.versionId);
        return { ok: true };
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/admin/apps/:id/push", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    const body = asRecord(request.body);
    if (typeof body.versionId !== "string" || !Array.isArray(body.userIds)) {
      return reply.code(400).send({ error: "推送参数不合法" });
    }
    const userIds: string[] = [];
    for (const id of body.userIds) {
      if (typeof id !== "string") return reply.code(400).send({ error: "推送参数不合法" });
      userIds.push(id);
    }
    try {
      const push = createPush(deps, scope, request.params.id, {
        versionId: body.versionId,
        userIds,
        ...(typeof body.forced === "boolean" ? { forced: body.forced } : {}),
        ...(typeof body.wake === "boolean" ? { wake: body.wake } : {}),
      });
      return reply.code(202).send({ push });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { pushId: string } }>("/api/admin/apps/pushes/:pushId", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      return { push: readPush(deps, scope, request.params.pushId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Querystring: { kind?: string; version?: string; filename?: string } }>(
    "/api/admin/apps/upload",
    { bodyLimit: UPLOAD_LIMIT },
    async (request, reply) => {
      const scope = adminActor(request);
      if (!scope) return reply.code(404).send({ error: "找不到" });
      try {
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes)) throw new CatalogRejected("应用包不合法", 400);
        const published = await publishUploadedPackage(deps, scope.actorUserId, bytes, uploadQuery(request.query));
        return reply.code(201).send(published);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post("/api/admin/apps/ingest", async (request, reply) => {
    const scope = adminActor(request);
    if (!scope) return reply.code(404).send({ error: "找不到" });
    try {
      const published = await ingestCatalogSource(deps, scope.actorUserId, asRecord(request.body));
      return reply.code(201).send(published);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function planUserInstall(
  deps: CatalogDeps,
  machineId: string,
  appId: string,
  version: VersionRow,
  configChanged: boolean,
  onlyIfAbsent = false,
): { id: string; action: "dispatch" | "ready" | "wait" } {
  return deps.db.transaction(() => {
    const row = findInstallForApp(deps.db, machineId, appId);
    if (onlyIfAbsent && row?.desired === DESIRED_PRESENT && (row.state === "installed" || row.state === "installing" || installGates.has(row.id))) {
      throw new CatalogRejected("应用已安装或正在安装；修改配置请使用应用页", 409);
    }
    if (row?.forced && row.appVersionId !== version.id) throw new CatalogRejected("管理员推送的应用不能更换版本", 403);
    if (row && installGates.has(row.id)) return { id: row.id, action: "wait" };
    if (
      row &&
      row.desired === DESIRED_PRESENT &&
      row.appVersionId === version.id &&
      row.state === "installed" &&
      !configChanged
    ) {
      return { id: row.id, action: "ready" };
    }
    const id = row?.id ?? ulid();
    const stamp = nowIso(deps);
    if (!row) {
      deps.db.insert(appInstalls).values({
        id,
        machineId,
        appVersionId: version.id,
        forced: false,
        desired: DESIRED_PRESENT,
        state: "installing",
        configJson: "{}",
        error: null,
        updatedAt: stamp,
      }).run();
    } else {
      deps.db.update(appInstalls).set({
        appVersionId: version.id,
        desired: DESIRED_PRESENT,
        state: "installing",
        resolvedVersion: null,
        error: null,
        updatedAt: stamp,
      }).where(eq(appInstalls.id, id)).run();
    }
    return { id, action: "dispatch" };
  });
}

function ensureInstallRow(
  deps: CatalogDeps,
  input: { machineId: string; version: VersionRow; forced: boolean; state: string },
): string {
  return deps.db.transaction(() => {
    const row = findInstallForApp(deps.db, input.machineId, input.version.appId);
    const stamp = nowIso(deps);
    if (!row) {
      const id = ulid();
      deps.db.insert(appInstalls).values({
        id,
        machineId: input.machineId,
        appVersionId: input.version.id,
        forced: input.forced,
        desired: DESIRED_PRESENT,
        state: input.state,
        configJson: "{}",
        error: null,
        updatedAt: stamp,
      }).run();
      return id;
    }
    deps.db.update(appInstalls).set({
      appVersionId: input.version.id,
      forced: input.forced,
      desired: DESIRED_PRESENT,
      state: input.state,
      error: null,
      updatedAt: stamp,
    }).where(eq(appInstalls.id, row.id)).run();
    return row.id;
  });
}

async function performInstall(deps: CatalogDeps, input: {
  actorUserId: string;
  userId: string;
  machineId: string;
  installId: string;
  appId: string;
  name: string;
  version: string;
  versionId: string;
  sha256: string;
  archivePath: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!canReceivePackage(deps.db, input.userId, input.versionId)) throw new CatalogRejected("找不到", 404);
  try {
    materializeInjection(deps, input.userId, input.installId);
  } catch {
    markInstall(deps, input.installId, "failed", "secret_unreadable", DESIRED_PRESENT);
    emitFailure(deps, input, "secret_unreadable");
    throw new CatalogRejected("安装失败", 502);
  }
  let routines: ReadonlyArray<{ cron: string; timezone: string; prompt: string }> = [];
  try {
    const installed = await deps.installer.install({
      machineId: input.machineId,
      userId: input.userId,
      installId: input.installId,
      name: input.name,
      version: storageVersion(input.version, input.sha256),
      sha256: input.sha256,
      archivePath: input.archivePath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (installed?.routines) routines = installed.routines;
  } catch (error) {
    const code = installFailureCode(error);
    markInstall(deps, input.installId, "failed", code, input.signal?.aborted ? DESIRED_ABSENT : DESIRED_PRESENT);
    emitFailure(deps, input, code);
    throw new CatalogRejected("安装失败", 502, { cause: error });
  }
  markInstall(deps, input.installId, "installed", null, DESIRED_PRESENT);
  linkBots(deps.db, input.userId, input.installId);
  proposeTemplateRoutines(deps, input.userId, routines);
  emit(deps, {
    type: M2_EVENTS.appInstalled,
    userId: input.userId,
    machineId: input.machineId,
    attrs: { installId: input.installId, appId: input.appId, versionId: input.versionId, state: "installed" },
  });
  audit(deps, input.actorUserId, AUDIT_ACTIONS.appInstall, input.installId, {
    appId: input.appId,
    versionId: input.versionId,
    machineId: input.machineId,
  });
}

function emitFailure(
  deps: CatalogDeps,
  input: { userId: string; machineId: string; installId: string; appId: string; versionId: string },
  errorClass: string,
): void {
  emit(deps, {
    type: M2_EVENTS.appInstallFailed,
    userId: input.userId,
    machineId: input.machineId,
    attrs: { installId: input.installId, appId: input.appId, versionId: input.versionId, errorClass },
  });
}

/** 只留下稳定分类，不把安装器原文写进记录，避免夹带命令或密钥。 */
function installFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("超时")) return "setup_timeout";
  if (message.includes("校验") || message.includes("无效") || message.includes("越界")) return "invalid_package";
  return "install_failed";
}

function storeConfig(deps: CatalogDeps, userId: string, installId: string, manifestJson: string, input: ConfigInput): void {
  const declared = readManifestConfig(manifestJson);
  if (declared.restricted) {
    for (const key of Object.keys(input)) {
      if (!declared.keys.has(key)) throw new CatalogRejected("配置项不在应用声明里", 400);
    }
  }
  const existing = loadInstallSecrets(deps, userId, installId);
  const secretPlain = new Map<string, string>();
  const secretRefs = new Map<string, { secretRef: string; prefix?: string }>();
  const plain = new Map<string, string>();
  let wroteSecret = false;
  for (const [key, value] of Object.entries(input)) {
    const forceSecret = declared.secret.has(key);
    if (isSecretRefValue(value)) {
      const ref = normalizeSecretRef(value);
      requireUserSecret(deps, userId, ref.secretRef);
      secretRefs.set(key, ref);
      continue;
    }
    if (typeof value === "string" && !forceSecret) {
      plain.set(key, value);
      continue;
    }
    const supplied = typeof value === "string" ? value : value.value;
    if (supplied !== undefined) {
      if (supplied.length === 0) throw new CatalogRejected("配置值不能为空", 400);
      secretPlain.set(key, supplied);
      wroteSecret = true;
      continue;
    }
    const kept = existing.get(key);
    if (!kept || kept.value === undefined) throw new CatalogRejected("还没有这个密钥", 400);
    secretPlain.set(key, kept.value);
  }
  const masks = [...secretPlain.entries()].map(([name, value]) => ({ name, value }));
  const redacted: RedactedConfig = {};
  for (const key of [...plain.keys()].sort()) {
    const text = plain.get(key);
    if (text === undefined) continue;
    redacted[key] = maskSecrets(text, masks);
  }
  for (const key of [...secretPlain.keys()].sort()) redacted[key] = { secret: true };
  for (const key of [...secretRefs.keys()].sort()) {
    const ref = secretRefs.get(key);
    if (!ref) continue;
    redacted[key] = ref.prefix
      ? { secret: true, secretRef: ref.secretRef, prefix: ref.prefix }
      : { secret: true, secretRef: ref.secretRef };
  }
  for (const [key, row] of existing) {
    if (!secretPlain.has(key)) deps.db.delete(secrets).where(eq(secrets.id, row.id)).run();
  }
  for (const [key, value] of secretPlain) {
    const supplied = input[key];
    const replaced = typeof supplied === "string" || (supplied !== undefined && "value" in supplied && supplied.value !== undefined);
    if (!replaced) continue;
    const name = catalogSecretName(installId, key);
    const valueEnc = encrypt(deps.key, value);
    const found = existing.get(key);
    if (found) {
      deps.db.update(secrets).set({ valueEnc, scope: SECRET_SCOPE }).where(eq(secrets.id, found.id)).run();
    } else {
      deps.db.insert(secrets).values({
        id: ulid(),
        userId,
        name,
        valueEnc,
        scope: SECRET_SCOPE,
        createdAt: nowIso(deps),
      }).run();
    }
  }
  deps.db.update(appInstalls).set({
    configJson: JSON.stringify(redacted),
    updatedAt: nowIso(deps),
  }).where(eq(appInstalls.id, installId)).run();
  if (wroteSecret) {
    emit(deps, { type: M2_EVENTS.secretFormUsed, userId, attrs: { installId, count: secretPlain.size } });
    audit(deps, userId, AUDIT_ACTIONS.secretForm, installId, { count: secretPlain.size });
  }
}

/**
 * 从 secrets 解出本次启动要用的 env / headers。
 * 不写回数据库，不改 mcp.json，不替换 ${config.KEY}。返回值只交给 machined 的 launchMcp。
 */
export function resolveMcpLaunch(deps: CatalogDeps, userId: string, name: string): CatalogMcpLaunch {
  if (!NAME_RE.test(name) || name.includes("..") || name.includes("--")) throw new CatalogRejected("找不到", 404);
  const rows = deps.db
    .select({
      installId: appInstalls.id,
      desired: appInstalls.desired,
      state: appInstalls.state,
      machineState: machines.state,
    })
    .from(appInstalls)
    .innerJoin(machines, eq(machines.id, appInstalls.machineId))
    .innerJoin(appVersions, eq(appVersions.id, appInstalls.appVersionId))
    .innerJoin(apps, eq(apps.id, appVersions.appId))
    .where(and(eq(machines.userId, userId), eq(apps.name, name)))
    .all();
  const live = rows.find((item) => item.desired === DESIRED_PRESENT && item.state === "installed" && item.machineState !== "deleted");
  if (!live) throw new CatalogRejected("找不到", 404);
  try {
    const injection = materializeInjection(deps, userId, live.installId);
    return { installId: live.installId, name, env: injection.env, headers: injection.headers };
  } catch (error) {
    if (error instanceof CatalogRejected && error.statusCode === 400) throw error;
    throw new CatalogRejected("请求失败", 502);
  }
}

/** 把已有用户密钥引用写进安装配置。不重装，不复制密文，不停 MCP。 */
export function bindSecretRefs(
  deps: CatalogDeps,
  userId: string,
  secretName: string,
  targets: readonly SecretRefTarget[],
): Array<{ installId: string; appName: string; key: string; prefix?: string }> {
  if (!USER_SECRET_NAME.test(secretName) || secretName.startsWith("app:")) throw new CatalogRejected("密钥名不合法", 400);
  requireUserSecret(deps, userId, secretName);
  if (targets.length === 0) throw new CatalogRejected("没有可绑定的应用", 400);
  const bound: Array<{ installId: string; appName: string; key: string; prefix?: string }> = [];
  for (const target of targets) {
    if (!CONFIG_KEY.test(target.key)) throw new CatalogRejected("配置名不合法", 400);
    const prefix = target.prefix && target.prefix.length > 0 ? target.prefix : undefined;
    if (prefix !== undefined && !validPrefix(prefix)) throw new CatalogRejected("密钥前缀不合法", 400);
    const owned = findOwnedInstall(deps.db, userId, target.installId);
    if (!owned || owned.install.desired !== DESIRED_PRESENT || owned.install.state !== "installed") {
      throw new CatalogRejected("找不到", 404);
    }
    const declared = readManifestConfig(owned.version.manifestJson);
    if (declared.restricted && !declared.keys.has(target.key)) throw new CatalogRejected("配置项不在应用声明里", 400);
    if (declared.restricted && !declared.secret.has(target.key)) throw new CatalogRejected("配置项不是密钥", 400);
    const next: ConfigInput = { ...toRedacted(owned.install.configJson) };
    next[target.key] = prefix
      ? { secret: true, secretRef: secretName, prefix }
      : { secret: true, secretRef: secretName };
    storeConfig(deps, userId, target.installId, owned.version.manifestJson, next);
    materializeInjection(deps, userId, target.installId);
    bound.push({
      installId: target.installId,
      appName: owned.app.name,
      key: target.key,
      ...(prefix ? { prefix } : {}),
    });
  }
  return bound;
}

/** 按声明把值放进 stdio env 或 HTTP header。字符串原样传递，不展开 ${config.KEY}。 */
function materializeInjection(
  deps: CatalogDeps,
  userId: string,
  installId: string,
): { env: Record<string, string>; headers: Record<string, string> } {
  const row = deps.db
    .select({ configJson: appInstalls.configJson, manifestJson: appVersions.manifestJson })
    .from(appInstalls)
    .innerJoin(appVersions, eq(appVersions.id, appInstalls.appVersionId))
    .where(eq(appInstalls.id, installId))
    .get();
  if (!row) throw new CatalogRejected("安装失败", 502);
  const declared = readManifestConfig(row.manifestJson);
  const config = toRedacted(row.configJson);
  const stored = loadInstallSecrets(deps, userId, installId);
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    const plain = injectedValue(deps, userId, value, stored.get(key)?.value);
    if (plain === undefined) throw new CatalogRejected("安装失败", 502);
    const header = declared.header.get(key);
    const named = declared.env.get(key);
    if (named) env[named] = plain;
    else if (!header) env[key] = plain;
    if (header) headers[header] = plain;
  }
  return { env, headers };
}

/** scheme、host 或 port 变化时丢掉 Authorization 和本次注入的 header。同 origin 保持原样。 */
export function headersAfterRedirect(
  fromUrl: string,
  nextUrl: string,
  headers: Readonly<Record<string, string>>,
  injected: readonly string[],
): Record<string, string> {
  if (sameOrigin(fromUrl, nextUrl)) return { ...headers };
  const drop = new Set(injected.map((name) => name.toLowerCase()));
  drop.add("authorization");
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (drop.has(name.toLowerCase())) continue;
    kept[name] = value;
  }
  return kept;
}

function sameOrigin(fromUrl: string, nextUrl: string): boolean {
  try {
    return originOf(fromUrl) === originOf(nextUrl);
  } catch {
    return false;
  }
}

function originOf(value: string): string {
  const url = new URL(value);
  const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
}

function loadInstallSecrets(
  deps: CatalogDeps,
  userId: string,
  installId: string,
): Map<string, { id: string; value: string | undefined }> {
  const prefix = `app:${installId}:`;
  const rows = deps.db
    .select()
    .from(secrets)
    .where(and(eq(secrets.userId, userId), eq(secrets.scope, SECRET_SCOPE)))
    .all();
  const map = new Map<string, { id: string; value: string | undefined }>();
  for (const row of rows) {
    if (!row.name.startsWith(prefix)) continue;
    const key = row.name.slice(prefix.length);
    if (!CONFIG_KEY.test(key)) continue;
    let value: string | undefined;
    try {
      value = decrypt(deps.key, row.valueEnc);
    } catch {
      value = undefined;
    }
    map.set(key, { id: row.id, value });
  }
  return map;
}

function injectedValue(
  deps: CatalogDeps,
  userId: string,
  value: RedactedConfig[string],
  stored: string | undefined,
): string | undefined {
  if (typeof value === "string") return value;
  if ("secretRef" in value && typeof value.secretRef === "string") {
    const prefix = "prefix" in value && typeof value.prefix === "string" ? value.prefix : "";
    if (prefix && !validPrefix(prefix)) throw new CatalogRejected("密钥前缀不合法", 400);
    return `${prefix}${requireUserSecret(deps, userId, value.secretRef)}`;
  }
  return stored;
}

function redactedSecret(value: Record<string, unknown>): { secret: true } | { secret: true; secretRef: string; prefix?: string } {
  if (typeof value.secretRef !== "string" || !USER_SECRET_NAME.test(value.secretRef) || value.secretRef.startsWith("app:")) {
    return { secret: true };
  }
  const prefix = typeof value.prefix === "string" && value.prefix.length > 0 && validPrefix(value.prefix) ? value.prefix : undefined;
  return prefix ? { secret: true, secretRef: value.secretRef, prefix } : { secret: true, secretRef: value.secretRef };
}

function collectManifestConfig(config: unknown): ManifestConfigItem[] | undefined {
  if (Array.isArray(config)) {
    const items: ManifestConfigItem[] = [];
    for (const item of config) {
      if (!isRecord(item) || typeof item.key !== "string" || !CONFIG_KEY.test(item.key)) continue;
      items.push(manifestItem(item.key, item));
    }
    return items;
  }
  if (!isRecord(config)) return undefined;
  const items: ManifestConfigItem[] = [];
  for (const [key, spec] of Object.entries(config)) {
    if (!CONFIG_KEY.test(key)) continue;
    items.push(manifestItem(key, isRecord(spec) ? spec : {}));
  }
  return items;
}

function manifestItem(key: string, spec: Record<string, unknown>): ManifestConfigItem {
  const item: ManifestConfigItem = { key, secret: spec.secret === true };
  if (typeof spec.credential === "string" && CREDENTIAL_NAME.test(spec.credential)) item.credential = spec.credential;
  if (typeof spec.prefix === "string" && validPrefix(spec.prefix)) item.prefix = spec.prefix;
  if (typeof spec.env === "string" && ENV_NAME.test(spec.env)) item.env = spec.env;
  if (typeof spec.header === "string" && HEADER_NAME.test(spec.header)) item.header = spec.header;
  return item;
}

function isSecretRefValue(value: ConfigValue): value is { secret: true; secretRef: string; prefix?: string } {
  return typeof value !== "string" && "secretRef" in value && typeof value.secretRef === "string";
}

function normalizeSecretRef(value: { secretRef: string; prefix?: string }): { secret: true; secretRef: string; prefix?: string } {
  if (!USER_SECRET_NAME.test(value.secretRef) || value.secretRef.startsWith("app:")) throw new CatalogRejected("密钥名不合法", 400);
  if (value.prefix === undefined || value.prefix.length === 0) return { secret: true, secretRef: value.secretRef };
  if (!validPrefix(value.prefix)) throw new CatalogRejected("密钥前缀不合法", 400);
  return { secret: true, secretRef: value.secretRef, prefix: value.prefix };
}

function validPrefix(value: string): boolean {
  return value.length <= 64 && !CONTROL_CHARS.test(value);
}

function requireUserSecret(deps: CatalogDeps, userId: string, name: string): string {
  if (!USER_SECRET_NAME.test(name) || name.startsWith("app:")) throw new CatalogRejected("密钥名不合法", 400);
  const row = deps.db
    .select()
    .from(secrets)
    .where(and(eq(secrets.userId, userId), eq(secrets.name, name)))
    .get();
  if (!row || row.scope === SECRET_SCOPE || row.name.startsWith("app:")) {
    throw new CatalogRejected(`引用的密钥 ${name} 不存在，请先登录或保存该密钥`, 400);
  }
  try {
    const value = decrypt(deps.key, row.valueEnc);
    if (value.length === 0) throw new CatalogRejected(`引用的密钥 ${name} 不存在，请先登录或保存该密钥`, 400);
    return value;
  } catch (error) {
    if (error instanceof CatalogRejected) throw error;
    throw new CatalogRejected(`引用的密钥 ${name} 不存在，请先登录或保存该密钥`, 400);
  }
}

function proposeTemplateRoutines(
  deps: CatalogDeps,
  userId: string,
  routines: ReadonlyArray<{ cron: string; timezone: string; prompt: string }>,
): void {
  if (routines.length === 0) return;
  const now = deps.now?.() ?? new Date();
  const service = routineService(deps.db);
  const botRows = deps.db.select({ id: bots.id }).from(bots).where(and(eq(bots.userId, userId), isNull(bots.deletedAt))).all();
  for (const bot of botRows) {
    for (const routine of routines) {
      if (!acceptableRoutine(routine, now)) continue;
      const existing = deps.db.$client
        .prepare("select 1 as ok from routines where bot_id=? and cron=? and timezone=? and prompt=? and state!='deleted'")
        .get(bot.id, routine.cron, routine.timezone, routine.prompt);
      if (existing) continue;
      service.propose(userId, bot.id, routine, now);
    }
  }
}

function acceptableRoutine(routine: { cron: string; timezone: string; prompt: string }, now: Date): boolean {
  if (!routine.prompt.trim()) return false;
  try {
    nextCron(routine.cron, routine.timezone, now);
    return true;
  } catch {
    return false;
  }
}

function linkBots(db: AppDatabase, userId: string, installId: string): void {
  const rows = db.select({ id: bots.id }).from(bots).where(and(eq(bots.userId, userId), isNull(bots.deletedAt))).all();
  for (const bot of rows) {
    db.insert(botApps).values({ botId: bot.id, appInstallId: installId, enabled: true }).onConflictDoNothing().run();
  }
}

async function runLocked(id: string, mode: "join" | "follow", work: () => Promise<void>): Promise<boolean> {
  const current = installGates.get(id);
  if (current) {
    // 同一次安装在机器就绪时会对账，对账又会跟这把锁。跟着等就是自己等自己。别的请求仍然等。
    if (mode === "join" || installStack.getStore()?.has(id)) return false;
    await current;
    return runLocked(id, mode, work);
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  installGates.set(id, promise);
  const stack = new Set(installStack.getStore());
  stack.add(id);
  return installStack.run(stack, async () => {
    try {
      await work();
      return true;
    } finally {
      installGates.delete(id);
      resolve();
    }
  });
}

function resolveForUser(db: AppDatabase, userId: string, name: string): { app: AppRow; versions: VersionRow[] } {
  if (!NAME_RE.test(name) || name.includes("..") || name.includes("--")) throw new CatalogRejected("找不到", 404);
  const grouped = groupApps(db);
  const item = [...grouped.values()].find((entry) => entry.app.name === name);
  if (!item) throw new CatalogRejected("找不到", 404);
  const versions = selectableVersions(item, userId, approvedVersionIds(db));
  if (!versions) throw new CatalogRejected("找不到", 404);
  return { app: item.app, versions };
}

function pickVersion(versions: VersionRow[], requested: string | undefined): VersionRow {
  if (requested !== undefined) {
    const version = assertVersion(requested);
    const match = versions.find((item) => item.version === version);
    if (!match) throw new CatalogRejected("找不到", 404);
    if (match.status !== VERSION_ACTIVE) throw new CatalogRejected("版本已下架", 409);
    return match;
  }
  const active = preferredActive(versions);
  if (!active) throw new CatalogRejected("找不到", 404);
  return active;
}

function preferredActive(versions: VersionRow[]): VersionRow | undefined {
  const active = versions.filter((version) => version.status === VERSION_ACTIVE);
  return active.find((version) => version.recommended) ?? active.slice().sort(newest)[0];
}

function newest(left: VersionRow, right: VersionRow): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function groupApps(db: AppDatabase): Map<string, { app: AppRow; versions: VersionRow[]; visibility: VisibilityRow[] }> {
  const map = new Map<string, { app: AppRow; versions: VersionRow[]; visibility: VisibilityRow[] }>();
  for (const app of db.select().from(apps).all()) {
    map.set(app.id, { app, versions: [], visibility: [] });
  }
  for (const version of db.select().from(appVersions).all()) map.get(version.appId)?.versions.push(version);
  for (const row of db.select().from(appVisibility).all()) map.get(row.appId)?.visibility.push(row);
  return map;
}

function approvedVersionIds(db: AppDatabase): Set<string> {
  const rows = db
    .select({ id: appPublishRequests.appVersionId })
    .from(appPublishRequests)
    .where(eq(appPublishRequests.state, "approved"))
    .all();
  return new Set(rows.map((row) => row.id));
}

function ownerNames(db: AppDatabase): Map<string, string> {
  return new Map(db.select({ id: users.id, name: users.name }).from(users).all().map((user) => [user.id, user.name]));
}

function versionStates(
  versions: VersionRow[],
  requests: Array<{ appVersionId: string; state: string; reason: string | null; createdAt: string }>,
): Array<{ version: string; publishState: string; reason: string | null }> {
  return versions
    .filter((version) => version.status === VERSION_ACTIVE)
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((version) => {
      const rows = requests.filter((request) => request.appVersionId === version.id);
      if (rows.some((request) => request.state === "pending")) return { version: version.version, publishState: "待审批", reason: null };
      if (rows.some((request) => request.state === "approved")) return { version: version.version, publishState: "已公开", reason: null };
      const rejected = rows.filter((request) => request.state === "rejected").sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (rejected) return { version: version.version, publishState: "已驳回", reason: rejected.reason };
      if (rows.some((request) => request.state === "withdrawn")) return { version: version.version, publishState: "已撤回", reason: null };
      return { version: version.version, publishState: "私有", reason: null };
    });
}

function selectableVersions(
  item: { app: AppRow; versions: VersionRow[]; visibility: VisibilityRow[] },
  userId: string,
  approved: ReadonlySet<string>,
): VersionRow[] | undefined {
  if (item.app.source === APP_SOURCE_USER) {
    if (item.app.ownerUserId === userId) return item.versions;
    const visible = item.versions.filter((version) => version.status === VERSION_ACTIVE && approved.has(version.id));
    return visible.length > 0 ? visible : undefined;
  }
  const visibility = visibilityFor(item.app, item.visibility, userId);
  if (visibility !== "private" && visibility !== "all" && visibility !== "user") return undefined;
  return item.versions;
}

/** 非所有者只能拿到已批准且仍上架的版本。已经装上的已批准版本在下架后仍可对账，和目录应用的下架一样。 */
function canReceivePackage(db: AppDatabase, userId: string, versionId: string): boolean {
  const row = db
    .select({ source: apps.source, ownerUserId: apps.ownerUserId, status: appVersions.status })
    .from(appVersions)
    .innerJoin(apps, eq(apps.id, appVersions.appId))
    .where(eq(appVersions.id, versionId))
    .get();
  if (!row) return false;
  if (row.source !== APP_SOURCE_USER || row.ownerUserId === userId) return true;
  const approved = db
    .select({ id: appPublishRequests.id })
    .from(appPublishRequests)
    .where(and(eq(appPublishRequests.appVersionId, versionId), eq(appPublishRequests.state, "approved")))
    .get();
  if (!approved) return false;
  if (row.status === VERSION_ACTIVE) return true;
  const machine = findLiveMachine(db, userId);
  if (!machine) return false;
  const install = db
    .select({ desired: appInstalls.desired })
    .from(appInstalls)
    .where(and(eq(appInstalls.machineId, machine.id), eq(appInstalls.appVersionId, versionId)))
    .get();
  return install?.desired === DESIRED_PRESENT;
}

function visibilityFor(app: AppRow, rows: VisibilityRow[], userId: string): "private" | "all" | "user" | "push" | "hidden" {
  if (app.source === APP_SOURCE_USER) return app.ownerUserId === userId ? "private" : "hidden";
  if (rows.some((row) => row.scope === "all")) return "all";
  if (rows.some((row) => row.scope === "user" && row.userId === userId)) return "user";
  if (rows.some((row) => row.scope === "push")) return "push";
  return "hidden";
}

function adminVisibility(rows: VisibilityRow[]): "all" | "user" | "push" | "hidden" {
  if (rows.some((row) => row.scope === "all")) return "all";
  if (rows.some((row) => row.scope === "user")) return "user";
  if (rows.some((row) => row.scope === "push")) return "push";
  return "hidden";
}

function requireCatalogApp(db: AppDatabase, appId: string): AppRow {
  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app || app.source === APP_SOURCE_USER) throw new CatalogRejected("找不到", 404);
  return app;
}

function requireExistingApp(db: AppDatabase, appId: string): AppRow {
  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) throw new CatalogRejected("找不到", 404);
  return app;
}

function requireMachine(db: AppDatabase, userId: string): { id: string } {
  const machine = findLiveMachine(db, userId);
  if (!machine) throw new CatalogRejected("没有可用的机器", 409);
  return machine;
}

function findLiveMachine(db: AppDatabase, userId: string): { id: string } | undefined {
  const machine = db
    .select({ id: machines.id, state: machines.state })
    .from(machines)
    .where(eq(machines.userId, userId))
    .get();
  if (!machine || machine.state === "deleted") return undefined;
  return { id: machine.id };
}

function findInstallForApp(db: AppDatabase, machineId: string, appId: string): InstallRow | undefined {
  const rows = db
    .select({
      id: appInstalls.id,
      machineId: appInstalls.machineId,
      appVersionId: appInstalls.appVersionId,
      forced: appInstalls.forced,
      desired: appInstalls.desired,
      state: appInstalls.state,
      configJson: appInstalls.configJson,
      error: appInstalls.error,
      updatedAt: appInstalls.updatedAt,
      installedByBotId: appInstalls.installedByBotId,
      installedByBotName: appInstalls.installedByBotName,
      resolvedVersion: appInstalls.resolvedVersion,
      appId: appVersions.appId,
    })
    .from(appInstalls)
    .innerJoin(appVersions, eq(appVersions.id, appInstalls.appVersionId))
    .where(and(eq(appInstalls.machineId, machineId), eq(appVersions.appId, appId)))
    .all();
  const row = rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!row) return undefined;
  return row;
}

interface OwnedInstall {
  install: InstallRow;
  app: AppRow;
  version: VersionRow;
}

function loadUserInstalls(db: AppDatabase, userId: string): OwnedInstall[] {
  const machine = db.select({ id: machines.id }).from(machines).where(eq(machines.userId, userId)).get();
  if (!machine) return [];
  return db
    .select({ install: appInstalls, app: apps, version: appVersions })
    .from(appInstalls)
    .innerJoin(appVersions, eq(appVersions.id, appInstalls.appVersionId))
    .innerJoin(apps, eq(apps.id, appVersions.appId))
    .where(eq(appInstalls.machineId, machine.id))
    .all();
}

function findOwnedInstall(db: AppDatabase, userId: string, installId: string): OwnedInstall | undefined {
  return loadUserInstalls(db, userId).find((item) => item.install.id === installId);
}

function toInstallView(item: OwnedInstall): InstallView {
  return {
    id: item.install.id,
    appId: item.app.id,
    name: item.app.name,
    versionId: item.version.id,
    version: item.install.resolvedVersion ?? item.version.version,
    machineId: item.install.machineId,
    forced: item.install.forced,
    desired: item.install.desired,
    state: item.install.state,
    config: toRedacted(item.install.configJson),
    error: item.install.error,
    installedByBot: item.install.installedByBotName,
  };
}

function mustInstallView(db: AppDatabase, installId: string): InstallView {
  const row = db
    .select({ install: appInstalls, app: apps, version: appVersions })
    .from(appInstalls)
    .innerJoin(appVersions, eq(appVersions.id, appInstalls.appVersionId))
    .innerJoin(apps, eq(apps.id, appVersions.appId))
    .where(eq(appInstalls.id, installId))
    .get();
  if (!row) throw new CatalogRejected("找不到", 404);
  return toInstallView(row);
}

function mustPush(db: AppDatabase, pushId: string): PushView {
  const push = db.select().from(appPushes).where(eq(appPushes.id, pushId)).get();
  if (!push) throw new CatalogRejected("找不到", 404);
  const targets = db.select().from(appPushTargets).where(eq(appPushTargets.pushId, pushId)).all();
  return {
    id: push.id,
    appVersionId: push.appVersionId,
    forced: push.forced,
    wake: push.wake,
    state: push.state,
    targets: targets.map((target) => ({
      userId: target.userId,
      machineId: target.machineId,
      installId: target.installId,
      state: target.state,
      error: target.error,
    })),
  };
}

function markInstall(deps: CatalogDeps, installId: string, state: string, error: string | null, desired?: string): void {
  deps.db.update(appInstalls).set({
    state,
    error,
    ...(desired !== undefined ? { desired } : {}),
    updatedAt: nowIso(deps),
  }).where(eq(appInstalls.id, installId)).run();
}

function markTarget(
  deps: CatalogDeps,
  pushId: string,
  userId: string,
  patch: { state: string; error?: string | null; machineId?: string | null; installId?: string | null },
): void {
  deps.db.update(appPushTargets).set({
    state: patch.state,
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.machineId !== undefined ? { machineId: patch.machineId } : {}),
    ...(patch.installId !== undefined ? { installId: patch.installId } : {}),
    updatedAt: nowIso(deps),
  }).where(and(eq(appPushTargets.pushId, pushId), eq(appPushTargets.userId, userId))).run();
}

function toRedacted(configJson: string): RedactedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson) as unknown;
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const output: RedactedConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!CONFIG_KEY.test(key)) continue;
    if (typeof value === "string") {
      output[key] = value;
      continue;
    }
    if (isRecord(value) && value.secret === true) {
      output[key] = redactedSecret(value);
    }
  }
  return output;
}

export function manifestConfigItems(manifestJson: string): ManifestConfigItem[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson) as unknown;
  } catch {
    return undefined;
  }
  return collectManifestConfig(configNode(parsed));
}

function readManifestConfig(manifestJson: string): {
  restricted: boolean;
  keys: Set<string>;
  secret: Set<string>;
  env: Map<string, string>;
  header: Map<string, string>;
} {
  const blank = {
    restricted: false,
    keys: new Set<string>(),
    secret: new Set<string>(),
    env: new Map<string, string>(),
    header: new Map<string, string>(),
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson) as unknown;
  } catch {
    return blank;
  }
  const declared = declaredConfig(configNode(parsed));
  if (!declared) return blank;
  return { restricted: true, ...declared };
}

function declaredConfig(config: unknown): {
  keys: Set<string>;
  secret: Set<string>;
  env: Map<string, string>;
  header: Map<string, string>;
} | undefined {
  const keys = new Set<string>();
  const secret = new Set<string>();
  const env = new Map<string, string>();
  const header = new Map<string, string>();
  if (Array.isArray(config)) {
    for (const item of config) {
      if (!isRecord(item) || typeof item.key !== "string" || !CONFIG_KEY.test(item.key)) continue;
      keys.add(item.key);
      if (item.secret === true) secret.add(item.key);
      if (typeof item.env === "string" && ENV_NAME.test(item.env)) env.set(item.key, item.env);
      if (typeof item.header === "string" && HEADER_NAME.test(item.header)) header.set(item.key, item.header);
    }
    return { keys, secret, env, header };
  }
  if (!isRecord(config)) return undefined;
  for (const [key, spec] of Object.entries(config)) {
    if (!CONFIG_KEY.test(key)) continue;
    keys.add(key);
    if (isRecord(spec) && spec.secret === true) secret.add(key);
  }
  return { keys, secret, env, header };
}

function configNode(parsed: unknown): unknown {
  if (!isRecord(parsed)) return undefined;
  if (parsed.config !== undefined) return parsed.config;
  const extensions = parsed.extensions;
  if (!isRecord(extensions)) return undefined;
  const via = extensions["ai.viate.bot"];
  if (!isRecord(via)) return undefined;
  return via.config;
}

function manifestDescription(manifestJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson) as unknown;
  } catch {
    return "";
  }
  if (!isRecord(parsed) || typeof parsed.description !== "string") return "";
  return parsed.description.slice(0, 500);
}

function configDescription(manifestJson: string, key: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson) as unknown;
  } catch {
    return "";
  }
  const node = configNode(parsed);
  if (!Array.isArray(node)) return "";
  for (const item of node) {
    if (!isRecord(item) || item.key !== key) continue;
    return typeof item.description === "string" ? item.description.slice(0, 200) : "";
  }
  return "";
}

function serversFromArchive(archivePath: string): AppSearchHit["mcpServers"] {
  try {
    const files = readTar(readFileSync(archivePath));
    const mcp = files.find((file) => file.path === "mcp.json");
    if (!mcp) return [];
    const parsed = JSON.parse(mcp.data.toString("utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return [];
    const servers: AppSearchHit["mcpServers"] = [];
    for (const [name, value] of Object.entries(parsed.mcpServers)) {
      if (!isRecord(value) || typeof value.type !== "string") continue;
      const server: AppSearchHit["mcpServers"][number] = { name, type: value.type };
      if (typeof value.command === "string") server.command = value.command;
      if (Array.isArray(value.args)) server.args = value.args.filter((arg): arg is string => typeof arg === "string");
      if (typeof value.url === "string") server.url = value.url;
      servers.push(server);
    }
    return servers;
  } catch {
    return [];
  }
}

function riskyToolsFromManifest(manifestJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const direct = parsed.riskyTools;
  const extensions = isRecord(parsed.extensions) ? parsed.extensions["ai.viate.bot"] : undefined;
  const nested = isRecord(extensions) ? extensions.riskyTools : undefined;
  const listed = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : [];
  return listed.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function parseConfigInput(value: unknown): ConfigInput {
  if (!isRecord(value)) throw new CatalogRejected("配置格式不对", 400);
  const entries = Object.entries(value);
  if (entries.length > 32) throw new CatalogRejected("配置项过多", 400);
  const output: ConfigInput = {};
  for (const [key, item] of entries) {
    if (!CONFIG_KEY.test(key)) throw new CatalogRejected("配置名不合法", 400);
    if (typeof item === "string") {
      if (item.length > 4096) throw new CatalogRejected("配置值过长", 400);
      output[key] = item;
      continue;
    }
    if (isRecord(item) && item.secret === true) {
      if (item.secretRef !== undefined) {
        if (item.prefix !== undefined && typeof item.prefix !== "string") throw new CatalogRejected("密钥前缀不合法", 400);
        output[key] = normalizeSecretRef({
          secretRef: typeof item.secretRef === "string" ? item.secretRef : "",
          ...(typeof item.prefix === "string" ? { prefix: item.prefix } : {}),
        });
        continue;
      }
      const raw = item.value;
      if (raw === undefined) {
        output[key] = { secret: true };
        continue;
      }
      if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) throw new CatalogRejected("配置值不能为空", 400);
      output[key] = { secret: true, value: raw };
      continue;
    }
    throw new CatalogRejected("配置格式不对", 400);
  }
  return output;
}

function parseVisibility(body: unknown): VisibilitySpec {
  const record = asRecord(body);
  if (record.scope === "all") return { scope: "all" };
  if (record.scope === "push") return { scope: "push" };
  if (record.scope === "user") {
    if (!Array.isArray(record.userIds)) throw new CatalogRejected("用户列表不合法", 400);
    const userIds: string[] = [];
    for (const id of record.userIds) {
      if (typeof id !== "string") throw new CatalogRejected("用户列表不合法", 400);
      userIds.push(id);
    }
    return { scope: "user", userIds };
  }
  throw new CatalogRejected("可见范围不合法", 400);
}

function normalizeUserIds(db: AppDatabase, userIds: readonly string[]): string[] {
  if (userIds.length === 0 || userIds.length > 500) throw new CatalogRejected("用户列表不合法", 400);
  const unique: string[] = [];
  for (const userId of userIds) {
    if (userId === VISIBILITY_SENTINEL || unique.includes(userId)) continue;
    if (!userRepository(db).findById(userId)) throw new CatalogRejected("用户不存在", 400);
    unique.push(userId);
  }
  if (unique.length === 0) throw new CatalogRejected("用户列表不合法", 400);
  return unique;
}

/** `user_id` 外键指向 users，且不能改表。`*` 先落成停用用户，可见性行才能写入。 */
function ensureSentinel(db: AppDatabase): void {
  if (userRepository(db).findById(VISIBILITY_SENTINEL)) return;
  try {
    userRepository(db).insert({
      id: VISIBILITY_SENTINEL,
      email: "catalog-sentinel@invalid",
      name: "catalog-sentinel",
      status: "disabled",
      isAdmin: false,
    });
  } catch {
    if (!userRepository(db).findById(VISIBILITY_SENTINEL)) throw new CatalogRejected("请求失败", 500);
  }
}

function assertAdmin(scope: AdminScope): void {
  if (scope.kind !== "admin" || scope.actorUserId.length === 0) throw new CatalogRejected("找不到", 404);
}

function assertName(value: string): string {
  if (value.length > 64 || !NAME_RE.test(value) || value.includes("..") || value.includes("--")) {
    throw new CatalogRejected("应用名不合法", 400);
  }
  return value;
}

function assertVersion(value: string): string {
  if (typeof value !== "string") throw new CatalogRejected("版本号不合法", 400);
  return value;
}

function storageVersion(version: string, sha256: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version) && !version.includes("..") ? version : sha256;
}

function assertSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new CatalogRejected("sha256 不合法", 400);
  return sha;
}

function assertArchive(value: string): string {
  if (value.length === 0 || value.length > 1024 || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new CatalogRejected("归档路径不合法", 400);
  }
  return value;
}

function assertManifest(value: string): string {
  if (value.length === 0 || value.length > 256_000) throw new CatalogRejected("清单不合法", 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new CatalogRejected("清单不合法", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CatalogRejected("清单不合法", 400);
  return value;
}

function assertSource(value: string | undefined): string {
  const source = value ?? APP_SOURCE_CATALOG;
  if (source === APP_SOURCE_USER || !SOURCE_RE.test(source)) throw new CatalogRejected("来源不合法", 400);
  return source;
}

function nowIso(deps: CatalogDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString();
}

function emit(
  deps: CatalogDeps,
  draft: { type: string; userId?: string; machineId?: string; attrs: Record<string, string | number | boolean> },
): void {
  eventRepository(deps.db).insert({
    id: ulid(),
    ts: nowIso(deps),
    type: draft.type,
    attrs: draft.attrs,
    ...(draft.userId !== undefined ? { userId: draft.userId } : {}),
    ...(draft.machineId !== undefined ? { machineId: draft.machineId } : {}),
  });
}

function audit(deps: CatalogDeps, actorUserId: string, action: string, target: string, attrs: Record<string, string | number | boolean>): void {
  auditRepository(deps.db).write(adminScope(actorUserId), action, target, attrs);
}

function sessionUser(request: FastifyRequest) {
  return authenticated.get(request)?.user;
}

function adminActor(request: FastifyRequest): AdminScope | undefined {
  const user = authenticated.get(request)?.user;
  if (!user?.isAdmin) return undefined;
  return adminScope(user.id);
}

function asRecord(body: unknown): Record<string, unknown> {
  if (isRecord(body)) return body;
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof CatalogRejected) return reply.code(error.statusCode).send({ error: error.message });
  return reply.code(500).send({ error: "请求失败" });
}
