import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api } from "./api.js";
import { ScanRow } from "./scan-row.js";

export interface Approval {
  id: string;
  taskId: string;
  tool: string;
  args: unknown;
  summary?: string;
}

interface InstallCard {
  source: "catalog" | "remote" | "package";
  title: string;
  command: string;
  installLine?: string;
  config: Array<{ key: string; display: string }>;
  reason: string;
  riskyTools: string[];
  runsInstallScript: boolean;
}

interface PublishCard {
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

const primaryButton = "rounded-full bg-neutral-900 px-3 py-1.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-50";
const quietButton = "rounded-full px-3 py-1.5 text-sm text-neutral-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-50";
const alertClass = "rounded-md bg-red-100 px-3 py-2 text-sm text-red-900";
const detailClass = "grid min-w-0 gap-1 [overflow-wrap:anywhere]";
const preClass = "max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-2 text-xs";

export function ApprovalList({ taskId }: { taskId?: string }) {
  const client = useQueryClient();
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: () => api<{ approvals: Approval[] }>("/api/approvals"), refetchInterval: 3000 });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "allow" | "deny" }) => api(`/api/approvals/${encodeURIComponent(id)}/decide`, { method: "POST", body: JSON.stringify({ decision }) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["approvals"] });
      void client.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const items = (approvals.data?.approvals ?? []).filter((item) => !taskId || item.taskId === taskId);
  return <>
    {approvals.isError ? <p role="alert" className={alertClass}>无法加载审批</p> : null}
    {decide.isError ? <p role="alert" className={alertClass}>{decide.error.message}</p> : null}
    {approvals.isPending ? <p className="text-sm text-neutral-500">正在加载待批准操作…</p> : null}
    {approvals.data && items.length === 0 ? <p className="text-sm text-neutral-500">{taskId ? "这条任务没有待批准操作" : "没有待批准操作"}</p> : null}
    <div className="grid gap-3">
      {items.map((item) => (
        <ApprovalCard
          key={item.id}
          item={item}
          pending={decide.isPending}
          onDecide={(decision) => decide.mutate({ id: item.id, decision })}
        />
      ))}
    </div>
  </>;
}

export function ApprovalCard({ item, pending, onDecide }: { item: Approval; pending: boolean; onDecide: (decision: "allow" | "deny") => void }) {
  const view = approvalView(item);
  const allowDisabled = pending || (item.tool === "install_mcp" && !installCard(item.summary)) || (item.tool === "request_app_publish" && !publishCard(item.summary));
  const grantClass = view.details
    ? "col-span-2 col-start-1 row-start-3 min-w-0 font-medium [overflow-wrap:anywhere] *:min-w-0 *:[overflow-wrap:anywhere] [&_*]:min-w-0 [&_*]:[overflow-wrap:anywhere] @min-[40rem]:col-span-1"
    : "col-span-2 col-start-1 row-start-2 min-w-0 font-medium [overflow-wrap:anywhere] *:min-w-0 *:[overflow-wrap:anywhere] [&_*]:min-w-0 [&_*]:[overflow-wrap:anywhere] @min-[40rem]:col-span-1";
  const actionClass = view.details
    ? "col-span-2 col-start-1 row-start-4 flex min-w-0 flex-wrap items-center gap-2 @min-[40rem]:col-span-1 @min-[40rem]:col-start-3 @min-[40rem]:row-start-3 @min-[40rem]:justify-end"
    : "col-span-2 col-start-1 row-start-3 flex min-w-0 flex-wrap items-center gap-2 @min-[40rem]:col-span-1 @min-[40rem]:col-start-3 @min-[40rem]:row-start-2 @min-[40rem]:justify-end";
  return (
    <article data-testid="approval-item" className="@container min-w-0 rounded-md border border-neutral-300 bg-white p-3 text-sm text-neutral-900">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem] items-start gap-x-3 gap-y-2 @min-[40rem]:grid-cols-[minmax(0,1fr)_5.5rem_minmax(0,18rem)]">
        <h3 className="col-start-1 row-start-1 min-w-0 font-medium [overflow-wrap:anywhere]" data-testid={item.tool === "install_mcp" && installCard(item.summary) ? "install-title" : undefined}>{view.title}</h3>
        <p className="col-start-2 row-start-1 text-right font-medium text-amber-800">待批准</p>
        {view.details ? <div className="col-span-2 col-start-1 row-start-2 min-w-0 text-neutral-700 @min-[40rem]:col-span-1">{view.details}</div> : null}
        <div className={grantClass} data-testid="approval-grant">{view.grant}</div>
        <div className={actionClass}>
          <button type="button" className={primaryButton} disabled={allowDisabled} data-testid={`allow-approval-${item.id}`} onClick={() => onDecide("allow")}>允许</button>
          <button type="button" className={secondaryButton} disabled={pending} data-testid={`deny-approval-${item.id}`} onClick={() => onDecide("deny")}>拒绝</button>
          {canRemember(item.tool) ? <RememberRule id={item.id} /> : null}
        </div>
      </div>
    </article>
  );
}

