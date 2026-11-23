import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "./api.js";
import { AppConfirmDialog, appButtonClass, appDangerClass, appFieldClass, appGhostClass } from "./apps-page.js";

const SECRET_NAME_RE = /^[a-z0-9_]{1,64}$/;
const SECRET_LIMIT = 4096;

export const SECRET_UPDATE_NOTE = "保存后会覆盖旧值；正在运行的任务不受影响，下次启动应用或新任务时生效";

export interface UserSecretMeta {
  name: string;
  updatedAt: string;
}

export function secretNameError(name: string): string | null {
  if (!SECRET_NAME_RE.test(name) || name.startsWith("app:")) {
    return "密钥名只能是小写字母、数字和下划线，最长 64 个字符";
  }
  return null;
}

export function secretCreateError(name: string, existing: readonly string[], value: string): string | null {
  const nameError = secretNameError(name);
  if (nameError) return nameError;
  if (existing.includes(name)) return "该密钥已存在，请在列表中点击更新";
  if (value.length === 0) return "密钥内容不能为空";
  if (value.length > SECRET_LIMIT) return "密钥不能超过 4096 个字符";
  return null;
}

export function secretDeleteBody(name: string): string {
  return `确定删除密钥 ${name}？如有应用引用它，下次启动该应用时会报错。`;
}

