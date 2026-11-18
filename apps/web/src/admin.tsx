import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api, type Me } from "./api.js";

interface AdminUser {
  id: string | null;
  email: string;
  name: string;
  status: string;
  provisioned: boolean;
  machineState: string | null;
  botCount: number;
  tasks7d: number;
  subject: string | null;
  maxBots: number | null;
  maxConcurrentTasks: number | null;
  maxRoutines: number | null;
  taskTokenBudget: number | null;
  showProcess: boolean;
}

interface Template {
  id: string;
  name: string;
  description: string;
  instructions: string;
  defaultModel: string;
  initialMemories: string[];
  welcome: string;
}

interface AdminMachine {
  id: string;
  userId: string;
  email: string;
  state: string;
  spec: { cpu: number; memMb: number; diskGb: number };
  image: string;
  createdAt: string;
  lastHeartbeatAt: string | null;
}

interface AuditRow {
  id: string;
  ts: string;
  action: string;
  target: string;
}

const field = "rounded border border-neutral-700 bg-neutral-900 px-3 py-2";
const button = "rounded bg-white px-3 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50";

export function AdminLayout() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me") });
  if (me.isPending) return <p className="px-6 py-10 text-neutral-400">正在确认登录…</p>;
  if (!me.data?.isAdmin) return <p data-testid="not-found" className="px-6 py-10">404 页面不存在</p>;
  return (
    <section>
      <nav className="flex gap-1 border-b border-neutral-800 px-4 text-sm" aria-label="管理">
        <AdminTab to="/admin" testId="admin-users-link">用户</AdminTab>
        <AdminTab to="/admin/machines" testId="admin-machines-link">机器</AdminTab>
        <AdminTab to="/admin/templates" testId="admin-templates-link">模板</AdminTab>
        <AdminTab to="/admin/settings" testId="admin-settings-link">设置</AdminTab>
        <AdminTab to="/admin/metrics" testId="admin-metrics-link">看板</AdminTab>
        <AdminTab to="/admin/audit" testId="admin-audit-link">审计</AdminTab>
        <AdminTab to="/admin/apps" testId="admin-apps-link">应用</AdminTab>
      </nav>
      <Outlet />
    </section>
  );
}

function AdminTab({ to, testId, children }: { to: "/admin" | "/admin/machines" | "/admin/templates" | "/admin/settings" | "/admin/metrics" | "/admin/audit" | "/admin/apps"; testId: string; children: string }) {
  return (
    <Link
      to={to}
      data-testid={testId}
      className="-mb-px border-b-2 px-3 py-3"
      activeOptions={{ exact: true, includeSearch: false }}
      activeProps={{ className: "border-white font-medium text-white" }}
      inactiveProps={{ className: "border-transparent text-neutral-400" }}
    >
      {children}
    </Link>
  );
}