function approvalView(item: Approval): { title: string; details: ReactNode; grant: ReactNode } {
  if (item.tool === "install_mcp") return installView(item);
  if (item.tool === "request_app_publish") return publishView(item);
  if (item.tool === "update_bot_profile") return profileView(item);
  if (item.tool === "propose_approval_rule") return ruleView(item);
  return {
    title: item.tool,
    details: <pre className={preClass}>{JSON.stringify(item.args, null, 2)}</pre>,
    grant: <p>批准后将执行工具 {item.tool}。</p>,
  };
}

function installView(item: Approval): { title: string; details: ReactNode; grant: ReactNode } {
  const card = installCard(item.summary);
  if (!card) {
    return {
      title: "安装 MCP",
      details: null,
      grant: <p role="alert">安装详情不完整，不能批准。请拒绝后重新申请。</p>,
    };
  }
  const source = card.source === "catalog" ? "目录应用" : card.source === "remote" ? "远程 MCP" : "包";
  return {
    title: card.title,
    details: (
      <div className={detailClass}>
        <p>安装 MCP · {source}</p>
        {card.installLine ? <p>安装：{card.installLine}</p> : null}
        <p>启动：{card.command}</p>
        {card.config.length > 0 ? (
          <ul className="grid gap-1">
            {card.config.map((entry) => <li key={entry.key}>{entry.key}：{entry.display}</li>)}
          </ul>
        ) : null}
        <p>原因：{card.reason}</p>
      </div>
    ),
    grant: (
      <div className="grid min-w-0 gap-1 [overflow-wrap:anywhere]">
        {card.riskyTools.length > 0 ? <p>目录标记的风险工具：{card.riskyTools.join("、")}</p> : null}
        {card.runsInstallScript ? <p>会在你的机器上运行安装脚本。</p> : null}
        <p>批准后，该 MCP 会安装到你的机器上，并对你的所有 bot 启用。</p>
      </div>
    ),
  };
}

function installCard(summary: string | undefined): InstallCard | undefined {
  if (!summary) return undefined;
  try {
    const parsed = JSON.parse(summary) as Partial<InstallCard>;
    if (parsed.source !== "catalog" && parsed.source !== "remote" && parsed.source !== "package") return undefined;
    if (typeof parsed.title !== "string" || typeof parsed.command !== "string" || typeof parsed.reason !== "string") return undefined;
    if (!Array.isArray(parsed.config) || !Array.isArray(parsed.riskyTools)) return undefined;
    return {
      source: parsed.source,
      title: parsed.title,
      command: parsed.command,
      ...(typeof parsed.installLine === "string" ? { installLine: parsed.installLine } : {}),
      config: parsed.config.filter((entry): entry is { key: string; display: string } => Boolean(entry) && typeof entry.key === "string" && typeof entry.display === "string"),
      reason: parsed.reason,
      riskyTools: parsed.riskyTools.filter((name): name is string => typeof name === "string"),
      runsInstallScript: parsed.runsInstallScript === true,
    };
  } catch {
    return undefined;
  }
}

function publishView(item: Approval): { title: string; details: ReactNode; grant: ReactNode } {
  const card = publishCard(item.summary);
  if (!card) {
    return {
      title: "申请公开应用",
      details: null,
      grant: <p role="alert">发布详情不完整，不能批准。请拒绝后重新申请。</p>,
    };
  }
  return {
    title: "申请公开应用",
    details: (
      <div className={detailClass} data-testid="publish-approval">
        <p>{card.name} {card.version}</p>
        <p>SHA-256 {card.sha256}</p>
        <p>类型：{card.kinds.join("、") || "未识别"}</p>
        <p>文件数：{card.files}</p>
        <p className="whitespace-pre-wrap">MCP：{card.command}</p>
        <p>定时任务：{card.routines}</p>
        <p className="whitespace-pre-wrap">说明：{card.note}</p>
      </div>
    ),
    grant: <p>{card.warning}</p>,
  };
}