export function SecretDeleteDialog({
  name,
  busy,
  onConfirm,
  onClose,
}: {
  name: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AppConfirmDialog
      title="删除密钥"
      body={secretDeleteBody(name)}
      confirmLabel="删除"
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

export function SecretsPage() {
  const queryClient = useQueryClient();
  const nameId = useId();
  const secrets = useQuery({
    queryKey: ["user-secrets"],
    queryFn: () => api<{ secrets: UserSecretMeta[] }>("/api/secrets"),
  });
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [formError, setFormError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTouched, setCreateTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const restoreAfterSave = useRef<HTMLButtonElement | null>(null);
  const focusCreate = useRef(false);

  const rows = [...(secrets.data?.secrets ?? [])]
    .filter((row) => typeof row.name === "string" && typeof row.updatedAt === "string")
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = rows.map((row) => row.name);
  const needle = query.trim().toLowerCase();
  const visible = needle.length === 0 ? rows : rows.filter((row) => row.name.toLowerCase().includes(needle));
  const duplicate = name.length > 0 && names.includes(name) ? "该密钥已存在，请在列表中点击更新" : "";
  const typedNameError = name.length > 0 && !duplicate ? (secretNameError(name) ?? "") : "";
  const formOpen = createTouched ? createOpen : rows.length === 0;

  function openCreate() {
    if (formOpen) {
      nameRef.current?.focus();
      return;
    }
    setCreateTouched(true);
    setCreateOpen(true);
    focusCreate.current = true;
  }

  function closeCreate(afterSave = false) {
    setName("");
    setValue("");
    setFormError("");
    setCreateTouched(true);
    setCreateOpen(false);
    if (afterSave) restoreAfterSave.current = createButton.current;
    else createButton.current?.focus();
  }

  useEffect(() => {
    if (!focusCreate.current || !formOpen) return;
    focusCreate.current = false;
    nameRef.current?.focus();
  }, [formOpen]);

  useEffect(() => {
    if (pending) return;
    restoreAfterSave.current?.focus();
    restoreAfterSave.current = null;
  }, [pending]);

  function toggleCreate() {
    if (formOpen) closeCreate();
    else openCreate();
  }

  async function reload() {
    await queryClient.invalidateQueries({ queryKey: ["user-secrets"] });
  }

  async function createSecret(event: FormEvent) {
    event.preventDefault();
    const error = secretCreateError(name, names, value);
    if (error) {
      setFormError(error);
      return;
    }
    setPending(true);
    setFormError("");
    setMessage("");
    try {
      await api(`/api/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      closeCreate(true);
      setMessage("已保存");
      await reload();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setPending(false);
    }
  }

  function toggleUpdate(secretName: string) {
    setEditing(editing === secretName ? null : secretName);
    setEditValue("");
    setEditError("");
  }

  async function updateSecret(secretName: string, form: HTMLFormElement) {
    if (editValue.length === 0) {
      setEditError("密钥内容不能为空");
      return;
    }
    if (editValue.length > SECRET_LIMIT) {
      setEditError("密钥不能超过 4096 个字符");
      return;
    }
    setPending(true);
    setEditError("");
    setMessage("");
    try {
      await api(`/api/secrets/${encodeURIComponent(secretName)}`, {
        method: "PUT",
        body: JSON.stringify({ value: editValue }),
      });
      setEditValue("");
      setEditing(null);
      restoreAfterSave.current = form.parentElement?.querySelector<HTMLButtonElement>("button[aria-expanded]") ?? null;
      setMessage("已更新");
      await reload();
    } catch (caught) {
      setEditError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setPending(false);
    }
  }

  async function removeSecret(secretName: string) {
    setPending(true);
    setMessage("");
    setDeleteError("");
    try {
      await api(`/api/secrets/${encodeURIComponent(secretName)}`, { method: "DELETE", body: "{}" });
      setConfirmName(null);
      if (editing === secretName) {
        setEditing(null);
        setEditValue("");
      }
      setMessage("已删除");
      await reload();
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "删除失败");
      setConfirmName(null);
    } finally {
      setPending(false);
    }
  }

  if (secrets.isPending) return <p className="work-page text-muted">正在加载密钥…</p>;
  if (secrets.isError) {
    return (
      <section className="work-page grid min-w-0 gap-3">
        <h1 className="text-2xl font-semibold">密钥</h1>
        <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">出错：{secrets.error instanceof Error ? secrets.error.message : "加载失败"}</p>
        <button className={appGhostClass} type="button" onClick={() => void reload()}>重试</button>
      </section>
    );
  }

  return (
    <section className="work-page grid min-w-0 gap-6">
      <div className="work-head">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">密钥</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">保存的凭证加密存放在控制面，供对话里的 {"{{secret:NAME}}"} 和应用配置引用。页面永不回显明文。</p>
        </div>
        <div className="work-head-actions">
          <button ref={createButton} className={appGhostClass} type="button" aria-expanded={formOpen} disabled={pending} onClick={toggleCreate}>新增密钥</button>
          <button className={appGhostClass} type="button" onClick={() => void reload()}>刷新</button>
        </div>
      </div>
      {formOpen ? (
        <form className="grid min-w-0 gap-3 rounded-xl border border-line bg-surface p-4" onSubmit={(event) => void createSecret(event)}>
          <h2 className="text-sm font-medium">新增密钥</h2>
          <label className="grid min-w-0 gap-1 text-sm" htmlFor={nameId}>
            密钥名
            <input
              id={nameId}
              ref={nameRef}
              className={appFieldClass}
              value={name}
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              disabled={pending}
              onChange={(event) => {
                setName(event.target.value);
                setFormError("");
              }}
            />
            <span className="text-muted">小写字母、数字和下划线，最长 64 个字符。</span>
          </label>
          <label className="grid min-w-0 gap-1 text-sm">
            密钥值
            <input
              className={appFieldClass}
              type="password"
              autoComplete="new-password"
              value={value}
              disabled={pending}
              onChange={(event) => {
                setValue(event.target.value);
                setFormError("");
              }}
            />
          </label>
          {duplicate || typedNameError || formError ? (
            <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">{duplicate || typedNameError || formError}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button className={appButtonClass} type="submit" disabled={pending}>{pending ? "正在保存…" : "保存"}</button>
            <button className={appGhostClass} type="button" disabled={pending} onClick={() => closeCreate()}>取消</button>
          </div>
        </form>
      ) : null}
      <div className="secret-tools">
        <form role="search" className="secret-search grid min-w-0 gap-1" onSubmit={(event) => event.preventDefault()}>
          <label className="grid min-w-0 gap-1 text-sm" htmlFor="secrets-search">
            搜索密钥
            <input
              id="secrets-search"
              className={appFieldClass}
              value={query}
              spellCheck={false}
              autoCapitalize="none"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </form>
        <p className="text-sm text-muted">共 {visible.length} 个</p>
      </div>
      {message ? <p role="status" className="text-sm text-ok">{message}</p> : null}
      {deleteError ? <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">{deleteError}</p> : null}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface px-4 py-8 text-sm text-secondary">
          <p>还没有保存的密钥</p>
          <button className={`${appButtonClass} mt-4`} type="button" disabled={pending} onClick={openCreate}>新增密钥</button>
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-secondary">没有匹配的密钥。</p>
      ) : (
        <ul className="grid min-w-0 gap-2" aria-label="密钥列表">
          {visible.map((row) => (
            <li key={row.name} className="secret-row">
              <div className="secret-row-main">
                <p className="break-all font-mono text-sm font-medium">{row.name}</p>
                <code className="break-all font-mono text-sm text-muted">{"{{secret:" + row.name + "}}"}</code>
                <p className="text-sm text-muted">
                  最近更新 <time dateTime={row.updatedAt}>{row.updatedAt}</time>
                </p>
              </div>
              <div className="secret-actions">
                <button className={appGhostClass} type="button" aria-expanded={editing === row.name} aria-controls={`${nameId}-edit-${row.name}`} disabled={pending} onClick={() => toggleUpdate(row.name)}>更新值</button>
                <button className={appDangerClass} type="button" disabled={pending} onClick={() => setConfirmName(row.name)}>删除</button>
              </div>
              <form id={`${nameId}-edit-${row.name}`} className="secret-edit" hidden={editing !== row.name} onSubmit={(event) => { event.preventDefault(); void updateSecret(row.name, event.currentTarget); }}>
                  <p className="text-sm text-muted">{SECRET_UPDATE_NOTE}</p>
                  <label className="grid min-w-0 gap-1 text-sm">
                    新的密钥值
                    <input
                      className={appFieldClass}
                      type="password"
                      autoComplete="new-password"
                      value={editing === row.name ? editValue : ""}
                      disabled={pending}
                      onChange={(event) => {
                        setEditValue(event.target.value);
                        setEditError("");
                      }}
                    />
                  </label>
                  {editing === row.name && editError ? <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">{editError}</p> : null}
                  <div>
                    <button className={appButtonClass} type="submit" disabled={pending}>保存新值</button>
                  </div>
              </form>
            </li>
          ))}
        </ul>
      )}
      {confirmName ? (
        <SecretDeleteDialog
          name={confirmName}
          busy={pending}
          onConfirm={() => void removeSecret(confirmName)}
          onClose={() => { if (!pending) setConfirmName(null); }}
        />
      ) : null}
    </section>
  );
}
