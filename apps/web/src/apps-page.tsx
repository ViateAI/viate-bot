/**
 * 用户应用目录。不注册路由。
 * 密钥只出现在当次请求体里；响应中的密钥只能是 { secret: true }，页面不回显。
 * 页面不会直接请求用户填写的 MCP 地址。
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { api, ApiError, type Me } from "./api.js";

export const APP_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;
export const APP_NAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
export const APP_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const CONFIG_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export const appFieldClass =
  "min-h-11 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-200";
export const appButtonClass =
  "min-h-11 rounded bg-white px-3 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-200";
export const appGhostClass =
  "min-h-11 rounded border border-neutral-600 px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-200";
export const appDangerClass =
  "min-h-11 rounded border border-red-400/70 px-3 py-2 text-sm text-red-100 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-200";

/** 与 catalog.ts registerCatalogRoutes 的路径和请求体一致。 */
export const appApi = {
  catalog: "/api/apps",
  installs: "/api/apps/installs",
  install: (name: string) => `/api/apps/${encodeURIComponent(name)}/install`,
  uninstall: (installId: string) => `/api/apps/installs/${encodeURIComponent(installId)}/uninstall`,
  config: (installId: string) => `/api/apps/installs/${encodeURIComponent(installId)}/config`,
  privateUpload: "/api/apps/private/upload",
  privateCreate: "/api/apps/private",
  adminApps: "/api/admin/apps",
  visibility: (appId: string) => `/api/admin/apps/${encodeURIComponent(appId)}/visibility`,
  recommend: (appId: string, versionId: string) =>
    `/api/admin/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/recommend`,
  retire: (appId: string, versionId: string) =>
    `/api/admin/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/retire`,
  push: (appId: string) => `/api/admin/apps/${encodeURIComponent(appId)}/push`,
  pushOne: (pushId: string) => `/api/admin/apps/pushes/${encodeURIComponent(pushId)}`,
  adminUpload: "/api/admin/apps/upload",
  adminIngest: "/api/admin/apps/ingest",
} as const;

export type RedactedConfig = Record<string, string | { secret: true }>;
export type ConfigInput = Record<string, string | { secret: true; value?: string }>;

export interface UserCatalogEntry {
  id: string;
  name: string;
  source: string;
  visibility: "private" | "all" | "user";
  version: { id: string; version: string; recommended: boolean };
  publisher?: string | null;
  privateVersions?: Array<{ version: string; publishState: string; reason: string | null }>;
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
  installedByBot?: string | null;
}

export interface AdminVersion {
  id: string;
  version: string;
  status: string;
  recommended: boolean;
  sha256: string;
}

export interface AdminCatalogEntry {
  id: string;
  name: string;
  source: string;
  ownerUserId?: string | null;
  ownerName?: string | null;
  visibility: "all" | "user" | "push" | "hidden";
  userIds: string[];
  versions: AdminVersion[];
}

export interface PushTarget {
  userId: string;
  machineId: string | null;
  installId: string | null;
  state: string;
  error: string | null;
}

export interface PushView {
  id: string;
  appVersionId: string;
  forced: boolean;
  wake: boolean;
  state: string;
  targets: PushTarget[];
}

export interface InstallRequest {
  version?: string;
  config?: ConfigInput;
}

export interface ConfigUpdateRequest {
  config: ConfigInput;
}

export type VisibilityRequest = { scope: "all" } | { scope: "push" } | { scope: "user"; userIds: string[] };

export interface PushRequest {
  versionId: string;
  userIds: string[];
  forced?: boolean;
  wake?: boolean;
}

export interface PackagePublishResult {
  appId: string;
  versionId: string;
  name: string;
  version: string;
  warnings: string[];
}

export interface PrivateMcpRequest {
  name: string;
  version: string;
  mcpUrl: string;
}

export type AdminIngestRequest =
  | { kind: "git"; gitUrl: string; version?: string }
  | { kind: "npm"; name: string; version: string; pluginVersion?: string };

export interface UserAppRow {
  id: string;
  name: string;
  source: string;
  visibility: "private" | "all" | "user" | "push";
  inCatalog: boolean;
  version: { id: string; version: string; recommended: boolean } | null;
  install: InstallView | null;
  publisher: string | null;
  privateVersions: Array<{ version: string; publishState: string; reason: string | null }>;
}

export interface ConfigDraft {
  id: string;
  key: string;
  secret: boolean;
  value: string;
  existingSecret: boolean;
}

type CatalogFilter = "all" | "catalog" | "private" | "installed";

interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  run: () => void;
}

export function validAppName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && APP_NAME_RE.test(name) && !name.includes("--") && !name.includes("..");
}

/** catalog assertStoredVersion：除 VERSION_RE 外，存储版本不能含 `+` 或 `..`。安装请求仍用 APP_VERSION_RE。 */
export function validStoredVersion(version: string): boolean {
  return APP_VERSION_RE.test(version) && !version.includes("+") && !version.includes("..");
}

export function archiveKind(name: string): "archive" | "mcpb" | "zip" | "tgz" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tar.zst") || lower.endsWith(".tzst")) return "archive";
  if (lower.endsWith(".mcpb")) return "mcpb";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tgz";
  if (lower.endsWith(".zip")) return "zip";
  return null;
}