function publishCard(summary: string | undefined): PublishCard | undefined {
  if (!summary) return undefined;
  try {
    const parsed = JSON.parse(summary) as Partial<PublishCard>;
    if (parsed.kind !== "app_publish") return undefined;
    if (typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.sha256)) return undefined;
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string" || typeof parsed.command !== "string" || typeof parsed.note !== "string" || typeof parsed.warning !== "string") return undefined;
    if (!parsed.warning.includes("批准后会提交给管理员") || !parsed.warning.includes("所有用户可见可安装")) return undefined;
    if (typeof parsed.files !== "number" || typeof parsed.routines !== "number" || !Array.isArray(parsed.kinds)) return undefined;
    return {
      kind: "app_publish",
      name: parsed.name,
      version: parsed.version,
      sha256: parsed.sha256,
      kinds: parsed.kinds.filter((item): item is string => typeof item === "string"),
      files: parsed.files,
      command: parsed.command,
      routines: parsed.routines,
      note: parsed.note,
      warning: parsed.warning,
    };
  } catch {
    return undefined;
  }
}

function profileView(item: Approval): { title: string; details: ReactNode; grant: ReactNode } {
  const card = profileCard(item.summary);
  if (!card) return { title: "修改 bot 资料", details: null, grant: <p>变更详情不完整。</p> };
  return {
    title: "修改 bot 资料",
    details: (
      <div data-testid="profile-diff" className={detailClass}>
        {card.changes.map((change) => (
          <div key={change.field} className="grid gap-1">
            <p className="font-medium">{change.field}</p>
            {change.diff ? <pre className={preClass}>{change.diff}</pre> : <p>{change.before ?? ""} → {change.after ?? ""}</p>}
          </div>
        ))}
      </div>
    ),
    grant: <p>批准后将按上面的差异修改这个 bot 的资料。</p>,
  };
}

function profileCard(summary: string | undefined): { changes: Array<{ field: string; before?: string; after?: string; diff?: string }> } | undefined {
  if (!summary) return undefined;
  try {
    const parsed = JSON.parse(summary) as { kind?: string; changes?: unknown };
    if (parsed.kind !== "bot_profile" || !Array.isArray(parsed.changes)) return undefined;
    return { changes: parsed.changes.filter((item): item is { field: string; before?: string; after?: string; diff?: string } => Boolean(item) && typeof (item as { field?: unknown }).field === "string") };
  } catch {
    return undefined;
  }
}

function ruleView(item: Approval): { title: string; details: ReactNode; grant: ReactNode } {
  const card = ruleCard(item.summary);
  const body = card ?? item.args;
  return {
    title: "提议自动审批规则",
    details: <pre className={preClass} data-testid="rule-proposal">{JSON.stringify(body, null, 2)}</pre>,
    grant: <p>批准后规则生效。这次批准不能被其他规则、始终允许或全部免审批跳过。</p>,
  };
}

function ruleCard(summary: string | undefined): { kind: string; category: unknown; match: unknown; expiresAt: string | null } | undefined {
  if (!summary) return undefined;
  try {
    const parsed = JSON.parse(summary) as { kind?: string; category?: unknown; match?: unknown; expiresAt?: unknown };
    if (parsed.kind !== "approval_rule") return undefined;
    return { kind: parsed.kind, category: parsed.category, match: parsed.match, expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null };
  } catch {
    return undefined;
  }
}

function canRemember(tool: string): boolean {
  return tool === "shell_exec" || tool === "fs_write" || tool.startsWith("browser_");
}

function RememberRule({ id }: { id: string }) {
  const client = useQueryClient();
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () => api(`/api/approvals/${encodeURIComponent(id)}/rule`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      setDone(true);
      void client.invalidateQueries({ queryKey: ["approval-rules"] });
    },
  });
  return <button type="button" data-testid="rule-from-approval" className={secondaryButton} disabled={save.isPending || done} onClick={() => save.mutate()}>{done ? "已记住" : "以后对此自动批准"}</button>;
}

interface RuleRow {
  id: string;
  category: string;
  match: unknown;
  expiresAt: string | null;
  hitCount: number;
  lastHitAt: string | null;
}