export function AdminUsers() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => api<{ users: AdminUser[] }>("/api/admin/users") });
  const templates = useQuery({ queryKey: ["admin-templates"], queryFn: () => api<{ templates: Template[] }>("/api/admin/templates") });
  const settings = useQuery({ queryKey: ["admin-settings"], queryFn: () => api<{ integration: string; defaultChannel: string | null }>("/api/admin/settings") });
  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [channelId, setChannelId] = useState("");
  const [spec, setSpec] = useState({ cpu: 1, memMb: 1024, diskGb: 10 });
  const [templateId, setTemplateId] = useState("general");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const provision = useMutation({
    mutationFn: () => {
      const selected = users.data?.users.find((user) => (user.id ? `local:${user.id}` : `directory:${user.subject}`) === userId);
      if (!selected && !email.trim()) throw new Error("请选择用户或输入邮箱");
      return api("/api/admin/users/provision", {
        method: "POST",
        body: JSON.stringify({
          ...(selected?.id ? { userId: selected.id } : {}),
          ...(selected?.subject ? { subject: selected.subject, email: selected.email, name: selected.name } : {}),
          ...(!selected ? { email: email.trim() } : {}),
          channelId: channelId.trim() || settings.data?.defaultChannel || undefined,
          spec,
          templateId: templateId || "general",
        }),
      });
    },
    onSuccess: async () => {
      setMessage("已开通");
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (caught: Error) => {
      setMessage("");
      setError(caught.message);
    },
  });
  const quota = useMutation({
    mutationFn: (input: { id: string; maxBots: number; maxConcurrentTasks: number; maxRoutines: number; taskTokenBudget: number | null }) =>
      api(`/api/admin/users/${input.id}/quota`, {
        method: "PATCH",
        body: JSON.stringify({
          maxBots: input.maxBots,
          maxConcurrentTasks: input.maxConcurrentTasks,
          maxRoutines: input.maxRoutines,
          taskTokenBudget: input.taskTokenBudget,
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
  const processDetail = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api(`/api/admin/users/${input.id}/process-detail`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: input.enabled }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-6 py-8">
      <h1 className="text-2xl font-semibold">用户</h1>
      <form
        className="grid gap-3 rounded border border-neutral-800 p-4 md:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          provision.mutate();
        }}
      >
        <label className="grid gap-1 text-sm">
          用户
          <select data-testid="provision-user" className={field} value={userId} onChange={(event) => { setUserId(event.target.value); setEmail(""); }} required={!email.trim()}>
            <option value="">选择用户</option>
            {(users.data?.users ?? []).filter((user) => !user.provisioned).map((user) => (
              <option key={user.id ?? user.subject} value={user.id ? `local:${user.id}` : `directory:${user.subject}`}>
                {user.email}
              </option>
            ))}
          </select>
        </label>
        {settings.data?.integration === "none" ? (
          <label className="grid gap-1 text-sm">
            或按邮箱预开通
            <input data-testid="provision-email" type="email" className={field} value={email} onChange={(event) => { setEmail(event.target.value); setUserId(""); }} />
          </label>
        ) : null}
        <label className="grid gap-1 text-sm">
          模板
          <select data-testid="provision-template" className={field} value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            {(templates.data?.templates ?? []).map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          渠道 ID（留空使用默认渠道）
          <input data-testid="provision-channel" className={field} value={channelId} placeholder={settings.data?.defaultChannel ?? "用户的首个授权渠道"} onChange={(event) => setChannelId(event.target.value)} />
        </label>
        {(["cpu", "memMb", "diskGb"] as const).map((key) => (
          <label key={key} className="grid gap-1 text-sm">
            {{ cpu: "CPU", memMb: "内存 MB", diskGb: "磁盘 GB" }[key]}
            <input data-testid={`provision-${key}`} type="number" min={key === "cpu" ? 0.1 : 1} step={key === "cpu" ? 0.1 : 1} required className={field} value={spec[key]} onChange={(event) => setSpec({ ...spec, [key]: Number(event.target.value) })} />
          </label>
        ))}
        <div className="flex items-end">
          <button data-testid="provision-submit" className={button} type="submit" disabled={provision.isPending}>
            开通
          </button>
        </div>
        {message ? <p data-testid="provision-result" className="self-end text-sm text-emerald-300">{message}</p> : null}
        {error ? <p className="self-end text-sm text-red-300">{error}</p> : null}
      </form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-neutral-400">
            <tr>
              <th className="py-2">邮箱</th>
              <th>名字</th>
              <th>状态</th>
              <th>开通</th>
              <th>机器</th>
              <th>bot</th>
              <th>近 7 天任务</th>
              <th>配额</th>
            </tr>
          </thead>
          <tbody>
            {(users.data?.users ?? []).map((user) => (
              <tr key={user.id ?? user.subject ?? user.email} data-testid="user-row" className="border-t border-neutral-800">
                <td className="py-2">{user.email}</td>
                <td>{user.name}</td>
                <td>{user.status}</td>
                <td>{user.provisioned ? "已开通" : "未开通"}</td>
                <td>{user.machineState ?? "无"}</td>
                <td>{user.botCount}</td>
                <td>{user.tasks7d}</td>
                <td>
                  {user.id && user.provisioned ? (
                    <QuotaEditor
                      user={user}
                      onSave={(values) => quota.mutate({ id: user.id ?? "", ...values })}
                      onProcess={(enabled) => processDetail.mutate({ id: user.id ?? "", enabled })}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuotaEditor({
  user,
  onSave,
  onProcess,
}: {
  user: AdminUser;
  onSave: (values: { maxBots: number; maxConcurrentTasks: number; maxRoutines: number; taskTokenBudget: number | null }) => void;
  onProcess: (enabled: boolean) => void;
}) {
  const [maxBots, setMaxBots] = useState(String(user.maxBots ?? 5));
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(String(user.maxConcurrentTasks ?? 2));
  const [maxRoutines, setMaxRoutines] = useState(String(user.maxRoutines ?? 10));
  const [taskTokenBudget, setTaskTokenBudget] = useState(user.taskTokenBudget === null || user.taskTokenBudget === undefined ? "" : String(user.taskTokenBudget));
  return (
    <div className="grid gap-2">
    <form
      data-testid="quota-editor"
      className="flex flex-wrap gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          maxBots: Number(maxBots),
          maxConcurrentTasks: Number(maxConcurrentTasks),
          maxRoutines: Number(maxRoutines),
          taskTokenBudget: taskTokenBudget.trim() === "" ? null : Number(taskTokenBudget),
        });
      }}
    >
      <label className="text-xs text-neutral-400">bot <input data-testid="quota-bots" className={`${field} w-16`} value={maxBots} onChange={(event) => setMaxBots(event.target.value)} /></label>
      <label className="text-xs text-neutral-400">并发 <input data-testid="quota-tasks" className={`${field} w-16`} value={maxConcurrentTasks} onChange={(event) => setMaxConcurrentTasks(event.target.value)} /></label>
      <label className="text-xs text-neutral-400">定时 <input data-testid="quota-routines" className={`${field} w-16`} value={maxRoutines} onChange={(event) => setMaxRoutines(event.target.value)} /></label>
      <label className="text-xs text-neutral-400">预算 <input data-testid="quota-budget" className={`${field} w-24`} placeholder="沿用全局" value={taskTokenBudget} onChange={(event) => setTaskTokenBudget(event.target.value)} /></label>
      <button className="text-sm text-neutral-300" type="submit">保存</button>
    </form>
    <label className="flex items-center gap-2 text-xs text-neutral-300">
      <input data-testid="process-detail" type="checkbox" checked={user.showProcess} onChange={(event) => onProcess(event.target.checked)} />
      显示详细过程
    </label>
    </div>
  );
}

export function AdminMachines() {
  const queryClient = useQueryClient();
  const machines = useQuery({ queryKey: ["admin-machines"], queryFn: () => api<{ machines: AdminMachine[] }>("/api/admin/machines") });
  const audit = useQuery({ queryKey: ["admin-audit"], queryFn: () => api<{ audit: AuditRow[] }>("/api/admin/audit") });
  const [email, setEmail] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [stats, setStats] = useState("");
  const run = useMutation({
    mutationFn: (input: { id: string; action: string; body?: unknown }) =>
      api(`/api/admin/machines/${input.id}/${input.action}`, {
        method: "POST",
        ...(input.body ? { body: JSON.stringify(input.body) } : { body: "{}" }),
      }),
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["admin-machines"] });
      await queryClient.invalidateQueries({ queryKey: ["admin-audit"] });
    },
    onError: async (caught: Error) => {
      setError(caught.message);
      await queryClient.invalidateQueries({ queryKey: ["admin-audit"] });
    },
  });

  function onDelete(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    run.mutate({ id: target, action: "delete", body: { email } });
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-6 py-8">
      <h1 className="text-2xl font-semibold">机器</h1>
      <ul className="grid gap-3">
        {(machines.data?.machines ?? []).map((machine) => (
          <li key={machine.id} data-testid="machine-row" className="rounded border border-neutral-800 p-4 text-sm">
            <p>{machine.email} · {machine.state} · {machine.spec.cpu} CPU / {machine.spec.memMb} MB</p>
            <p className="text-neutral-400">{machine.image} · {machine.createdAt} · 健康检查 {machine.lastHeartbeatAt ?? "无"}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button data-testid="machine-stop" className="rounded border border-neutral-600 px-3 py-1" type="button" onClick={() => run.mutate({ id: machine.id, action: "stop" })}>停止</button>
              <button data-testid="machine-start" className="rounded border border-neutral-600 px-3 py-1" type="button" onClick={() => run.mutate({ id: machine.id, action: "start" })}>启动</button>
              <button className="rounded border border-neutral-600 px-3 py-1" type="button" onClick={() => run.mutate({ id: machine.id, action: "restart" })}>重启</button>
              <button className="rounded border border-neutral-600 px-3 py-1" type="button" onClick={() => run.mutate({ id: machine.id, action: "rebuild" })}>重建</button>
              <button data-testid="machine-delete" className="rounded border border-neutral-600 px-3 py-1" type="button" onClick={() => setTarget(machine.id)}>删除</button>
              <button
                data-testid={`machine-stats-${machine.id}`}
                className="rounded border border-neutral-600 px-3 py-1"
                type="button"
                onClick={() => {
                  void api<{ cpuPct: number; memMb: number }>(`/api/admin/machines/${machine.id}/stats`).then((result) => {
                    setStats(`${machine.email} CPU ${result.cpuPct}% 内存 ${result.memMb} MB`);
                  });
                }}
              >
                占用
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap items-end gap-3" onSubmit={onDelete}>
        <label className="grid gap-1 text-sm">
          确认邮箱
          <input data-testid="machine-delete-email" className={field} value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <button data-testid="machine-delete-submit" className={button} type="submit">确认删除</button>
      </form>
      {error ? <p data-testid="machine-delete-error" className="text-sm text-red-300">{error}</p> : null}
      {stats ? <p data-testid="machine-stats">{stats}</p> : null}
      <h2 className="text-lg font-medium">审计</h2>
      <ul data-testid="audit-log" className="grid gap-1 text-sm text-neutral-300">
        {(audit.data?.audit ?? []).map((row) => (
          <li key={row.id}>{row.ts} {row.action} {row.target}</li>
        ))}
      </ul>
    </div>
  );
}

export function AdminTemplates() {
  const queryClient = useQueryClient();
  const templates = useQuery({ queryKey: ["admin-templates"], queryFn: () => api<{ templates: Template[] }>("/api/admin/templates") });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [welcome, setWelcome] = useState("");
  const [initialMemories, setInitialMemories] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api("/api/admin/templates", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          instructions,
          defaultModel,
          welcome,
          initialMemories: initialMemories.split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
        }),
      }),
    onSuccess: async () => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/admin/templates/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-templates"] });
    },
  });

  return (
    <div className="mx-auto grid max-w-3xl gap-6 px-6 py-8">
      <h1 className="text-2xl font-semibold">模板</h1>
      <ul className="grid gap-2">
        {(templates.data?.templates ?? []).map((template) => (
          <li key={template.id} className="rounded border border-neutral-800 p-3 text-sm">
            <p className="font-medium">{template.name}</p>
            <p className="text-neutral-400">{template.description}</p>
            <button className="mt-2 text-neutral-400" type="button" onClick={() => remove.mutate(template.id)}>删除</button>
          </li>
        ))}
      </ul>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <input data-testid="template-name" className={field} placeholder="名字" value={name} onChange={(event) => setName(event.target.value)} required />
        <input className={field} placeholder="说明" value={description} onChange={(event) => setDescription(event.target.value)} />
        <textarea className={field} placeholder="指令" value={instructions} onChange={(event) => setInstructions(event.target.value)} />
        <input className={field} placeholder="默认模型" value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} />
        <input className={field} placeholder="欢迎消息" value={welcome} onChange={(event) => setWelcome(event.target.value)} />
        <textarea className={field} placeholder="初始记忆，一行一条" value={initialMemories} onChange={(event) => setInitialMemories(event.target.value)} />
        <button className={button} type="submit">添加模板</button>
      </form>
    </div>
  );
}

