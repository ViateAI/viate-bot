import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readQuotaForm } from "./quota-input.js";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type Me } from "./api.js";
import { ScanRow } from "./scan-row.js";
import { workPageFrame } from "./work-layout.js";

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
  taskMaxSteps: number | null;
  taskMaxDurationSec: number | null;
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
  statusDetail?: string | null;
}

const field = "ui-field";
const button = "ui-btn";

function splitConfinePaths(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}
const alertClass = "ui-alert";
const machineButton = "ui-btn-ghost min-h-8 px-2.5 text-xs";

export function AdminLayout() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me") });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const frame = workPageFrame(pathname) ?? "work-page";
  if (me.isPending) return <p className={`${frame} text-muted`}>正在确认登录…</p>;
  if (!me.data?.isAdmin) return <p data-testid="not-found" className={frame}>404 页面不存在</p>;
  return <Outlet />;
}

export function AdminNav() {
  const reviews = useQuery({ queryKey: ["admin-app-reviews"], queryFn: () => api<{ pendingCount: number }>("/api/admin/app-reviews") });
  const pending = reviews.data?.pendingCount ?? 0;
  return (
    <nav className="anav" aria-label="管理">
      <div className="anav-head">
        <h2 className="text-sm font-medium">管理</h2>
      </div>
      <AdminTab to="/admin" testId="admin-users-link">分诊 / 用户</AdminTab>
      <AdminTab to="/admin/machines" testId="admin-machines-link">机器</AdminTab>
      <AdminTab to="/admin/templates" testId="admin-templates-link">模板</AdminTab>
      <AdminTab to="/admin/settings" testId="admin-settings-link">设置</AdminTab>
      <AdminTab to="/admin/metrics" testId="admin-metrics-link">看板</AdminTab>
      <AdminTab to="/admin/audit" testId="admin-audit-link">审计</AdminTab>
      <AdminTab to="/admin/apps" testId="admin-apps-link">应用</AdminTab>
      <AdminTab to="/admin/app-reviews" testId="admin-reviews-link">
        应用审批{pending > 0 ? <span data-testid="publish-review-badge"> {pending}</span> : null}
      </AdminTab>
    </nav>
  );
}

function AdminTab({ to, testId, children }: { to: "/admin" | "/admin/machines" | "/admin/templates" | "/admin/settings" | "/admin/metrics" | "/admin/audit" | "/admin/apps" | "/admin/app-reviews"; testId: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      data-testid={testId}
      className="anav-link"
      activeOptions={{ exact: true, includeSearch: false }}
      activeProps={{ className: "anav-link is-active" }}
      inactiveProps={{ className: "anav-link" }}
    >
      {children}
    </Link>
  );
}