export function ApprovalRules({ botId }: { botId: string }) {
  const client = useQueryClient();
  const rules = useQuery({ queryKey: ["approval-rules", botId], queryFn: () => api<{ rules: RuleRow[] }>(`/api/bots/${botId}/approval-rules`) });
  const settings = useQuery({ queryKey: ["approval-settings", botId], queryFn: () => api<{ approveNone: boolean }>(`/api/bots/${botId}/approval-settings`) });
  const [category, setCategory] = useState("shell");
  const [value, setValue] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState("");
  const toggle = useMutation({
    mutationFn: (approveNone: boolean) => api(`/api/bots/${botId}/approval-settings`, { method: "PUT", body: JSON.stringify({ approveNone }) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["approval-settings", botId] }); },
  });
  const create = useMutation({
    mutationFn: () => api(`/api/bots/${botId}/approval-rules`, {
      method: "POST",
      body: JSON.stringify({ category, match: matchFor(category, value), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) }),
    }),
    onSuccess: async () => {
      setError("");
      setValue("");
      await client.invalidateQueries({ queryKey: ["approval-rules", botId] });
    },
    onError: (caught: Error) => setError(caught.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/bots/${botId}/approval-rules/${id}`, { method: "DELETE" }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["approval-rules", botId] }); },
  });
  return (
    <section data-testid="approval-rules" className="mt-6">
      <h3 className="text-xs text-neutral-500">自动审批</h3>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input data-testid="approve-none" className="size-4 accent-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900" type="checkbox" checked={settings.data?.approveNone === true} onChange={(event) => toggle.mutate(event.target.checked)} />
        全部免审批
      </label>
      <p data-testid="approve-none-risk" className="mt-2 text-sm text-amber-800">网页中的提示注入可能让 bot 在无人确认的情况下安装 MCP 或永久改写自己的提示词。</p>
      {rules.isPending ? <p className="mt-2 text-sm text-neutral-500">正在加载规则…</p> : null}
      {rules.isError ? <p role="alert" className={`mt-2 ${alertClass}`}>{rules.error.message}</p> : null}
      <ul className="mt-2">
        {(rules.data?.rules ?? []).map((rule) => (
          <li key={rule.id}>
            <ScanRow
              subject={`${rule.category} ${JSON.stringify(rule.match)}`}
              meta={`命中 ${rule.hitCount}${rule.lastHitAt ? ` · 最近 ${rule.lastHitAt}` : ""}${rule.expiresAt ? ` · ${rule.expiresAt}` : ""}`}
              status={rule.expiresAt ? "限时" : "永久"}
              actions={<button type="button" className={quietButton} onClick={() => remove.mutate(rule.id)}>删除</button>}
            />
          </li>
        ))}
        {rules.data && rules.data.rules.length === 0 ? <li className="py-2 text-sm text-neutral-400">还没有规则</li> : null}
      </ul>
      <form className="mt-3 grid gap-2" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <select className="rounded-xl border border-neutral-200 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="shell">命令前缀</option>
          <option value="browser">网页地址</option>
          <option value="fs_write">写入路径</option>
          <option value="mcp">应用工具</option>
        </select>
        <input className="rounded-xl border border-neutral-200 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900" value={value} placeholder={category === "mcp" ? "应用名 工具名（工具名可空）" : "匹配内容"} onChange={(event) => setValue(event.target.value)} />
        <label className="grid gap-1 text-xs text-neutral-500">过期时间（可选，留空则永久）
          <input data-testid="rule-expires" className="rounded-xl border border-neutral-200 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </label>
        <button className={primaryButton} type="submit">添加规则</button>
      </form>
      {error ? <p role="alert" className={`mt-2 ${alertClass}`}>{error}</p> : null}
    </section>
  );
}

function matchFor(category: string, value: string): unknown {
  if (category === "shell") return { prefix: value };
  if (category === "browser") return { origin: value };
  if (category === "fs_write") return { pathPrefix: value };
  const [app, tool] = value.split(/\s+/, 2);
  return { app, ...(tool ? { tool } : {}) };
}

export function Approvals() {
  return <section className="mx-auto grid w-full max-w-3xl gap-3 px-4 py-6 sm:px-6">
    <h1 className="text-lg font-medium">待批准操作</h1>
    <ApprovalList />
  </section>;
}