export function archiveRejection(file: File): string | null {
  if (file.size <= 0) return "文件是空的";
  if (file.size > APP_ARCHIVE_MAX_BYTES) return "文件超过 200MB";
  if (!archiveKind(file.name)) return "只接受 .tar.zst、.tzst、.mcpb、.zip、.tgz 或 .tar.gz";
  return null;
}

export function archiveUploadUrl(path: string, file: File, version: string): string {
  const params = new URLSearchParams();
  params.set("filename", file.name);
  const kind = archiveKind(file.name);
  if (kind) params.set("kind", kind);
  if (version) params.set("version", version);
  return `${path}?${params.toString()}`;
}

/** 与 archive.ts 的 streamable-http 校验一致。服务端仍是准。页面不发起该请求。 */
export function validateMcpUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "请输入完整的 http 或 https 地址";
  }
  if (url.username || url.password) return "地址不能包含用户名或密码";
  if (url.hash) return "地址不能包含片段";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "只接受 http 或 https";
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "::1" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol === "http:" && !loopback) return "非本机地址必须使用 https";
  return null;
}

export function appErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "请求失败";
}

export function appErrorText(error: string | null): string | null {
  if (!error) return null;
  switch (error) {
    case "config":
      return "配置没有通过";
    case "secret_unreadable":
      return "密钥无法读取";
    case "install_failed":
      return "安装失败";
    case "uninstall_failed":
      return "卸载失败";
    case "retired":
      return "版本已下架";
    case "user_disabled":
      return "用户已停用";
    case "wake_failed":
      return "唤醒机器失败";
    case "no_machine":
      return "没有可用的机器";
    default:
      return /^[a-z0-9_.:-]{1,80}$/i.test(error) ? error : "失败";
  }
}

export function installStateText(install: InstallView): string {
  if (install.desired === "absent" && install.state === "failed") return "卸载失败";
  switch (install.state) {
    case "installing":
      return "安装中";
    case "installed":
      return "已安装";
    case "failed":
      return "安装失败";
    case "removing":
      return "正在卸载";
    case "removed":
      return "已卸载";
    default:
      return "状态未知";
  }
}

export function visibilityText(visibility: string): string {
  switch (visibility) {
    case "all":
      return "全员可见";
    case "user":
      return "指定用户";
    case "push":
      return "仅推送";
    case "private":
      return "私有";
    case "hidden":
      return "未公开";
    default:
      return "目录外";
  }
}

export function pushStateText(state: string): string {
  switch (state) {
    case "pending":
      return "等待";
    case "running":
      return "进行中";
    case "done":
      return "完成";
    case "failed":
      return "有失败";
    default:
      return "状态未知";
  }
}

export function pushTargetText(state: string): string {
  switch (state) {
    case "pending":
      return "等待";
    case "installing":
      return "安装中";
    case "installed":
      return "已安装";
    case "failed":
      return "失败";
    default:
      return "状态未知";
  }
}

export function pushInFlight(push: PushView): boolean {
  if (push.state === "pending" || push.state === "running") return true;
  return push.targets.some((target) => target.state === "pending" || target.state === "installing");
}

export function formatAppBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAppTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function joinUserApps(catalog: UserCatalogEntry[], installs: InstallView[]): UserAppRow[] {
  const byApp = new Map<string, InstallView[]>();
  for (const install of installs) {
    const list = byApp.get(install.appId);
    if (list) list.push(install);
    else byApp.set(install.appId, [install]);
  }
  const rows: UserAppRow[] = [];
  const seen = new Set<string>();
  for (const app of catalog) {
    seen.add(app.id);
    rows.push({
      id: app.id,
      name: app.name,
      source: app.source,
      visibility: app.visibility,
      inCatalog: true,
      version: app.version,
      install: currentInstall(byApp.get(app.id) ?? []),
      publisher: app.publisher ?? null,
      privateVersions: app.privateVersions ?? [],
    });
  }
  for (const [appId, list] of byApp) {
    if (seen.has(appId)) continue;
    const install = currentInstall(list);
    if (!install) continue;
    rows.push({
      id: appId,
      name: install.name,
      source: "unknown",
      visibility: "push",
      inCatalog: false,
      version: null,
      install,
      publisher: null,
      privateVersions: [],
    });
  }
  rows.sort((left, right) => left.name.localeCompare(right.name, "en"));
  return rows;
}

function currentInstall(list: InstallView[]): InstallView | null {
  const active = list.filter((install) => install.state !== "removed");
  return active.find((install) => install.desired === "present") ?? active[0] ?? null;
}

export function draftsFromConfig(config: RedactedConfig): ConfigDraft[] {
  return Object.entries(config).map(([key, value]) => {
    if (typeof value === "string") return { id: draftId(), key, secret: false, value, existingSecret: false };
    return { id: draftId(), key, secret: true, value: "", existingSecret: true };
  });
}