export function AdminUsers() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => api<{ users: AdminUser[] }>("/api/admin/users") });
  const reviews = useQuery({ queryKey: ["admin-app-reviews"], queryFn: () => api<{ pendingCount: number }>("/api/admin/app-reviews") });
  const machines = useQuery({ queryKey: ["admin-machines"], queryFn: () => api<{ machines: Array<{ state: string }> }>("/api/admin/machines") });
  const templates = useQuery({ queryKey: ["admin-templates"], queryFn: () => api<{ templates: Template[] }>("/api/admin/templates") });
  const settings = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => api<{
      integration: string;
      defaultChannel: string | null;
      provisionDefaults: { maxBots: number; maxConcurrentTasks: number; maxRoutines: number; models: string[] };
    }>("/api/admin/settings"),
  });
  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [channelId, setChannelId] = useState("");
  const [spec, setSpec] = useState({ cpu: 1, memMb: 1024, diskGb: 10 });
  const [templateId, setTemplateId] = useState("general");
  const [model, setModel] = useState<string | null>(null);
  const [maxBots, setMaxBots] = useState<string | null>(null);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState<string | null>(null);
  const [maxRoutines, setMaxRoutines] = useState<string | null>(null);
  const [taskTokenBudget, setTaskTokenBudget] = useState("");
  const [taskMaxSteps, setTaskMaxSteps] = useState("");
  const [taskMaxDurationSec, setTaskMaxDurationSec] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const defaults = settings.data?.provisionDefaults;
  const selectedTemplate = (templates.data?.templates ?? []).find((item) => item.id === templateId);
  const configuredModels = defaults?.models ?? [];
  const templateModel = selectedTemplate?.defaultModel.trim() ?? "";
  const defaultModel = configuredModels.length > 0
    ? (templateModel && configuredModels.includes(templateModel) ? templateModel : configuredModels[0] ?? "")
    : templateModel;
  const modelValue = model ?? defaultModel;
  const botsValue = maxBots ?? (defaults ? String(defaults.maxBots) : "");
  const tasksValue = maxConcurrentTasks ?? (defaults ? String(defaults.maxConcurrentTasks) : "");
  const routinesValue = maxRoutines ?? (defaults ? String(defaults.maxRoutines) : "");
  const provision = useMutation({
    mutationFn: () => {
      const selected = users.data?.users.find((user) => (user.id ? `local:${user.id}` : `directory:${user.subject}`) === userId);
      if (!selected && !email.trim()) throw new Error("请选择用户或输入邮箱");
      const nextErrors: Record<string, string> = {};
      const bots = Number(botsValue);
      const tasks = Number(tasksValue);
      const routines = Number(routinesValue);
      if (!botsValue.trim() || !Number.isInteger(bots) || bots < 1) nextErrors.maxBots = "maxBots 必须是正整数";
      if (!tasksValue.trim() || !Number.isInteger(tasks) || tasks < 1) nextErrors.maxConcurrentTasks = "maxConcurrentTasks 必须是正整数";
      if (!routinesValue.trim() || !Number.isInteger(routines) || routines < 0) nextErrors.maxRoutines = "maxRoutines 必须是非负整数";
      const budgetText = taskTokenBudget.trim();
      const budget = budgetText === "" ? null : Number(budgetText);
      if (budget !== null && (!Number.isInteger(budget) || budget < 0)) nextErrors.taskTokenBudget = "token 预算必须是非负整数";
      const stepsText = taskMaxSteps.trim();
      const steps = stepsText === "" ? null : Number(stepsText);
      if (steps !== null && (!Number.isInteger(steps) || steps < 0)) nextErrors.taskMaxSteps = "步数上限必须是非负整数";
      const durationText = taskMaxDurationSec.trim();
      const duration = durationText === "" ? null : Number(durationText);
      if (duration !== null && (!Number.isInteger(duration) || duration < 0)) nextErrors.taskMaxDurationSec = "时长上限必须是非负整数";
      if (!modelValue.trim()) nextErrors.model = "没有可用模型";
      else if (configuredModels.length > 0 && !configuredModels.includes(modelValue)) nextErrors.model = `模型不在白名单内: ${modelValue}`;
      setFieldErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) throw new Error("请修正标出的字段");
      return api("/api/admin/users/provision", {
        method: "POST",
        body: JSON.stringify({
          ...(selected?.id ? { userId: selected.id } : {}),
          ...(selected?.subject ? { subject: selected.subject, email: selected.email, name: selected.name } : {}),
          ...(!selected ? { email: email.trim() } : {}),
          channelId: channelId.trim() || settings.data?.defaultChannel || undefined,
          spec,
          templateId: templateId || "general",
          model: modelValue,
          maxBots: bots,
          maxConcurrentTasks: tasks,
          maxRoutines: routines,
          ...(budget === null ? {} : { taskTokenBudget: budget }),
          ...(steps === null ? {} : { taskMaxSteps: steps }),
          ...(duration === null ? {} : { taskMaxDurationSec: duration }),
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
    mutationFn: (input: { id: string; maxBots: number; maxConcurrentTasks: number; maxRoutines: number; taskTokenBudget: number | null; taskMaxSteps: number | null; taskMaxDurationSec: number | null }) =>
      api(`/api/admin/users/${input.id}/quota`, {
        method: "PATCH",
        body: JSON.stringify({
          maxBots: input.maxBots,
          maxConcurrentTasks: input.maxConcurrentTasks,
          maxRoutines: input.maxRoutines,
          taskTokenBudget: input.taskTokenBudget,
          taskMaxSteps: input.taskMaxSteps,
          taskMaxDurationSec: input.taskMaxDurationSec,
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
    <div className="work-page grid min-w-0 gap-6">
      <div className="work-head">
        <h1 className="text-2xl font-semibold">用户</h1>
      </div>
      <div className="triage" data-testid="admin-triage">
        <Link to="/admin/app-reviews" className={reviews.data && reviews.data.pendingCount > 0 ? "triage-amber" : ""}>待审发布 <strong>{reviews.data ? reviews.data.pendingCount : "…"}</strong></Link>
        <Link to="/admin/machines" className={machines.data && machines.data.machines.some((item) => item.state === "error") ? "triage-bad" : ""}>异常机器 <strong>{machines.data ? machines.data.machines.filter((item) => item.state === "error").length : "…"}</strong></Link>
        <a href="#provision" className={users.data && users.data.users.some((user) => !user.provisioned) ? "triage-info" : ""}>已登录未开通 <strong>{users.data ? users.data.users.filter((user) => !user.provisioned).length : "…"}</strong></a>
      </div>
      <form
        id="provision"
        className="grid min-w-0 gap-3.5 rounded-xl border border-line bg-surface p-4 md:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          provision.mutate();
        }}
      >
        <h2 className="text-sm font-semibold md:col-span-4">开通新用户</h2>
        <label className="grid min-w-0 gap-1 text-sm">
          用户
          <select data-testid="provision-user" className={`${field} w-full min-w-0`} value={userId} onChange={(event) => { setUserId(event.target.value); setEmail(""); }} required={!email.trim()}>
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
        <label className="grid min-w-0 gap-1 text-sm">
          模板
          <select data-testid="provision-template" className={`${field} w-full min-w-0`} value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
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
        <label className="grid gap-1 text-sm">
          模型
          {configuredModels.length > 0 ? (
            <select data-testid="provision-model" className={field} value={modelValue} onChange={(event) => setModel(event.target.value)}>
              {configuredModels.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          ) : (
            <input data-testid="provision-model" className={field} value={modelValue} onChange={(event) => setModel(event.target.value)} />
          )}
          {fieldErrors.model ? <span className="text-danger">{fieldErrors.model}</span> : null}
        </label>
        <label className="grid gap-1 text-sm">
          bot 数
          <input data-testid="provision-bots" className={field} value={botsValue} onChange={(event) => setMaxBots(event.target.value)} />
          {fieldErrors.maxBots ? <span className="text-danger">{fieldErrors.maxBots}</span> : null}
        </label>
        <label className="grid gap-1 text-sm">
          并发任务
          <input data-testid="provision-tasks" className={field} value={tasksValue} onChange={(event) => setMaxConcurrentTasks(event.target.value)} />
          {fieldErrors.maxConcurrentTasks ? <span className="text-danger">{fieldErrors.maxConcurrentTasks}</span> : null}
        </label>
        <label className="grid gap-1 text-sm">
          定时任务
          <input data-testid="provision-routines" className={field} value={routinesValue} onChange={(event) => setMaxRoutines(event.target.value)} />
          {fieldErrors.maxRoutines ? <span className="text-danger">{fieldErrors.maxRoutines}</span> : null}
        </label>
        <label className="grid gap-1 text-sm">
          单任务 token 预算（留空用全局值）
          <input data-testid="provision-budget" className={field} value={taskTokenBudget} placeholder="沿用全局" onChange={(event) => setTaskTokenBudget(event.target.value)} />
          {fieldErrors.taskTokenBudget ? <span className="text-danger">{fieldErrors.taskTokenBudget}</span> : null}
        </label>
        <label className="grid gap-1 text-sm">
          单任务步数上限（留空用全局值，0 表示不限制）
          <input data-testid="provision-steps" className={field} value={taskMaxSteps} placeholder="沿用全局" onChange={(event) => setTaskMaxSteps(event.target.value)} />
          {fieldErrors.taskMaxSteps ? <span className="text-danger">{fieldErrors.taskMaxSteps}</span> : null}
        </label>
        <label className="grid gap-1 text-sm">
          单任务时长上限秒（留空用全局值，0 表示不限制）
          <input data-testid="provision-duration" className={field} value={taskMaxDurationSec} placeholder="沿用全局" onChange={(event) => setTaskMaxDurationSec(event.target.value)} />
          {fieldErrors.taskMaxDurationSec ? <span className="text-danger">{fieldErrors.taskMaxDurationSec}</span> : null}
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
        {message ? <p data-testid="provision-result" className="self-end text-sm text-ok">{message}</p> : null}
        {error ? <p className="self-end text-sm text-danger">{error}</p> : null}
      </form>
      {users.isPending ? <p className="text-sm text-muted">正在加载用户…</p> : null}
      {users.isError ? <p role="alert" className={alertClass}>{users.error.message}</p> : null}
      {users.data && users.data.users.length === 0 ? <p className="text-sm text-muted">没有用户</p> : null}
      <div className="@container relative min-w-0 overflow-x-auto rounded-xl border border-line bg-canvas p-3">
        <table className="vb-user-table text-left text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th id="vb-user-email" scope="col" className="py-2">邮箱</th>
              <th id="vb-user-name" scope="col">名字</th>
              <th id="vb-user-status" scope="col">状态</th>
              <th id="vb-user-provision" scope="col">开通</th>
              <th id="vb-user-machine" scope="col">机器</th>
              <th id="vb-user-bots" scope="col">bot</th>
              <th id="vb-user-tasks" scope="col">近 7 天任务</th>
              <th id="vb-user-quota" scope="col">配额</th>
            </tr>
          </thead>
          <tbody>
            {(users.data?.users ?? []).map((user) => (
              <tr key={user.id ?? user.subject ?? user.email} data-testid="user-row" className="border-t border-line">
                <UserCell id="vb-user-email">{user.email}</UserCell>
                <UserCell id="vb-user-name" label="名字" className="text-muted">{user.name}</UserCell>
                <UserCell id="vb-user-status" label="状态">{user.status}</UserCell>
                <UserCell id="vb-user-provision" label="开通" className="text-muted">{user.provisioned ? "已开通" : "未开通"}</UserCell>
                <UserCell id="vb-user-machine" label="机器" className="text-muted">{user.machineState ?? "无"}</UserCell>
                <UserCell id="vb-user-bots" label="bot" className="text-muted">{user.botCount}</UserCell>
                <UserCell id="vb-user-tasks" label="近 7 天任务" className="text-muted">{user.tasks7d}</UserCell>
                <td headers="vb-user-quota">
                  {user.id && user.provisioned ? (
                    <>
                      <span className="vb-user-label text-muted">配额</span>
                      <QuotaEditor
                        user={user}
                        onSave={(values) => quota.mutate({ id: user.id ?? "", ...values })}
                        onProcess={(enabled) => processDetail.mutate({ id: user.id ?? "", enabled })}
                      />
                    </>
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

function UserCell({ id, label, className, children }: { id: string; label?: string; className?: string; children: ReactNode }) {
  return <td headers={id} className={className}>{label ? <span className="vb-user-label text-muted">{label} </span> : null}{children}</td>;
}

function QuotaEditor({
  user,
  onSave,
  onProcess,
}: {
  user: AdminUser;
  onSave: (values: { maxBots: number; maxConcurrentTasks: number; maxRoutines: number; taskTokenBudget: number | null; taskMaxSteps: number | null; taskMaxDurationSec: number | null }) => void;
  onProcess: (enabled: boolean) => void;
}) {
  const [maxBots, setMaxBots] = useState(String(user.maxBots ?? 5));
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(String(user.maxConcurrentTasks ?? 2));
  const [maxRoutines, setMaxRoutines] = useState(String(user.maxRoutines ?? 10));
  const [taskTokenBudget, setTaskTokenBudget] = useState(user.taskTokenBudget === null || user.taskTokenBudget === undefined ? "" : String(user.taskTokenBudget));
  const [taskMaxSteps, setTaskMaxSteps] = useState(user.taskMaxSteps === null || user.taskMaxSteps === undefined ? "" : String(user.taskMaxSteps));
  const [taskMaxDurationSec, setTaskMaxDurationSec] = useState(user.taskMaxDurationSec === null || user.taskMaxDurationSec === undefined ? "" : String(user.taskMaxDurationSec));
  const [quotaError, setQuotaError] = useState("");
  return (
    <div className="grid gap-2">
    <form
      data-testid="quota-editor"
      className="quota-grid"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const values = readQuotaForm({
            maxBots,
            maxConcurrentTasks,
            maxRoutines,
            taskTokenBudget,
            taskMaxSteps,
            taskMaxDurationSec,
          });
          setQuotaError("");
          onSave(values);
        } catch (caught) {
          setQuotaError(caught instanceof Error ? caught.message : "必须是非负整数");
        }
      }}
    >
      <label className="grid gap-1 text-xs text-muted">bot <input data-testid="quota-bots" className={`${field} w-full`} value={maxBots} onChange={(event) => setMaxBots(event.target.value)} /></label>
      <label className="grid gap-1 text-xs text-muted">并发 <input data-testid="quota-tasks" className={`${field} w-full`} value={maxConcurrentTasks} onChange={(event) => setMaxConcurrentTasks(event.target.value)} /></label>
      <label className="grid gap-1 text-xs text-muted">定时 <input data-testid="quota-routines" className={`${field} w-full`} value={maxRoutines} onChange={(event) => setMaxRoutines(event.target.value)} /></label>
      <label className="grid gap-1 text-xs text-muted">预算 <input data-testid="quota-budget" className={`${field} w-full`} placeholder="沿用全局" value={taskTokenBudget} onChange={(event) => setTaskTokenBudget(event.target.value)} /></label>
      <label className="grid gap-1 text-xs text-muted">步数 <input data-testid="quota-steps" className={`${field} w-full`} placeholder="沿用全局" value={taskMaxSteps} onChange={(event) => setTaskMaxSteps(event.target.value)} /></label>
      <label className="grid gap-1 text-xs text-muted">时长秒 <input data-testid="quota-duration" className={`${field} w-full`} placeholder="沿用全局" value={taskMaxDurationSec} onChange={(event) => setTaskMaxDurationSec(event.target.value)} /></label>
      <button className="ui-btn-ghost text-sm" type="submit">保存</button>
      {quotaError ? <p role="alert" className="text-xs text-danger">{quotaError}</p> : null}
    </form>
    <label className="flex items-center gap-2 text-xs text-secondary">
      <input data-testid="process-detail" type="checkbox" checked={user.showProcess} onChange={(event) => onProcess(event.target.checked)} />
      显示详细过程
    </label>
    </div>
  );
}

export function AdminMachines({ initialDeleteId = "" }: { initialDeleteId?: string } = {}) {
  const queryClient = useQueryClient();
  const machines = useQuery({ queryKey: ["admin-machines"], queryFn: () => api<{ machines: AdminMachine[] }>("/api/admin/machines") });
  const [confirmation, setConfirmation] = useState(initialDeleteId ? { id: initialDeleteId, email: "" } : null);
  const [error, setError] = useState("");
  const [stats, setStats] = useState("");
  useEffect(() => {
    const listed = machines.data?.machines;
    if (listed) setConfirmation((current) => current && !listed.some((item) => item.id === current.id) ? null : current);
  }, [machines.data]);
  const run = useMutation({
    mutationFn: (input: { id: string; action: string; body?: unknown }) =>
      api(`/api/admin/machines/${input.id}/${input.action}`, {
        method: "POST",
        ...(input.body ? { body: JSON.stringify(input.body) } : { body: "{}" }),
      }),
    onSuccess: async (_, { id, action }) => {
      if (action === "delete") setConfirmation((current) => current?.id === id ? null : current);
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
    if (!confirmation) return;
    run.mutate({ id: confirmation.id, action: "delete", body: { email: confirmation.email } });
  }

  return (
    <div className="work-page grid min-w-0 gap-6">
      <div className="work-head">
        <h1 className="text-2xl font-semibold">机器</h1>
        <Link to="/admin/audit" className="text-sm text-primary">查看审计日志</Link>
      </div>
      {machines.isPending ? <p className="text-sm text-muted">正在加载机器…</p> : null}
      {machines.isError ? <p role="alert" className={alertClass}>{machines.error.message}</p> : null}
      {machines.data && machines.data.machines.length === 0 ? <p className="text-sm text-muted">没有机器</p> : null}
      <ul className="rounded-xl border border-line bg-surface px-3">
        {(machines.data?.machines ?? []).map((machine) => (
          <li key={machine.id} data-testid="machine-row" className="text-sm">
            <ScanRow
              tone="dark"
              subject={machine.email}
              status={<span className={machineTone(machine.state)}>{machine.state}</span>}
              meta={<span>{machine.spec.cpu} CPU / {machine.spec.memMb} MB · {machine.image} · {machine.createdAt} · 健康检查 {machine.lastHeartbeatAt ?? "无"}{machine.statusDetail ? <span data-testid="machine-status-detail" className="text-danger"> · {machine.statusDetail}</span> : null}</span>}
              actions={<>
                <button data-testid="machine-stop" className={machineButton} type="button" onClick={() => run.mutate({ id: machine.id, action: "stop" })}>停止</button>
                <button data-testid="machine-start" className={machineButton} type="button" onClick={() => run.mutate({ id: machine.id, action: "start" })}>启动</button>
                <button className={machineButton} type="button" onClick={() => run.mutate({ id: machine.id, action: "restart" })}>重启</button>
                <button className={machineButton} type="button" onClick={() => run.mutate({ id: machine.id, action: "rebuild" })}>重建</button>
                <button data-testid="machine-delete" className={machineButton} type="button" onClick={() => setConfirmation({ id: machine.id, email: "" })}>删除</button>
                <button
                  data-testid={`machine-stats-${machine.id}`}
                  className={machineButton}
                  type="button"
                  onClick={() => {
                    void api<{ cpuPct: number; memMb: number }>(`/api/admin/machines/${machine.id}/stats`).then((result) => {
                      setStats(`${machine.email} CPU ${result.cpuPct}% 内存 ${result.memMb} MB`);
                    });
                  }}
                >
                  占用
                </button>
              </>}
            />
            {confirmation?.id === machine.id ? (
              <form className="mb-3 grid max-w-xl gap-3 rounded-xl border border-danger-border bg-danger-bg p-4" onSubmit={onDelete}>
                <p className="text-sm font-medium text-danger">删除 {machine.email} 的机器</p>
                <label className="grid gap-1 text-sm">
                  确认邮箱
                  <input data-testid="machine-delete-email" className={field} value={confirmation.email} onChange={(event) => setConfirmation({ id: machine.id, email: event.target.value })} />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button data-testid="machine-delete-submit" className="ui-btn-danger" type="submit">确认删除</button>
                  <button className={machineButton} type="button" onClick={() => setConfirmation(null)}>取消</button>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p data-testid="machine-delete-error" className="text-sm text-danger">{error}</p> : null}
      {stats ? <p data-testid="machine-stats">{stats}</p> : null}
    </div>
  );
}

function machineTone(state: string): string {
  const base = "inline-flex max-w-full rounded-full px-2 py-0.5 text-xs font-medium";
  if (state === "error") return `${base} bg-danger-bg text-danger`;
  if (state === "running" || state === "运行中") return `${base} bg-ok-bg text-ok`;
  return `${base} bg-hover text-muted`;
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
    <div className="work-page grid min-w-0 gap-6">
      <div className="work-head">
        <h1 className="text-2xl font-semibold">模板</h1>
      </div>
      <div className="grid max-w-3xl gap-6">
      {templates.isPending ? <p className="text-sm text-muted">正在加载模板…</p> : null}
      {templates.isError ? <p role="alert" className={alertClass}>{templates.error.message}</p> : null}
      {templates.data && templates.data.templates.length === 0 ? <p className="text-sm text-muted">没有模板</p> : null}
      <ul>
        {(templates.data?.templates ?? []).map((template) => (
          <li key={template.id} className="text-sm">
            <ScanRow
              tone="dark"
              subject={template.name}
              meta={template.description}
              actions={<button className="ui-btn-danger" type="button" onClick={() => remove.mutate(template.id)}>删除</button>}
            />
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
        <label className="grid gap-1 text-sm">名字 <input data-testid="template-name" className={field} value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label className="grid gap-1 text-sm">说明 <input className={field} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label className="grid gap-1 text-sm">指令 <textarea className={field} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
        <label className="grid gap-1 text-sm">默认模型 <input className={field} value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} /></label>
        <label className="grid gap-1 text-sm">欢迎消息 <input className={field} value={welcome} onChange={(event) => setWelcome(event.target.value)} /></label>
        <label className="grid gap-1 text-sm">初始记忆 <textarea className={field} placeholder="一行一条" value={initialMemories} onChange={(event) => setInitialMemories(event.target.value)} /></label>
        <button className={button} type="submit">添加模板</button>
      </form>
      </div>
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
      modelRate: { userPerMin: number; botPerMin: number };
      fsConfine: boolean;
      fsConfineConfig?: { enabled: boolean; allow: string[]; deny: string[] };
    }>("/api/admin/settings"),
  });
  const [prompt, setPrompt] = useState("");
  const [channel, setChannel] = useState("");
  const [saved, setSaved] = useState("");
  const [confineDraft, setConfineDraft] = useState<boolean | null>(null);
  const confineClient = useQueryClient();
  const confineOn = confineDraft ?? settings.data?.fsConfine ?? true;
  const [allowText, setAllowText] = useState<string | null>(null);
  const [denyText, setDenyText] = useState<string | null>(null);
  const [listError, setListError] = useState("");
  const [listSaved, setListSaved] = useState("");
  const allowValue = allowText ?? (settings.data?.fsConfineConfig?.allow ?? []).join("\n");
  const denyValue = denyText ?? (settings.data?.fsConfineConfig?.deny ?? []).join("\n");
  const saveConfine = useMutation({
    mutationFn: (enabled: boolean) => api("/api/admin/fs-confine", { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSuccess: async () => {
      setConfineDraft(null);
      setSaved("");
      await confineClient.invalidateQueries({ queryKey: ["admin-settings"] });
    },
  });
  const saveLists = useMutation({
    mutationFn: () => api("/api/admin/fs-confine", {
      method: "PUT",
      body: JSON.stringify({
        enabled: confineOn,
        allow: splitConfinePaths(allowValue),
        deny: splitConfinePaths(denyValue),
      }),
    }),
    onSuccess: async () => {
      setAllowText(null);
      setDenyText(null);
      setListError("");
      setListSaved("目录名单已保存");
      await confineClient.invalidateQueries({ queryKey: ["admin-settings"] });
    },
    onError: (error: Error) => {
      setListSaved("");
      setListError(error.message);
    },
  });
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
    <div className="work-page grid min-w-0 gap-4">
    <div className="work-head">
    <h1 className="text-2xl font-semibold">设置</h1>
    </div>
    <div className="grid max-w-4xl gap-4">
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate();
      }}
    >
      <section className="grid gap-3 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-medium">基础与目录限制</h2>
      {settings.data?.integration === "viate" ? (
        <label className="grid gap-1 text-sm">
          默认渠道
          <input data-testid="default-channel" className={field} value={channel} placeholder={settings.data.defaultChannel ?? ""} onChange={(event) => setChannel(event.target.value)} />
        </label>
      ) : (
        <p className="text-sm text-muted">当前未接 viate，没有默认渠道。</p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          data-testid="fs-confine"
          className="mt-1"
          type="checkbox"
          checked={confineOn}
          onChange={(event) => {
            const enabled = event.target.checked;
            setConfineDraft(enabled);
            saveConfine.mutate(enabled);
          }}
        />
        <span>目录限制默认开启，约束文件工具和 shell 工作目录。白名单留空时仅允许 /home/bot 和 /tmp；黑名单优先。关闭后仅受容器内 bot 用户的权限限制。shell 正文不按目录拦截。</span>
      </label>
      {confineOn ? (
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            允许目录白名单
            <textarea
              data-testid="fs-confine-allow"
              className={`${field} min-h-24`}
              value={allowValue}
              placeholder={"每行一个绝对路径。留空表示使用默认 /home/bot 和 /tmp"}
              onChange={(event) => {
                setAllowText(event.target.value);
                setListSaved("");
              }}
            />
          </label>
          <label className="grid gap-1 text-sm">
            拒绝目录黑名单
            <textarea
              data-testid="fs-confine-deny"
              className={`${field} min-h-24`}
              value={denyValue}
              placeholder="每行一个绝对路径，优先级高于白名单"
              onChange={(event) => {
                setDenyText(event.target.value);
                setListSaved("");
              }}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              data-testid="fs-confine-save"
              className={button}
              type="button"
              disabled={saveLists.isPending}
              onClick={() => saveLists.mutate()}
            >
              保存目录名单
            </button>
            {listSaved ? <p className="text-sm text-ok">{listSaved}</p> : null}
            {listError ? <p className="text-sm text-danger">{listError}</p> : null}
          </div>
        </div>
      ) : null}
      </section>
      <section className="grid gap-3 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-medium">平台提示词</h2>
      <label className="grid gap-1 text-sm">
        平台提示词（版本 {settings.data?.platformPrompt.version ?? ""}）
        <textarea data-testid="platform-prompt" className={`${field} min-h-40`} value={prompt} placeholder={settings.data?.platformPrompt.text ?? ""} onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <button className={button} type="submit">保存</button>
      {saved ? <p className="text-sm text-ok">{saved}</p> : null}
      </section>
    </form>
    <ModelLimits settings={settings.data} />
    </div>
    </div>
  );
}

function ModelLimits({ settings }: { settings: { modelLimits: Record<string, { contextTokens: number; maxTokens: number }>; modelDefaults: { contextTokens: number; maxTokens: number }; taskTokenBudget?: number; taskMaxSteps?: number; taskMaxDurationSec?: number; models: string[]; modelRate?: { userPerMin: number; botPerMin: number } } | undefined }) {
  const client = useQueryClient();
  const [model, setModel] = useState("");
  const [contextTokens, setContextTokens] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [budget, setBudget] = useState<string | null>(null);
  const [steps, setSteps] = useState<string | null>(null);
  const [duration, setDuration] = useState<string | null>(null);
  const [userRate, setUserRate] = useState<string | null>(null);
  const [botRate, setBotRate] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loadedBudget = settings?.taskTokenBudget;
  const loadedSteps = settings?.taskMaxSteps;
  const loadedDuration = settings?.taskMaxDurationSec;
  const draft = budget !== null ? budget : loadedBudget === undefined ? "" : String(loadedBudget);
  const stepsDraft = steps !== null ? steps : loadedSteps === undefined ? "" : String(loadedSteps);
  const durationDraft = duration !== null ? duration : loadedDuration === undefined ? "" : String(loadedDuration);
  const budgetReady = loadedBudget !== undefined && /^\d+$/.test(draft);
  const stepsReady = loadedSteps !== undefined && /^\d+$/.test(stepsDraft);
  const durationReady = loadedDuration !== undefined && /^\d+$/.test(durationDraft);
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
    <section data-testid="model-settings" className="grid gap-4">
      <div className="grid gap-3 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-medium">单任务上限与限流</h2>
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
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (!stepsReady) {
          setError("步数上限必须是非负整数");
          return;
        }
        void api("/api/admin/task-max-steps", { method: "PUT", body: JSON.stringify({ value: Number(stepsDraft) }) }).then(async () => {
          setError("");
          await client.invalidateQueries({ queryKey: ["admin-settings"] });
        }).catch((caught: Error) => setError(caught.message));
      }}>
        <label className="grid gap-1 text-sm">单任务步数上限（0 表示不限制）
          <input data-testid="task-max-steps" className={field} value={stepsDraft} onChange={(event) => setSteps(event.target.value)} />
        </label>
        <button className={button} type="submit" disabled={!stepsReady}>保存步数</button>
      </form>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (!durationReady) {
          setError("时长上限必须是非负整数");
          return;
        }
        void api("/api/admin/task-max-duration-sec", { method: "PUT", body: JSON.stringify({ value: Number(durationDraft) }) }).then(async () => {
          setError("");
          await client.invalidateQueries({ queryKey: ["admin-settings"] });
        }).catch((caught: Error) => setError(caught.message));
      }}>
        <label className="grid gap-1 text-sm">单任务时长上限秒（0 表示不限制，只计实际运行）
          <input data-testid="task-max-duration" className={field} value={durationDraft} onChange={(event) => setDuration(event.target.value)} />
        </label>
        <button className={button} type="submit" disabled={!durationReady}>保存时长</button>
      </form>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        const userText = userRate ?? (settings?.modelRate ? String(settings.modelRate.userPerMin) : "");
        const botText = botRate ?? (settings?.modelRate ? String(settings.modelRate.botPerMin) : "");
        const userPerMin = Number(userText);
        const botPerMin = Number(botText);
        if (!userText.trim() || !botText.trim() || !Number.isInteger(userPerMin) || userPerMin < 0 || !Number.isInteger(botPerMin) || botPerMin < 0) {
          setError("限流必须是非负整数，0 表示不限制");
          return;
        }
        void api("/api/admin/model-rate", { method: "PUT", body: JSON.stringify({ userPerMin, botPerMin }) }).then(async () => {
          setError("");
          await client.invalidateQueries({ queryKey: ["admin-settings"] });
        }).catch((caught: Error) => setError(caught.message));
      }}>
        <label className="grid gap-1 text-sm">每用户每分钟（0 表示不限制）
          <input data-testid="model-rate-user" className={field} value={userRate ?? (settings?.modelRate ? String(settings.modelRate.userPerMin) : "")} onChange={(event) => setUserRate(event.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">每 bot 每分钟（0 表示不限制）
          <input data-testid="model-rate-bot" className={field} value={botRate ?? (settings?.modelRate ? String(settings.modelRate.botPerMin) : "")} onChange={(event) => setBotRate(event.target.value)} />
        </label>
        <button className={button} type="submit" disabled={!settings?.modelRate}>保存限流</button>
      </form>
      </div>
      <div className="grid gap-3 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-medium">模型上下文覆盖</h2>
        <p className="text-sm text-muted">未单独设置时沿用环境默认值：上下文 {defaults?.contextTokens ?? ""}，单次输出 {defaults?.maxTokens ?? ""}。只影响之后开始的任务，且输出不能超过上下文。</p>
      <ul className="grid gap-1 text-sm">
        {Object.entries(settings?.modelLimits ?? {}).map(([name, limit]) => (
          <li key={name}>{name}：上下文 {limit.contextTokens}，输出 {limit.maxTokens}</li>
        ))}
        {Object.keys(settings?.modelLimits ?? {}).length === 0 ? <li className="text-muted">还没有单独设置</li> : null}
      </ul>
      <form className="grid gap-2 md:grid-cols-4" onSubmit={(event) => { event.preventDefault(); save.mutate(false); }}>
        <label className="grid gap-1 text-sm">模型 ID <input data-testid="model-limit-name" list="known-models" className={field} value={model} onChange={(event) => setModel(event.target.value)} required /></label>
        <datalist id="known-models">{(settings?.models ?? []).map((name) => <option key={name} value={name} />)}</datalist>
        <label className="grid gap-1 text-sm">上下文窗口 <input data-testid="model-context" className={field} value={contextTokens} onChange={(event) => setContextTokens(event.target.value)} required /></label>
        <label className="grid gap-1 text-sm">单次输出上限 <input data-testid="model-output" className={field} value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} required /></label>
        <button className={button} type="submit">保存</button>
      </form>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </section>
  );
}