export function AdminSettings() {
  const settings = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => api<{
      integration: string;
      defaultChannel: string | null;
      platformPrompt: { version: number; text: string };
      modelLimits: Record<string, { contextTokens: number; maxTokens: number }>;
      modelDefaults: { contextTokens: number; maxTokens: number };
      taskTokenBudget: number;
      models: string[];
    }>("/api/admin/settings"),
  });
  const [prompt, setPrompt] = useState("");
  const [channel, setChannel] = useState("");
  const [saved, setSaved] = useState("");
  const update = useMutation({
    mutationFn: () =>
      api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          platformPrompt: prompt || settings.data?.platformPrompt.text,
          ...(settings.data?.integration === "viate" ? { defaultChannel: channel } : {}),
        }),
      }),
    onSuccess: () => setSaved("已保存"),
  });

  return (
    <>
    <form
      className="mx-auto grid max-w-3xl gap-4 px-6 py-8"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate();
      }}
    >
      <h1 className="text-2xl font-semibold">设置</h1>
      {settings.data?.integration === "viate" ? (
        <label className="grid gap-1 text-sm">
          默认渠道
          <input data-testid="default-channel" className={field} value={channel} placeholder={settings.data.defaultChannel ?? ""} onChange={(event) => setChannel(event.target.value)} />
        </label>
      ) : (
        <p className="text-sm text-neutral-400">当前未接 viate，没有默认渠道。</p>
      )}
      <label className="grid gap-1 text-sm">
        平台提示词（版本 {settings.data?.platformPrompt.version ?? ""}）
        <textarea data-testid="platform-prompt" className={`${field} min-h-40`} value={prompt} placeholder={settings.data?.platformPrompt.text ?? ""} onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <button className={button} type="submit">保存</button>
      {saved ? <p className="text-sm text-emerald-300">{saved}</p> : null}
    </form>
    <ModelLimits settings={settings.data} />
    </>
  );
}