export function buildConfigInput(rows: ConfigDraft[]): { ok: true; config: ConfigInput } | { ok: false; error: string } {
  if (rows.length > 32) return { ok: false, error: "配置项过多" };
  const config: ConfigInput = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!CONFIG_KEY_RE.test(key)) return { ok: false, error: "配置名须为大写字母、数字或下划线，例如 API_TOKEN" };
    if (seen.has(key)) return { ok: false, error: `配置名重复：${key}` };
    seen.add(key);
    if (row.secret) {
      const value = row.value.trim();
      if (value.length > 4096) return { ok: false, error: "配置值过长" };
      if (value) config[key] = { secret: true, value };
      else if (row.existingSecret) config[key] = { secret: true };
      else return { ok: false, error: `请填写密钥 ${key}` };
      continue;
    }
    const value = row.value.trim();
    if (value.length > 4096) return { ok: false, error: "配置值过长" };
    if (value) config[key] = value;
  }
  return { ok: true, config };
}

function draftId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function readPublishResult(value: PackagePublishResult): PackagePublishResult {
  const warnings = Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === "string") : [];
  return {
    appId: typeof value.appId === "string" ? value.appId : "",
    versionId: typeof value.versionId === "string" ? value.versionId : "",
    name: typeof value.name === "string" && value.name ? value.name : "应用",
    version: typeof value.version === "string" ? value.version : "",
    warnings,
  };
}

export function postArchive<T>(
  url: string,
  file: File,
  csrf: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError("上传已取消", 0));
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: ApiError, value?: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("accept", "application/json");
    if (csrf) xhr.setRequestHeader("x-vb-csrf", csrf);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))));
    };
    xhr.onerror = () => finish(new ApiError("上传失败", 0));
    xhr.onabort = () => finish(new ApiError("上传已取消", 0));
    xhr.onloadend = () => {
      if (xhr.status === 0) {
        finish(new ApiError(signal?.aborted ? "上传已取消" : "上传失败", 0));
        return;
      }
      if (xhr.status === 401) {
        const returnTo = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
        finish(new ApiError("未登录", 401));
        return;
      }
      let body: { error?: string } = {};
      if (xhr.responseText) {
        try {
          body = JSON.parse(xhr.responseText) as { error?: string };
        } catch {
          finish(new ApiError("请求失败", xhr.status));
          return;
        }
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(new ApiError(typeof body.error === "string" ? body.error : "请求失败", xhr.status));
        return;
      }
      finish(undefined, body as T);
    };
    xhr.send(file);
  });
}

/**
 * 响应到达后不再接受进度。成功提示在刷新列表之前写上。
 * 列表刷新可以一直不返回（例如另有安装中的应用在轮询），不能把进度留在 100%。
 */
export async function consumePrivateUpload(input: {
  upload: (onProgress: (percent: number) => void) => Promise<PackagePublishResult>;
  refresh: (appId: string) => Promise<void>;
  setPercent: (percent: number | null) => void;
  setMessage: (message: string) => void;
  setWarnings: (warnings: string[]) => void;
}): Promise<void> {
  let settled = false;
  try {
    const published = readPublishResult(await input.upload((percent) => {
      if (!settled) input.setPercent(percent);
    }));
    settled = true;
    input.setPercent(null);
    input.setWarnings(published.warnings);
    input.setMessage(`已添加私有应用 ${published.name}`);
    if (published.appId) await input.refresh(published.appId);
  } catch (error) {
    settled = true;
    input.setPercent(null);
    throw error;
  }
}

