/**
 * 管理员应用页。不注册路由。非管理员显示 404。
 * 上传、Git、npm 只把请求交给控制面，页面不拉取远程地址。
 * 新应用保持未公开，直到显式保存可见范围。
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Me } from "./api.js";
import { ScanRow } from "./scan-row.js";
import { isWorkDesktop, resolveMasterId, useMasterReturn, useWorkDesktop } from "./work-layout.js";
import {
  AppConfirmDialog,
  ArchivePicker,
  appApi,
  appButtonClass,
  appDangerClass,
  appErrorMessage,
  appErrorText,
  appFieldClass,
  appGhostClass,
  archiveRejection,
  archiveUploadUrl,
  postArchive,
  pushInFlight,
  pushStateText,
  pushTargetText,
  readPublishResult,
  visibilityText,
  validStoredVersion,
  type AdminCatalogEntry,
  type AdminIngestRequest,
  type AdminVersion,
  type PackagePublishResult,
  type PushRequest,
  type PushTarget,
  type PushView,
  type VisibilityRequest,
} from "./apps-page.js";

const PUSH_IDS_KEY = "viate-admin-push-ids";
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

type AdminView = "library" | "upload" | "pushes";
type Leave = { kind: "app"; id: string; row: HTMLButtonElement } | { kind: "back" } | { kind: "view"; view: AdminView };
type ScopeChoice = "" | "all" | "user" | "push";

interface DirectoryUser {
  id: string | null;
  email: string;
  name: string;
  status: string;
  provisioned: boolean;
}

export function AdminApps() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me") });
  if (me.isPending) return <p className="work-page-wide text-muted">正在确认登录…</p>;
  if (!me.data?.isAdmin) return <p data-testid="not-found" className="work-page-wide">404 页面不存在</p>;
  return <AdminAppsBody csrf={me.data.csrf} />;
}

function AdminAppsBody({ csrf }: { csrf: string }) {
  const queryClient = useQueryClient();
  const apps = useQuery({
    queryKey: ["admin-apps"],
    queryFn: async () => {
      const body = await api<{ apps: AdminCatalogEntry[] }>(appApi.adminApps);
      return { apps: Array.isArray(body.apps) ? body.apps : [] };
    },
  });
  const users = useQuery({
    queryKey: ["admin-users", 200],
    queryFn: async () => {
      const body = await api<{ users: DirectoryUser[] }>("/api/admin/users?limit=200");
      return { users: Array.isArray(body.users) ? body.users : [] };
    },
  });
  const [view, setView] = useState<AdminView>("library");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const desktop = useWorkDesktop();
  const masterReturn = useMasterReturn();
  const [pushIds, setPushIds] = useState<string[]>(() => readPushIds());
  const [knownPushes, setKnownPushes] = useState<PushView[]>([]);
  const [publishNote, setPublishNote] = useState<PackagePublishResult | null>(null);
  const [leave, setLeave] = useState<Leave | null>(null);
  const [dirtyAppId, setDirtyAppId] = useState<string | null>(null);
  const markDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyAppId((current) => dirty ? id : current === id ? null : current);
  }, []);
  const tracked = useQuery({
    queryKey: ["admin-app-pushes", pushIds],
    enabled: pushIds.length > 0,
    queryFn: async () => {
      const rows = await Promise.all(pushIds.map(async (id) => {
        try {
          const body = await api<{ push: PushView }>(appApi.pushOne(id));
          return readPush(body.push);
        } catch {
          return null;
        }
      }));
      return rows.filter((push): push is PushView => push !== null && push.id !== "");
    },
    refetchInterval: (queryState) => (queryState.state.data?.some(pushInFlight) ? 2000 : false),
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(PUSH_IDS_KEY, JSON.stringify(pushIds));
    } catch {
      // 隐私模式可能拒绝写入。进度仍留在这次页面里。
    }
  }, [pushIds]);

  const listed = (apps.data?.apps ?? []).filter((app) => app.name.toLowerCase().includes(query.trim().toLowerCase()));
  const resolvedId = resolveMasterId(selectedId, listed.map((app) => app.id), desktop);
  const selected = (apps.data?.apps ?? []).find((app) => app.id === (dirtyAppId ?? resolvedId)) ?? null;
  const pushes = mergePushes(pushIds, tracked.data ?? [], knownPushes);
  const directory = (users.data?.users ?? []).filter(isListedUser);

  function rememberPush(push: PushView) {
    const next = readPush(push);
    if (!next.id) return;
    setKnownPushes((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 20));
    setPushIds((current) => [next.id, ...current.filter((id) => id !== next.id)].slice(0, 20));
  }

  function forgetPush(id: string) {
    setPushIds((current) => current.filter((item) => item !== id));
    setKnownPushes((current) => current.filter((item) => item.id !== id));
  }

  function select(id: string, row: HTMLButtonElement) {
    masterReturn.remember(row);
    setSelectedId(id);
  }

  function requestSelect(id: string, row: HTMLButtonElement) {
    if (dirtyAppId && id !== selected?.id) setLeave({ kind: "app", id, row });
    else select(id, row);
  }

  function requestView(next: AdminView) {
    if (next === view) return;
    if (dirtyAppId) setLeave({ kind: "view", view: next });
    else setView(next);
  }

  function confirmLeave() {
    if (!leave) return;
    setDirtyAppId(null);
    if (leave.kind === "view") setView(leave.view);
    else if (leave.kind === "app") select(leave.id, leave.row);
    else {
      setSelectedId(null);
      masterReturn.restore();
    }
    setLeave(null);
  }

  function closeDetail() {
    if (dirtyAppId) {
      setLeave({ kind: "back" });
      return;
    }
    setSelectedId(null);
    masterReturn.restore();
  }

  return (
    <section className="work-page-wide grid min-w-0 gap-6" data-testid="admin-apps">
      <div className="work-head">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">应用管理</h1>
          <p className="mt-1 text-sm text-muted">上传后默认不公开。推送进度按用户刷新。</p>
        </div>
        <div className="work-head-actions">
          <div role="group" aria-label="管理分区" className="flex flex-wrap gap-2">
            {([
              ["library", "应用库"],
              ["upload", "上传"],
              ["pushes", "推送记录"],
            ] as const).map(([id, label]) => (
              <button key={id} className={choiceClass(view === id)} type="button" aria-pressed={view === id} onClick={() => requestView(id)}>
                {label}
              </button>
            ))}
          </div>
          <button className={appGhostClass} type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["admin-apps"] })}>刷新</button>
        </div>
      </div>
      {view === "upload" ? (
        <UploadPanel
          csrf={csrf}
          onPublished={(result) => {
            setPublishNote(result);
            if (result.appId) setSelectedId(result.appId);
            setQuery("");
            setView("library");
            void queryClient.invalidateQueries({ queryKey: ["admin-apps"] });
          }}
        />
      ) : null}
      {view === "pushes" ? (
        <div data-testid="admin-push-progress">
          <PushProgressList pushes={pushes} users={directory} apps={apps.data?.apps ?? []} onForget={forgetPush} />
        </div>
      ) : null}
      {view === "library" && apps.isPending ? <p className="text-sm text-muted">正在加载应用…</p> : null}
      {view === "library" && apps.isError ? (
          <div className="grid gap-3">
            <p role="alert" className="break-words text-sm text-danger">出错：{appErrorMessage(apps.error)}</p>
            <button className={appGhostClass} type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["admin-apps"] })}>重试</button>
          </div>
      ) : null}
      {view === "library" && apps.data ? (
          <div className="grid gap-4">
            {publishNote ? (
              <div className="rounded-xl border border-line bg-surface p-3 text-sm">
                <p>已上传 {publishNote.name} {publishNote.version}。新应用保持未公开，直到你保存可见范围。</p>
                <WarningList warnings={publishNote.warnings} />
                <button className={`${appGhostClass} mt-3`} type="button" onClick={() => setPublishNote(null)}>知道了</button>
              </div>
            ) : null}
            <div className="master-split">
              <div className={selected ? "work-master has-detail" : "work-master"} ref={masterReturn.master} tabIndex={-1}>
                <form role="search" className="master-tools" onSubmit={(event) => event.preventDefault()}>
                  <label className="grid gap-1 text-sm" htmlFor="admin-app-search">
                    搜索应用
                    <input id="admin-app-search" data-testid="admin-app-search" className={appFieldClass} value={query} spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
                  </label>
                  <p className="text-sm text-muted">共 {listed.length} 个</p>
                </form>
                {listed.length === 0 ? (
                  <div className="rounded-xl border border-line bg-surface px-4 py-8 text-sm text-secondary">
                    <p>{(apps.data?.apps.length ?? 0) === 0 ? "还没有应用。先上传插件包。" : "没有匹配的应用。"}</p>
                    {(apps.data?.apps.length ?? 0) === 0 ? (
                      <button className={`${appButtonClass} mt-4`} type="button" onClick={() => requestView("upload")}>上传</button>
                    ) : (
                      <button className={`${appGhostClass} mt-4`} type="button" onClick={() => setQuery("")}>清除搜索</button>
                    )}
                  </div>
                ) : (
                  <ul className="master-list" aria-label="应用库">
                    {listed.map((app) => (
                      <li key={app.id}>
                        <button
                          className={`app-row min-h-11 w-full text-left ${selected?.id === app.id ? "is-selected border-primary bg-active" : "border-line bg-surface hover:bg-hover"}`}
                          type="button"
                          data-testid="admin-app-row"
                          data-admin-app-id={app.id}
                          aria-pressed={desktop ? selected?.id === app.id : undefined}
                          onClick={(event) => requestSelect(app.id, event.currentTarget)}
                        >
                          <ScanRow
                            tone="dark"
                            rule={false}
                            pad={false}
                            subject={app.name}
                            status={app.source === "user" ? "用户" : visibilityText(app.visibility)}
                            meta={app.source === "user" ? `所有者 ${app.ownerName ?? "未知"} · ${app.versions.length} 个版本` : `${app.versions.length} 个版本`}
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className={selected ? "min-w-0" : "master-empty"}>
                {selected ? (
                  <AppEditor
                    key={selected.id}
                    app={selected}
                    users={directory}
                    usersError={users.isError ? appErrorMessage(users.error) : ""}
                    pushes={pushes.filter((push) => selected.versions.some((version) => version.id === push.appVersionId))}
                    onDirty={markDirty}
                    onClose={closeDetail}
                    onChanged={async () => {
                      await queryClient.invalidateQueries({ queryKey: ["admin-apps"] });
                    }}
                    onPushed={rememberPush}
                    onForget={forgetPush}
                  />
                ) : (
                  <p className="text-sm text-muted">{apps.data.apps.length === 0 ? "还没有应用。先上传插件包。" : "没有匹配的应用。"}</p>
                )}
              </div>
            </div>
          </div>
      ) : null}
      {leave ? (
        <AppConfirmDialog
          title="还有未保存的修改"
          body="可见范围或推送对象还没保存，离开会丢掉这些修改。"
          confirmLabel="离开"
          tone="default"
          onConfirm={confirmLeave}
          onClose={() => setLeave(null)}
        />
      ) : null}
    </section>
  );
}

function AppEditor({
  app,
  users,
  usersError,
  pushes,
  onDirty,
  onClose,
  onChanged,
  onPushed,
  onForget,
}: {
  app: AdminCatalogEntry;
  users: Array<DirectoryUser & { id: string }>;
  usersError: string;
  pushes: PushView[];
  onDirty: (id: string, dirty: boolean) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onPushed: (push: PushView) => void;
  onForget: (id: string) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const active = app.versions.filter((version) => version.status === "active");
  const savedScope: ScopeChoice = app.visibility === "hidden" ? "" : app.visibility;
  const savedUsers = app.visibility === "user" ? app.userIds : [];
  const [scope, setScope] = useState<ScopeChoice>(savedScope);
  const [userIds, setUserIds] = useState<string[]>(savedUsers);
  const [versionId, setVersionId] = useState(() => active.find((version) => version.recommended)?.id ?? active[0]?.id ?? "");
  const [targets, setTargets] = useState<string[]>([]);
  const [forced, setForced] = useState(false);
  const [wake, setWake] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [retire, setRetire] = useState<AdminVersion | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const visibleIds = scope === "user" ? userIds : [];
  const visibilityDirty = scope !== savedScope || !sameSet(visibleIds, savedUsers);
  const notesDirty = active.some((version) => notes[version.id] !== undefined && notes[version.id] !== (version.importantNote ?? ""));
  const dirty = visibilityDirty || targets.length > 0 || forced || wake || notesDirty;
  useEffect(() => {
    onDirty(app.id, dirty);
    return () => onDirty(app.id, false);
  }, [app.id, dirty, onDirty]);
  useEffect(() => {
    if (!isWorkDesktop()) headingRef.current?.focus();
  }, []);

  async function saveVisibility() {
    if (scope !== "all" && scope !== "user" && scope !== "push") {
      setError("请选择可见范围");
      return;
    }
    if (scope === "user" && userIds.length === 0) {
      setError("请选择至少一位用户");
      return;
    }
    let payload: VisibilityRequest;
    if (scope === "user") payload = { scope, userIds };
    else if (scope === "push") payload = { scope: "push" };
    else payload = { scope: "all" };
    setPending("visibility");
    setError("");
    try {
      await api(appApi.visibility(app.id), { method: "PUT", body: JSON.stringify(payload) });
      setMessage("可见范围已保存");
      await onChanged();
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  async function recommend(version: AdminVersion) {
    setPending(version.id);
    setError("");
    try {
      await api(appApi.recommend(app.id, version.id), { method: "POST", body: "{}" });
      setMessage(`已推荐 ${version.version}`);
      await onChanged();
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  async function markImportant(version: AdminVersion) {
    const note = (notes[version.id] ?? version.importantNote ?? "").trim();
    if (!note) {
      setError("说明不能为空");
      return;
    }
    setPending(version.id);
    setError("");
    try {
      await api(appApi.important(app.id, version.id), { method: "POST", body: JSON.stringify({ note }) });
      setMessage(`已把 ${version.version} 标为重要更新`);
      await onChanged();
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  async function retireVersion(version: AdminVersion) {
    setPending(version.id);
    setError("");
    try {
      await api(appApi.retire(app.id, version.id), { method: "POST", body: "{}" });
      setRetire(null);
      setMessage(`已下架 ${version.version}`);
      await onChanged();
    } catch (caught) {
      setRetire(null);
      setError(appErrorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  async function sendPush() {
    if (!versionId) {
      setError("请选择版本");
      return;
    }
    if (targets.length === 0) {
      setError("请选择至少一位用户");
      return;
    }
    if (targets.length > 500) {
      setError("一次最多推送 500 人");
      return;
    }
    const payload: PushRequest = { versionId, userIds: targets, forced, wake };
    setPending("push");
    setError("");
    try {
      const body = await api<{ push: PushView }>(appApi.push(app.id), { method: "POST", body: JSON.stringify(payload) });
      onPushed(body.push);
      setTargets([]);
      setForced(false);
      setWake(false);
      setMessage("推送已提交。进度见下方，也可以打开推送记录。");
    } catch (caught) {
      setError(appErrorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <article className="master-detail grid gap-5" aria-label="应用详情">
      <div>
        <button className={`${appGhostClass} master-back mb-3`} type="button" onClick={onClose}>返回</button>
        <h2 ref={headingRef} tabIndex={-1} className="break-all text-xl font-semibold">{app.name}</h2>
        <p className="mt-1 text-sm text-muted" data-testid={app.source === "user" ? "admin-user-source" : undefined}>{app.source === "user" ? `用户来源 · 所有者 ${app.ownerName ?? "未知"}` : `${visibilityText(app.visibility)}${dirty ? " · 未保存" : ""}`}</p>
      </div>
      <section className="grid gap-3" aria-label="版本">
        <h3 className="font-medium">版本</h3>
        {app.versions.length === 0 ? <p className="text-sm text-muted">没有版本。</p> : null}
        {app.versions.map((version) => (
          <div key={version.id} className="rounded-xl border border-line bg-surface p-3 text-sm">
            <ScanRow
              tone="dark"
              rule={false}
              pad={false}
              subject={version.version}
              status={version.status === "active" ? "可安装" : version.status === "retired" ? "已下架" : "状态未知"}
              meta={`SHA-256 ${version.sha256}${version.recommended ? " · 推荐" : ""}${version.importantAt ? " · 重要更新" : ""}`}
              actions={<div className="flex flex-wrap justify-end gap-2">
              <button className={appGhostClass} type="button" onClick={() => void copyText(version.sha256, setMessage, setError)}>复制 SHA-256</button>
              <button
                className={appGhostClass}
                data-testid={`admin-recommend-${version.id}`}
                type="button"
                disabled={pending !== null || version.recommended || version.status !== "active"}
                onClick={() => void recommend(version)}
              >
                {version.recommended ? "当前推荐" : "设为推荐"}
              </button>
              <button
                className={appDangerClass}
                data-testid={`admin-retire-${version.id}`}
                type="button"
                disabled={pending !== null || version.status === "retired"}
                onClick={() => setRetire(version)}
              >
                {version.status === "retired" ? "已下架" : "下架"}
              </button>
            </div>}
            />
            {version.status === "active" ? (
              <label className="mt-3 grid gap-1">
                重要更新说明
                <input
                  data-testid={`admin-important-note-${version.id}`}
                  className={appFieldClass}
                  maxLength={500}
                  value={notes[version.id] ?? version.importantNote ?? ""}
                  onChange={(event) => setNotes((current) => ({ ...current, [version.id]: event.target.value }))}
                />
                <button
                  className={`${appGhostClass} justify-self-start`}
                  data-testid={`admin-important-${version.id}`}
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void markImportant(version)}
                >
                  标为重要更新
                </button>
              </label>
            ) : null}
          </div>
        ))}
      </section>
      {app.source === "user" ? null : <section className="grid gap-3" aria-label="可见范围">
        <h3 className="font-medium">可见范围</h3>
        <div role="group" aria-label="可见范围选项" className="flex flex-wrap gap-2">
          {([
            ["all", "全员可见"],
            ["user", "指定用户"],
            ["push", "仅推送"],
          ] as const).map(([id, label]) => (
            <button key={id} className={choiceClass(scope === id)} type="button" aria-pressed={scope === id} onClick={() => setScope(id)}>
              {label}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted">仅推送的应用不出现在用户目录里，只能由推送安装。未公开是还没有保存过范围。</p>
        {scope === "user" ? (
          <UserChecks
            users={users}
            selected={userIds}
            provisionedOnly={false}
            onChange={setUserIds}
            label="谁可以在目录里看到"
          />
        ) : null}
        {usersError ? <p role="alert" className="text-sm text-danger">出错：{usersError}</p> : null}
        <button className={appButtonClass} data-testid="admin-visibility-save" type="button" disabled={pending !== null || scope === "" || !visibilityDirty} onClick={() => void saveVisibility()}>
          {pending === "visibility" ? "正在保存…" : "保存可见范围"}
        </button>
      </section>}
      {app.source === "user" ? null : <section className="grid gap-3" aria-label="推送">
        <h3 className="font-medium">推送到机器</h3>
        {active.length === 0 ? <p className="text-sm text-muted">没有可推送的版本。</p> : (
          <label className="grid gap-1 text-sm">
            版本
            <select className={appFieldClass} value={versionId} onChange={(event) => setVersionId(event.target.value)}>
              {active.map((version) => (
                <option key={version.id} value={version.id}>{version.version}{version.recommended ? "（推荐）" : ""}</option>
              ))}
            </select>
          </label>
        )}
        <UserChecks users={users.filter((user) => user.provisioned)} selected={targets} provisionedOnly onChange={setTargets} label="推送给谁" />
        <p className="text-sm text-muted">只列出已开通的用户，最多 200 人。强制安装后用户不能卸载。</p>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={forced} onChange={(event) => setForced(event.target.checked)} />
          强制安装（用户不能卸载）
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={wake} onChange={(event) => setWake(event.target.checked)} />
          唤醒机器
        </label>
        <button className={appButtonClass} data-testid="admin-push" type="button" disabled={pending !== null || !versionId || targets.length === 0} onClick={() => void sendPush()}>
          {pending === "push" ? "正在提交…" : "开始推送"}
        </button>
      </section>}
      {error ? <p role="alert" className="break-words text-sm text-danger">出错：{error}</p> : null}
      {message ? <p role="status" className="text-sm text-ok">{message}</p> : null}
      <PushProgressList pushes={pushes} users={users} apps={[app]} onForget={onForget} />
      {retire ? (
        <AppConfirmDialog
          title="下架版本"
          body={`确定下架 ${retire.version}？之后不能再新安装或推送。`}
          confirmLabel="下架"
          busy={pending === retire.id}
          onConfirm={() => void retireVersion(retire)}
          onClose={() => { if (pending !== retire.id) setRetire(null); }}
        />
      ) : null}
    </article>
  );
}

function UserChecks({
  users,
  selected,
  provisionedOnly,
  onChange,
  label,
}: {
  users: Array<DirectoryUser & { id: string }>;
  selected: string[];
  provisionedOnly: boolean;
  onChange: (ids: string[]) => void;
  label: string;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = users.filter((user) => {
    if (provisionedOnly && !user.provisioned) return false;
    if (!needle) return true;
    return user.email.toLowerCase().includes(needle) || user.name.toLowerCase().includes(needle);
  });
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  }
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm">{label}</legend>
      <label className="grid gap-1 text-sm">
        搜索用户
        <input className={appFieldClass} value={query} spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <p className="text-sm text-muted">已选 {selected.length} 人。搜索只改变显示，不会取消已勾选。</p>
      <div className="flex flex-wrap gap-2">
        <button
          className={appGhostClass}
          type="button"
          onClick={() => onChange([...new Set([...selected, ...shown.map((user) => user.id)])])}
        >
          全选当前结果
        </button>
        <button className={appGhostClass} type="button" onClick={() => onChange([])}>清除</button>
      </div>
      <div className="max-h-60 overflow-auto rounded-xl border border-line bg-surface p-2">
        {shown.length === 0 ? <p className="px-2 py-3 text-sm text-muted">没有匹配的用户。</p> : null}
        {shown.map((user) => (
          <label key={user.id} className="flex min-h-11 items-center gap-2 px-2 text-sm">
            <input type="checkbox" checked={selected.includes(user.id)} onChange={() => toggle(user.id)} />
            <span className="break-all">{user.email || user.name}</span>
            {!user.provisioned ? <span className="text-muted">未开通</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PushProgressList({
  pushes,
  users,
  apps,
  onForget,
}: {
  pushes: PushView[];
  users: Array<DirectoryUser & { id: string }>;
  apps: AdminCatalogEntry[];
  onForget: (id: string) => void;
}) {
  if (pushes.length === 0) return <p className="text-sm text-muted">还没有推送记录。</p>;
  return (
    <div className="grid gap-3">
      <h3 className="font-medium">推送进度</h3>
      {pushes.map((push) => (
        <PushCard key={push.id} push={push} users={users} apps={apps} onForget={onForget} />
      ))}
    </div>
  );
}

function PushCard({
  push,
  users,
  apps,
  onForget,
}: {
  push: PushView;
  users: Array<DirectoryUser & { id: string }>;
  apps: AdminCatalogEntry[];
  onForget: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const located = findVersion(apps, push.appVersionId);
  const problems = push.targets.filter((target) => target.state !== "installed").slice().sort((left, right) => rankTarget(left.state) - rankTarget(right.state));
  const installed = push.targets.length - problems.length;
  const done = push.targets.filter((target) => target.state === "installed" || target.state === "failed").length;
  const percent = push.targets.length === 0 ? 0 : Math.round((done / push.targets.length) * 100);
  const rows = expanded ? [...problems, ...push.targets.filter((target) => target.state === "installed")] : problems;
  return (
    <article className="grid gap-2 rounded-xl border border-line bg-surface p-3 text-sm">
      <ScanRow
        tone="dark"
        rule={false}
        pad={false}
        subject={located ? `${located.app.name} ${located.version.version}` : "未知应用"}
        status={pushStateText(push.state)}
        meta={`${push.forced ? "强制安装" : "可卸载"}${push.wake ? " · 会唤醒机器" : ""}`}
      />
      <div className="h-2 overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="推送进度">
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <p>{done}/{push.targets.length} 已结束 · {installed} 个已安装</p>
      <ul className="grid gap-2">
        {rows.map((target) => (
          <li key={target.userId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
            <span className="min-w-0 [overflow-wrap:anywhere]">{userLabel(users, target.userId)}</span>
            <span className="text-right">{pushTargetText(target.state)}{appErrorText(target.error) ? <span className="text-danger"> · {appErrorText(target.error)}</span> : null}</span>
          </li>
        ))}
      </ul>
      {installed > 0 ? (
        <button className={appGhostClass} type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded ? "收起已安装" : `显示 ${installed} 个已安装`}
        </button>
      ) : null}
      <button className={appGhostClass} type="button" onClick={() => onForget(push.id)}>从列表移除</button>
    </article>
  );
}

export function UploadPanel({ csrf, onPublished }: { csrf: string; onPublished: (result: PackagePublishResult) => void }) {
  const [mode, setMode] = useState<"file" | "git" | "npm">("file");
  const [file, setFile] = useState<File | null>(null);
  const [pluginVersion, setPluginVersion] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [npmName, setNpmName] = useState("");
  const [npmVersion, setNpmVersion] = useState("latest");
  const [error, setError] = useState("");
  const [percent, setPercent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abortRef.current?.abort();
    };
  }, []);
  const working = percent !== null || busy;

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
    const typed = pluginVersion.trim();
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
      const published = readPublishResult(await postArchive<PackagePublishResult>(archiveUploadUrl(appApi.adminUpload, file, typed), file, csrf, setPercent, controller.signal));
      if (!alive.current) return;
      onPublished(published);
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

  async function submitGit() {
    const urlError = validateGitUrl(gitUrl);
    if (urlError) {
      setError(urlError);
      return;
    }
    const typed = pluginVersion.trim();
    if (typed && !validStoredVersion(typed)) {
      setError("版本号不合法");
      return;
    }
    const payload: AdminIngestRequest = typed ? { kind: "git", gitUrl: gitUrl.trim(), version: typed } : { kind: "git", gitUrl: gitUrl.trim() };
    await postIngest(payload);
  }

  async function submitNpm() {
    const name = npmName.trim();
    if (!NPM_NAME_RE.test(name)) {
      setError("npm 包名不合法");
      return;
    }
    const dist = npmVersion.trim() || "latest";
    if (dist.length > 128) {
      setError("npm 版本号过长");
      return;
    }
    const typed = pluginVersion.trim();
    if (typed && !validStoredVersion(typed)) {
      setError("插件版本号不合法");
      return;
    }
    const payload: AdminIngestRequest = typed
      ? { kind: "npm", name, version: dist, pluginVersion: typed }
      : { kind: "npm", name, version: dist };
    await postIngest(payload);
  }

  async function postIngest(payload: AdminIngestRequest) {
    setBusy(true);
    try {
      // 只把地址或包名交给控制面。页面不拉取 Git 或 npm。
      const published = readPublishResult(await api<PackagePublishResult>(appApi.adminIngest, { method: "POST", body: JSON.stringify(payload) }));
      if (!alive.current) return;
      onPublished(published);
    } catch (caught) {
      if (alive.current) setError(appErrorMessage(caught));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-xl border border-line bg-surface p-4" aria-label="上传应用">
      <h2 className="text-lg font-semibold">上传应用</h2>
      <p className="text-sm text-muted">新应用会保持未公开。确认可见范围后再出现在用户目录。控制面会拒绝内网、本机和元数据地址。</p>
      <div role="group" aria-label="上传方式" className="flex flex-wrap gap-2">
        {([
          ["file", "上传包"],
          ["git", "Git"],
          ["npm", "npm"],
        ] as const).map(([id, label]) => (
          <button key={id} className={choiceClass(mode === id)} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}>{label}</button>
        ))}
      </div>
      {mode === "file" ? (
        <ArchivePicker inputId="admin-archive" testId="admin-app-file" file={file} disabled={working} onFile={(next, failure) => { setFile(next); setError(failure); }} />
      ) : null}
      {mode === "git" ? (
        <label className="grid gap-1 text-sm">
          Git 地址
          <input className={appFieldClass} type="url" inputMode="url" spellCheck={false} value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} />
        </label>
      ) : null}
      {mode === "npm" ? (
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            包名
            <input className={appFieldClass} value={npmName} spellCheck={false} autoCapitalize="none" onChange={(event) => setNpmName(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            分发标签或版本
            <input className={appFieldClass} value={npmVersion} spellCheck={false} onChange={(event) => setNpmVersion(event.target.value)} />
          </label>
          <p className="text-sm text-muted">压缩包只从 registry.npmjs.org 获取。</p>
        </div>
      ) : null}
      <label className="grid gap-1 text-sm">
        插件版本（清单里没有时必填）
        <input className={appFieldClass} value={pluginVersion} spellCheck={false} onChange={(event) => setPluginVersion(event.target.value)} />
      </label>
      {percent !== null ? (
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="上传进度">
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-sm text-muted">已上传 {percent}%</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="break-words text-sm text-danger">出错：{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          className={appButtonClass}
          data-testid="admin-upload-submit"
          type="button"
          disabled={working}
          onClick={() => {
            setError("");
            if (mode === "file") void submitFile();
            else if (mode === "git") void submitGit();
            else void submitNpm();
          }}
        >
          {busy ? "正在提交…" : "上传"}
        </button>
        {percent !== null ? <button className={appGhostClass} type="button" onClick={() => abortRef.current?.abort()}>取消上传</button> : null}
      </div>
    </section>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="mt-2 grid gap-1 text-sm text-amber-fg">
      {warnings.map((warning, index) => <li key={`${index}-${warning}`}>包检查：{warning}</li>)}
    </ul>
  );
}

function choiceClass(on: boolean): string {
  return `min-h-11 rounded-full border px-3 py-2 text-sm ${on ? "border-primary bg-active font-medium text-primary" : "border-line-strong text-secondary hover:bg-hover hover:text-fg"}`;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function isListedUser(user: DirectoryUser): user is DirectoryUser & { id: string } {
  return typeof user.id === "string" && user.id !== "*" && user.status !== "disabled";
}

function userLabel(users: Array<DirectoryUser & { id: string }>, id: string): string {
  return users.find((user) => user.id === id)?.email || id;
}

function findVersion(apps: AdminCatalogEntry[], versionId: string): { app: AdminCatalogEntry; version: AdminVersion } | null {
  for (const app of apps) {
    const version = app.versions.find((item) => item.id === versionId);
    if (version) return { app, version };
  }
  return null;
}

function rankTarget(state: string): number {
  if (state === "failed") return 0;
  if (state === "installing") return 1;
  if (state === "pending") return 2;
  return 3;
}

function mergePushes(ids: string[], fetched: PushView[], known: PushView[]): PushView[] {
  const live = new Map(fetched.map((push) => [push.id, push]));
  const fallback = new Map(known.map((push) => [push.id, push]));
  const rows: PushView[] = [];
  for (const id of ids) {
    const push = live.get(id) ?? fallback.get(id);
    if (push) rows.push(push);
  }
  return rows;
}

function readPush(value: PushView): PushView {
  const targets = Array.isArray(value.targets) ? value.targets.flatMap((target) => normalizeTarget(target)) : [];
  return {
    id: typeof value.id === "string" ? value.id : "",
    appVersionId: typeof value.appVersionId === "string" ? value.appVersionId : "",
    forced: value.forced === true,
    wake: value.wake === true,
    state: typeof value.state === "string" ? value.state : "pending",
    targets,
  };
}

function normalizeTarget(target: PushTarget): PushTarget[] {
  if (!target || typeof target.userId !== "string") return [];
  return [{
    userId: target.userId,
    machineId: typeof target.machineId === "string" ? target.machineId : null,
    installId: typeof target.installId === "string" ? target.installId : null,
    state: typeof target.state === "string" ? target.state : "pending",
    error: typeof target.error === "string" ? target.error : null,
  }];
}

function readPushIds(): string[] {
  try {
    const raw = sessionStorage.getItem(PUSH_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 80).slice(0, 20);
  } catch {
    return [];
  }
}

function validateGitUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "请输入完整的 https 地址";
  }
  if (url.protocol !== "https:") return "只接受 https";
  if (url.username || url.password) return "地址不能包含用户名或密码";
  if (url.hash) return "地址不能包含片段";
  return null;
}

async function copyText(value: string, setMessage: (value: string) => void, setError: (value: string) => void) {
  try {
    await navigator.clipboard.writeText(value);
    setMessage("已复制 SHA-256");
    setError("");
  } catch {
    setError("复制失败，请手动选择");
  }
}