function ModelLimits({ settings }: { settings: { modelLimits: Record<string, { contextTokens: number; maxTokens: number }>; modelDefaults: { contextTokens: number; maxTokens: number }; taskTokenBudget?: number; models: string[] } | undefined }) {
  const client = useQueryClient();
  const [model, setModel] = useState("");
  const [contextTokens, setContextTokens] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [budget, setBudget] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loadedBudget = settings?.taskTokenBudget;
  const draft = budget !== null ? budget : loadedBudget === undefined ? "" : String(loadedBudget);
  const budgetReady = loadedBudget !== undefined && /^\d+$/.test(draft);
  const save = useMutation({
    mutationFn: (clear: boolean) => api("/api/admin/model-limits", {
      method: "PUT",
      body: JSON.stringify(clear ? { model, clear: true } : { model, contextTokens: Number(contextTokens), maxTokens: Number(maxTokens) }),
    }),
    onSuccess: async () => {
      setError("");
      await client.invalidateQueries({ queryKey: ["admin-settings"] });
    },
    onError: (caught: Error) => setError(caught.message),
  });
  const defaults = settings?.modelDefaults;
  return (
    <section data-testid="model-settings" className="mx-auto grid max-w-3xl gap-3 px-6 pb-10">
      <h2 className="text-xl font-semibold">模型设置</h2>
      <p className="text-sm text-neutral-400">未单独设置的模型使用环境默认值：上下文 {defaults?.contextTokens ?? ""}，单次输出 {defaults?.maxTokens ?? ""}。只影响之后开始的任务。输出上限不能超过上下文窗口。</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (!budgetReady) {
          setError("token 预算必须是非负整数");
          return;
        }
        void api("/api/admin/task-token-budget", { method: "PUT", body: JSON.stringify({ value: Number(draft) }) }).then(async () => {
          setError("");
          await client.invalidateQueries({ queryKey: ["admin-settings"] });
        }).catch((caught: Error) => setError(caught.message));
      }}>
        <label className="grid gap-1 text-sm">单任务 token 预算（0 表示不限制，计入输入和输出，不计缓存）
          <input data-testid="task-token-budget" className={field} value={draft} onChange={(event) => setBudget(event.target.value)} />
        </label>
        <button className={button} type="submit" disabled={!budgetReady}>保存预算</button>
      </form>
      <ul className="grid gap-1 text-sm">
        {Object.entries(settings?.modelLimits ?? {}).map(([name, limit]) => (
          <li key={name}>{name}：上下文 {limit.contextTokens}，输出 {limit.maxTokens}</li>
        ))}
        {Object.keys(settings?.modelLimits ?? {}).length === 0 ? <li className="text-neutral-500">还没有单独设置</li> : null}
      </ul>
      <form className="grid gap-2 md:grid-cols-4" onSubmit={(event) => { event.preventDefault(); save.mutate(false); }}>
        <input data-testid="model-limit-name" list="known-models" className={field} placeholder="模型 ID" value={model} onChange={(event) => setModel(event.target.value)} required />
        <datalist id="known-models">{(settings?.models ?? []).map((name) => <option key={name} value={name} />)}</datalist>
        <input data-testid="model-context" className={field} placeholder="上下文窗口" value={contextTokens} onChange={(event) => setContextTokens(event.target.value)} required />
        <input data-testid="model-output" className={field} placeholder="单次输出上限" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} required />
        <button className={button} type="submit">保存</button>
      </form>
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
    </section>
  );
}