export function AppConfirmDialog({
  title,
  body,
  confirmLabel,
  busy = false,
  tone = "danger",
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  tone?: "danger" | "default";
  onConfirm: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    const onCancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="m-auto w-[min(24rem,calc(100%-2rem))] max-h-[calc(100dvh-2rem)] overflow-auto rounded-lg border border-neutral-700 bg-neutral-950 p-5 text-neutral-100 backdrop:bg-black/70"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
      <p id={bodyId} className="mt-2 text-sm text-neutral-300">{body}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button className={appGhostClass} type="button" onClick={onClose} disabled={busy}>取消</button>
        <button className={tone === "default" ? appButtonClass : appDangerClass} type="button" onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}

export function ArchivePicker({
  inputId,
  testId,
  file,
  disabled,
  onFile,
}: {
  inputId: string;
  testId: string;
  file: File | null;
  disabled: boolean;
  onFile: (file: File | null, error: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  function take(list: FileList | null) {
    const chosen = list?.[0];
    if (!chosen) return;
    if ((list?.length ?? 0) > 1) {
      onFile(null, "一次只能上传一个文件");
      return;
    }
    const rejection = archiveRejection(chosen);
    if (rejection) {
      onFile(null, rejection);
      return;
    }
    onFile(chosen, "");
  }
  return (
    <div
      className={`rounded border border-dashed px-4 py-4 ${dragOver ? "border-neutral-200" : "border-neutral-700"}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (!disabled) take(event.dataTransfer.files);
      }}
    >
      <p className="text-sm text-neutral-300">将一个包拖到这里，或</p>
      <label
        htmlFor={inputId}
        className="mt-3 inline-flex min-h-11 cursor-pointer items-center rounded bg-white px-3 py-2 text-sm font-medium text-neutral-950 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-neutral-200"
      >
        选择文件
        <input
          ref={inputRef}
          id={inputId}
          data-testid={testId}
          className="sr-only"
          type="file"
          accept=".tar.zst,.tzst,.mcpb,.zip,.tgz,.gz"
          disabled={disabled}
          onChange={(event) => take(event.target.files)}
        />
      </label>
      <p className="mt-3 text-sm text-neutral-400">支持 .tar.zst、.tzst、.mcpb、.zip、.tgz、.tar.gz，最大 200MB。一次一个文件。</p>
      {file ? (
        <p className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="break-all">{file.name} · {formatAppBytes(file.size)}</span>
          <button
            className="min-h-11 text-neutral-300 underline-offset-2 hover:underline"
            type="button"
            disabled={disabled}
            onClick={() => {
              if (inputRef.current) inputRef.current.value = "";
              onFile(null, "");
            }}
          >
            移除
          </button>
        </p>
      ) : null}
    </div>
  );
}

function ErrorText({ children }: { children: string }) {
  return <p role="alert" className="break-words text-sm text-red-300">出错：{children}</p>;
}

function StatusText({ children }: { children: string }) {
  return <p role="status" className="text-sm text-emerald-300">{children}</p>;
}

function chipClass(on: boolean): string {
  return `min-h-11 rounded-full border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-200 ${on ? "border-neutral-200 text-neutral-50" : "border-neutral-700 text-neutral-300"}`;
}

export function AppsPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me") });
  const catalog = useQuery({
    queryKey: ["apps"],
    queryFn: async () => {
      const body = await api<{ apps: UserCatalogEntry[] }>(appApi.catalog);
      return { apps: Array.isArray(body.apps) ? body.apps : [] };
    },
  });
  const installs = useQuery({
    queryKey: ["app-installs"],
    queryFn: async () => {
      const body = await api<{ installs: InstallView[] }>(appApi.installs);
      return { installs: Array.isArray(body.installs) ? body.installs : [] };
    },
    refetchInterval: (query) => {
      const rows = query.state.data?.installs ?? [];
      return rows.some((install) => install.state === "installing" || install.state === "removing") ? 2000 : false;
    },
  });
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [privateOpen, setPrivateOpen] = useState(false);
  const rows = joinUserApps(catalog.data?.apps ?? [], installs.data?.installs ?? []);
  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => matchesFilter(row, filter, needle));
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  async function reload() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["apps"] }),
      queryClient.invalidateQueries({ queryKey: ["app-installs"] }),
    ]);
  }

  function closeDetail() {
    const current = selectedId;
    setSelectedId(null);
    if (!current) return;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-app-id="${CSS.escape(current)}"]`)?.focus();
    });
  }

  if (catalog.isPending || installs.isPending) return <p className="px-6 py-10 text-neutral-400">正在加载应用…</p>;
  if (catalog.isError || installs.isError) {
    return (
      <section className="mx-auto grid max-w-3xl gap-3 px-6 py-10">
        <h1 className="text-2xl font-semibold">应用</h1>
        <ErrorText>{appErrorMessage(catalog.error ?? installs.error)}</ErrorText>
        <button className={appGhostClass} data-testid="apps-retry" type="button" onClick={() => void reload()}>重试</button>
      </section>
    );
  }

  return (
    <section className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">应用</h1>
          <p className="mt-1 text-sm text-neutral-400">安装到你自己的机器。私有应用只有你能看见。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={appGhostClass} data-testid="app-private-open" type="button" aria-expanded={privateOpen} onClick={() => setPrivateOpen((open) => !open)}>
            {privateOpen ? "收起" : "添加私有应用"}
          </button>
          <button className={appGhostClass} data-testid="apps-refresh" type="button" onClick={() => void reload()}>刷新</button>
        </div>
      </div>
      {me.data && !me.data.provisioned ? (
        <p data-testid="not-provisioned" className="rounded border border-neutral-800 px-4 py-3 text-sm text-neutral-300">尚未开通，请联系管理员。开通前不能安装。</p>
      ) : null}
      {privateOpen ? (
        <PrivatePanel
          csrf={me.data?.csrf ?? ""}
          onCreated={async (appId) => {
            setFilter("private");
            setQuery("");
            setSelectedId(appId);
            await reload();
          }}
        />
      ) : null}
      <form role="search" className="grid gap-3" onSubmit={(event) => event.preventDefault()}>
        <label className="grid gap-1 text-sm" htmlFor="apps-search">
          搜索应用
          <input
            id="apps-search"
            data-testid="apps-search"
            className={appFieldClass}
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="筛选应用" className="flex flex-wrap gap-2">
            {([
              ["all", "全部"],
              ["catalog", "目录"],
              ["private", "我的"],
              ["installed", "已安装"],
            ] as const).map(([id, label]) => (
              <button key={id} className={chipClass(filter === id)} data-testid={`apps-filter-${id}`} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
          {query ? (
            <button className={appGhostClass} type="button" onClick={() => setQuery("")}>清除搜索</button>
          ) : null}
          <p className="text-sm text-neutral-400">共 {visible.length} 个</p>
        </div>
      </form>
      <div className="lg:grid lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] lg:items-start lg:gap-6">
        <div className={selected ? "max-lg:hidden" : ""}>
          {visible.length === 0 ? (
            <div className="rounded border border-neutral-800 px-4 py-8 text-sm text-neutral-300">
              <p>{rows.length === 0 ? "目录还是空的。" : "没有匹配的应用。"}</p>
              {rows.length === 0 ? (
                <button className={`${appButtonClass} mt-4`} type="button" onClick={() => setPrivateOpen(true)}>添加私有应用</button>
              ) : (
                <button className={`${appGhostClass} mt-4`} type="button" onClick={() => { setFilter("all"); setQuery(""); }}>清除筛选</button>
              )}
            </div>
          ) : (
            <ul className="grid gap-2 lg:max-h-[calc(100dvh-9rem)] lg:overflow-auto" aria-label="应用列表">
              {visible.map((row) => (
                <li key={row.id}>
                  <button
                    className={`min-h-11 w-full rounded border px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-200 ${selectedId === row.id ? "border-neutral-200" : "border-neutral-800"}`}
                    type="button"
                    data-testid="app-card"
                    data-app-id={row.id}
                    aria-pressed={selectedId === row.id}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <span className="block break-all font-medium">{row.name}</span>
                    <span className="mt-1 block text-sm text-neutral-400">{cardSubtitle(row)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={!selected ? "max-lg:hidden" : "min-w-0"}>
          {selected ? (
            <AppDetail
              key={selected.id}
              row={selected}
              provisioned={!me.data || me.data.provisioned}
              onClose={closeDetail}
              onChanged={reload}
            />
          ) : selectedId ? (
            <p className="text-sm text-neutral-400">正在刷新…</p>
          ) : (
            <p className="hidden text-sm text-neutral-400 lg:block">请选择一个应用。</p>
          )}
        </div>
      </div>
    </section>
  );
}

function matchesFilter(row: UserAppRow, filter: CatalogFilter, needle: string): boolean {
  if (needle && !row.name.toLowerCase().includes(needle)) return false;
  if (filter === "catalog") return row.inCatalog && row.visibility !== "private";
  if (filter === "private") return row.visibility === "private";
  if (filter === "installed") return row.install !== null && row.install.desired === "present" && row.install.state !== "removed";
  return true;
}

function cardSubtitle(row: UserAppRow): string {
  const parts = [row.publisher ? `由用户〈${row.publisher}〉发布` : row.inCatalog ? visibilityText(row.visibility) : "目录外"];
  if (row.version) parts.push(row.version.recommended ? `${row.version.version} 推荐` : row.version.version);
  if (row.install) {
    parts.push(installStateText(row.install));
    if (row.install.installedByBot) parts.push(`由 bot〈${row.install.installedByBot}〉安装`);
    if (row.install.forced) parts.push("强制安装");
  }
  return parts.join(" · ");
}

function PublishStatus({ name, versions, onChanged }: {
  name: string;
  versions: UserAppRow["privateVersions"];
  onChanged: () => Promise<void>;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  async function submit(version: string) {
    const note = (notes[version] ?? "").trim();
    if (!note) {
      setError("说明不能为空");
      return;
    }
    setBusy(version);
    setError("");
    try {
      await api(`/api/apps/${encodeURIComponent(name)}/publish`, { method: "POST", body: JSON.stringify({ version, note }) });
      setNotes((current) => ({ ...current, [version]: "" }));
      await onChanged();
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="grid gap-3" data-testid="publish-status">
      <h3 className="font-medium">发布状态</h3>
      {versions.map((item) => (
        <div key={item.version} className="grid gap-2 text-sm">
          <p className="whitespace-pre-wrap break-all">{item.version} · {item.publishState}{item.reason ? ` · ${item.reason}` : ""}</p>
          {item.publishState === "私有" || item.publishState === "已撤回" ? (
            <label className="grid gap-1">
              申请说明
              <input className={appFieldClass} value={notes[item.version] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.version]: event.target.value }))} />
              <button className={appButtonClass} type="button" data-testid={`publish-request-${item.version}`} disabled={busy !== null} onClick={() => void submit(item.version)}>
                {busy === item.version ? "正在提交…" : "申请公开"}
              </button>
            </label>
          ) : null}
        </div>
      ))}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </section>
  );
}

export function PrivatePanel({ csrf, onCreated }: { csrf: string; onCreated: (appId: string) => Promise<void> }) {
  const [mode, setMode] = useState<"file" | "mcp">("file");
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState("");
  const [name, setName] = useState("");
  const [mcpVersion, setMcpVersion] = useState("1.0.0");
  const [mcpUrl, setMcpUrl] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [percent, setPercent] = useState<number | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abortRef.current?.abort();
    };
  }, []);

  async function submitFile() {
    if (!file) {
      setError("请选择文件");
      return;
    }
    const rejection = archiveRejection(file);
    if (rejection) {
      setError(rejection);
      return;
    }
    const typed = version.trim();
    if (typed && !validStoredVersion(typed)) {
      setError("版本号不合法");
      return;
    }
    if (!csrf) {
      setError("缺少登录校验，请刷新页面");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPercent(0);
    try {
      await consumePrivateUpload({
        upload: (onProgress) => postArchive<PackagePublishResult>(archiveUploadUrl(appApi.privateUpload, file, typed), file, csrf, onProgress, controller.signal),
        refresh: async (appId) => {
          if (!alive.current) return;
          setFile(null);
          await onCreated(appId);
        },
        setPercent: (next) => {
          if (alive.current) setPercent(next);
        },
        setMessage: (next) => {
          if (!alive.current) return;
          setFile(null);
          setMessage(next);
        },
        setWarnings: (next) => {
          if (alive.current) setWarnings(next);
        },
      });
    } catch (caught) {
      if (!alive.current || controller.signal.aborted) return;
      setError(appErrorMessage(caught));
    } finally {
      if (alive.current) {
        setPercent(null);
        abortRef.current = null;
      }
    }
  }

  async function submitMcp() {
    const trimmedName = name.trim();
    const trimmedVersion = mcpVersion.trim();
    const trimmedUrl = mcpUrl.trim();
    if (!validAppName(trimmedName)) {
      setError("应用名须为小写字母、数字、点或短横线，不能以点或短横线开头或结尾");
      return;
    }
    if (!validStoredVersion(trimmedVersion)) {
      setError("版本号不合法");
      return;
    }
    const urlError = validateMcpUrl(trimmedUrl);
    if (urlError) {
      setError(urlError);
      return;
    }
    setMcpBusy(true);
    try {
      const payload: PrivateMcpRequest = { name: trimmedName, version: trimmedVersion, mcpUrl: trimmedUrl };
      const published = readPublishResult(await api<PackagePublishResult>(appApi.privateCreate, { method: "POST", body: JSON.stringify(payload) }));
      setMcpUrl("");
      setWarnings(published.warnings);
      setMessage(`已添加私有应用 ${published.name}`);
      if (published.appId) await onCreated(published.appId);
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setMcpBusy(false);
    }
  }

  const uploading = percent !== null || mcpBusy;
  return (
    <section aria-label="添加私有应用" className="grid gap-3 rounded border border-neutral-800 p-4">
      <h2 className="text-lg font-semibold">添加私有应用</h2>
      <p className="text-sm text-neutral-400">只有你能在目录里看到。包会交给控制面校验，不会在这个页面里执行。</p>
      <div role="group" aria-label="添加方式" className="flex flex-wrap gap-2">
        <button className={chipClass(mode === "file")} type="button" aria-pressed={mode === "file"} onClick={() => setMode("file")}>上传包</button>
        <button className={chipClass(mode === "mcp")} type="button" aria-pressed={mode === "mcp"} onClick={() => setMode("mcp")}>MCP 地址</button>
      </div>
      {mode === "file" ? (
        <>
          <ArchivePicker inputId="private-archive" testId="app-private-file" file={file} disabled={uploading} onFile={(next, failure) => { setFile(next); setError(failure); setMessage(""); }} />
          <label className="grid gap-1 text-sm">
            版本（清单里没有时必填）
            <input className={appFieldClass} value={version} spellCheck={false} onChange={(event) => setVersion(event.target.value)} />
          </label>
        </>
      ) : (
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            应用名
            <input data-testid="app-private-name" className={appFieldClass} value={name} spellCheck={false} autoCapitalize="none" onChange={(event) => setName(event.target.value)} required />
          </label>
          <label className="grid gap-1 text-sm">
            版本
            <input className={appFieldClass} value={mcpVersion} spellCheck={false} onChange={(event) => setMcpVersion(event.target.value)} required />
          </label>
          <label className="grid gap-1 text-sm">
            MCP 地址
            <input data-testid="app-private-url" className={appFieldClass} type="url" inputMode="url" spellCheck={false} value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} />
          </label>
          <p className="text-sm text-neutral-400">地址只提交给控制面，由你的机器拨号。这个页面不会直接请求它。</p>
        </div>
      )}
      {uploading ? <Progress percent={percent ?? 0} /> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <StatusText>{message}</StatusText> : null}
      <WarningList warnings={warnings} />
      <div className="flex flex-wrap gap-2">
        <button
          className={appButtonClass}
          data-testid="app-private-submit"
          type="button"
          disabled={uploading}
          onClick={() => {
            setError("");
            setMessage("");
            if (mode === "file") void submitFile();
            else void submitMcp();
          }}
        >
          {mcpBusy ? "正在添加…" : "添加"}
        </button>
        {uploading && mode === "file" ? (
          <button className={appGhostClass} type="button" onClick={() => abortRef.current?.abort()}>取消上传</button>
        ) : null}
      </div>
    </section>
  );
}

function Progress({ percent }: { percent: number }) {
  return (
    <div>
      <div className="h-2 overflow-hidden rounded bg-neutral-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="上传进度">
        <div className="h-full bg-neutral-200" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1 text-sm text-neutral-400">已上传 {percent}%</p>
    </div>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="grid gap-1 text-sm text-amber-100">
      {warnings.map((warning, index) => (
        <li key={`${index}-${warning}`}>包检查：{warning}</li>
      ))}
    </ul>
  );
}

function AppDetail({
  row,
  provisioned,
  onClose,
  onChanged,
}: {
  row: UserAppRow;
  provisioned: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [versionText, setVersionText] = useState("");
  const [drafts, setDrafts] = useState<ConfigDraft[]>(() => draftsFromConfig(row.install?.config ?? {}));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<"install" | "config" | "uninstall" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  useEffect(() => {
    if (window.matchMedia("(max-width: 1023px)").matches) headingRef.current?.focus();
  }, []);

  const install = row.install;
  const forced = install?.forced === true;
  const preferred = row.version;
  const versionHint = preferred
    ? preferred.recommended
      ? `留空则安装推荐版本 ${preferred.version}。升级会保留 data 目录。`
      : `留空则安装最新版本 ${preferred.version}。升级会保留 data 目录。`
    : "";

  function versionToInstall(): string {
    const typed = versionText.trim();
    if (typed) return typed;
    if (forced && install && install.state !== "removed") return install.version;
    if (!forced && install && preferred && install.version !== preferred.version && install.state !== "removed") return preferred.version;
    return "";
  }

  function updateDraft(id: string, patch: Partial<Pick<ConfigDraft, "key" | "secret" | "value">>) {
    setDirty(true);
    setDrafts((current) => current.map((rowDraft) => {
      if (rowDraft.id !== id) return rowDraft;
      return {
        ...rowDraft,
        ...(patch.key !== undefined ? { key: patch.key } : {}),
        ...(patch.secret !== undefined ? { secret: patch.secret } : {}),
        ...(patch.value !== undefined ? { value: patch.value } : {}),
      };
    }));
  }

  async function runInstall() {
    const requested = versionToInstall();
    if (requested && !APP_VERSION_RE.test(requested)) {
      setError("版本号不合法");
      return;
    }
    let config: ConfigInput | undefined;
    if (dirty) {
      const built = buildConfigInput(drafts);
      if (!built.ok) {
        setError(built.error);
        return;
      }
      if (Object.keys(built.config).length > 0) config = built.config;
    }
    const payload: InstallRequest = {
      ...(requested ? { version: requested } : {}),
      ...(config ? { config } : {}),
    };
    setPending("install");
    setError("");
    setMessage("");
    try {
      await api<{ install: InstallView }>(appApi.install(row.name), { method: "POST", body: JSON.stringify(payload) });
      setDrafts((current) => current.map((item) => (item.secret ? { ...item, value: "", existingSecret: true } : item)));
      setDirty(false);
      setMessage("安装已完成");
      await onChanged();
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  async function runConfig(config: ConfigInput) {
    if (!install) return;
    setPending("config");
    setError("");
    setMessage("");
    try {
      const payload: ConfigUpdateRequest = { config };
      await api<{ install: InstallView }>(appApi.config(install.id), { method: "PUT", body: JSON.stringify(payload) });
      setDrafts((current) => current.map((item) => (item.secret ? { ...item, value: "", existingSecret: true } : item)));
      setDirty(false);
      setMessage("配置已保存");
      await onChanged();
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  function askSaveConfig() {
    if (!install) return;
    const built = buildConfigInput(drafts);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const hadConfig = Object.keys(install.config).length > 0;
    if (hadConfig && Object.keys(built.config).length === 0) {
      setConfirm({
        title: "清空配置",
        body: "这将清掉已保存的配置，包括密钥。",
        confirmLabel: "清空并保存",
        run: () => { setConfirm(null); void runConfig(built.config); },
      });
      return;
    }
    void runConfig(built.config);
  }

  async function runUninstall() {
    if (!install) return;
    setPending("uninstall");
    setError("");
    setMessage("");
    try {
      await api<{ install: InstallView }>(appApi.uninstall(install.id), { method: "POST", body: "{}" });
      setConfirm(null);
      setMessage("已卸载");
      await onChanged();
    } catch (caught) {
      setConfirm(null);
      setError(appErrorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  const requested = versionToInstall();
  const sameInstalled = Boolean(install && install.state === "installed" && install.desired === "present" && (requested === "" || requested === install.version));
  const showInstall = row.inCatalog && !sameInstalled;
  const installLabel = install && install.state === "failed" && install.desired === "present" && (requested === "" || requested === install.version)
    ? "重试安装"
    : requested && install && requested !== install.version
      ? `安装 ${requested}`
      : "安装";
  const installReason = !provisioned
    ? "尚未开通，请联系管理员"
    : forced && requested !== "" && install && requested !== install.version
      ? "管理员推送的应用不能更换版本"
      : "";

  return (
    <article className="grid gap-4 lg:max-h-[calc(100dvh-9rem)] lg:overflow-auto" aria-label="应用详情" data-testid="app-detail">
      <div>
        <button className={`${appGhostClass} mb-3 lg:hidden`} type="button" onClick={onClose}>返回</button>
        <h2 ref={headingRef} tabIndex={-1} className="break-all text-xl font-semibold outline-none">{row.name}</h2>
        <p className="mt-1 text-sm text-neutral-400">{cardSubtitle(row)}</p>
      </div>
      {!row.inCatalog ? (
        <p className="text-sm text-neutral-300">这个应用不在你的目录里，通常是管理员推送，或版本已经下架。</p>
      ) : null}
      {install ? (
        <div className="rounded border border-neutral-800 p-3 text-sm">
          <p>{installStateText(install)} · 版本 {install.version}</p>
          {install.installedByBot ? <p data-testid="installed-by-bot">由 bot〈{install.installedByBot}〉安装</p> : null}
          {install.forced ? <p id="forced-install-note" className="mt-1 text-neutral-300">管理员强制安装，不能卸载。</p> : null}
          {appErrorText(install.error) ? <p className="mt-1 text-red-300">失败原因：{appErrorText(install.error)}</p> : null}
        </div>
      ) : null}
      {row.privateVersions.length > 0 ? <PublishStatus name={row.name} versions={row.privateVersions} onChanged={onChanged} /> : null}
      {row.inCatalog ? (
        <label className="grid gap-1 text-sm">
          指定版本
          <input
            className={appFieldClass}
            value={versionText}
            spellCheck={false}
            disabled={forced || pending !== null}
            aria-describedby="app-version-hint"
            onChange={(event) => setVersionText(event.target.value)}
          />
          <span id="app-version-hint" className="text-neutral-400">{forced ? "管理员推送的应用不能更换版本。" : versionHint}</span>
        </label>
      ) : null}
      <ConfigEditor drafts={drafts} disabled={pending !== null} onChange={updateDraft} onAdd={() => { setDirty(true); setDrafts((current) => [...current, { id: draftId(), key: "", secret: false, value: "", existingSecret: false }]); }} onRemove={(id) => { setDirty(true); setDrafts((current) => current.filter((item) => item.id !== id)); }} />
      {installReason ? <p id="install-block-reason" className="text-sm text-neutral-400">{installReason}</p> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {message ? <StatusText>{message}</StatusText> : null}
      <div className="flex flex-wrap gap-2">
        {showInstall ? (
          <button
            className={appButtonClass}
            data-testid="app-install"
            type="button"
            disabled={pending !== null || !provisioned || installReason !== ""}
            {...(installReason ? { "aria-describedby": "install-block-reason" } : {})}
            onClick={() => void runInstall()}
          >
            {pending === "install" ? "正在安装…" : installLabel}
          </button>
        ) : null}
        {install ? (
          <button className={appGhostClass} data-testid="app-config-save" type="button" disabled={pending !== null} onClick={askSaveConfig}>
            {pending === "config" ? "正在保存…" : "保存配置"}
          </button>
        ) : null}
        {install ? (
          <button
            className={appDangerClass}
            data-testid="app-uninstall"
            type="button"
            disabled={pending !== null || forced}
            {...(forced ? { "aria-describedby": "forced-install-note" } : {})}
            onClick={() => setConfirm({
              title: "卸载应用",
              body: `确定从你的机器卸载「${row.name}」？`,
              confirmLabel: install.state === "failed" && install.desired === "absent" ? "重试卸载" : "卸载",
              run: () => void runUninstall(),
            })}
          >
            {pending === "uninstall" ? "正在卸载…" : install.desired === "absent" && install.state === "failed" ? "重试卸载" : "卸载"}
          </button>
        ) : null}
      </div>
      {confirm ? (
        <AppConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          busy={pending !== null}
          onConfirm={confirm.run}
          onClose={() => { if (!pending) setConfirm(null); }}
        />
      ) : null}
    </article>
  );
}

function ConfigEditor({
  drafts,
  disabled,
  onChange,
  onAdd,
  onRemove,
}: {
  drafts: ConfigDraft[];
  disabled: boolean;
  onChange: (id: string, patch: Partial<Pick<ConfigDraft, "key" | "secret" | "value">>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <fieldset className="grid gap-3" disabled={disabled}>
      <legend className="text-sm font-medium">配置</legend>
      <p className="text-sm text-neutral-400">明文留空表示删除该项。已有密钥留空表示保持不变，不会回显。保存会按当前列表覆盖整份配置。</p>
      {drafts.length === 0 ? <p className="text-sm text-neutral-400">还没有配置项。</p> : null}
      {drafts.map((draft) => {
        const hintId = `config-hint-${draft.id}`;
        return (
          <div key={draft.id} className="grid gap-2 rounded border border-neutral-800 p-3">
            <label className="grid gap-1 text-sm">
              配置名
              <input className={appFieldClass} value={draft.key} spellCheck={false} autoCapitalize="characters" onChange={(event) => onChange(draft.id, { key: event.target.value.toUpperCase() })} />
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.secret} onChange={(event) => onChange(draft.id, { secret: event.target.checked })} />
              密钥
            </label>
            <label className="grid gap-1 text-sm">
              {draft.secret ? "密钥值" : "值"}
              <input
                className={appFieldClass}
                type={draft.secret ? "password" : "text"}
                autoComplete={draft.secret ? "new-password" : "off"}
                value={draft.value}
                aria-describedby={hintId}
                placeholder={draft.secret && draft.existingSecret ? "已设置，留空则保持不变" : ""}
                onChange={(event) => onChange(draft.id, { value: event.target.value })}
              />
            </label>
            <p id={hintId} className="text-sm text-neutral-400">{draft.secret ? "密钥只在这次提交时发送，页面不会保存或回显。" : "明文会保存在应用配置里。"}</p>
            <button className={appGhostClass} type="button" onClick={() => onRemove(draft.id)}>移除这一项</button>
          </div>
        );
      })}
      <button className={appGhostClass} type="button" onClick={onAdd}>添加配置项</button>
    </fieldset>
  );
}

