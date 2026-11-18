import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.js";

interface Approval {
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
    {approvals.isError ? <p role="alert">无法加载审批</p> : null}
    {decide.isError ? <p role="alert">{decide.error.message}</p> : null}
    {approvals.isPending ? <p className="text-sm text-neutral-400">正在加载待批准操作…</p> : null}
    {approvals.data && items.length === 0 ? <p>{taskId ? "这条任务没有待批准操作" : "没有待批准操作"}</p> : null}
    {items.map((item) => <article key={item.id} className="grid min-w-0 gap-3 rounded-2xl border border-neutral-300 bg-white p-4" data-testid="approval-item">
      {item.tool === "install_mcp" ? <InstallApproval item={item} /> : item.tool === "update_bot_profile" ? <ProfileApproval item={item} /> : item.tool === "propose_approval_rule" ? <RuleProposal item={item} /> : <>
        <h3 className="font-medium">{item.tool}</h3>
        <pre className="overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(item.args, null, 2)}</pre>
      </>}
      <div className="flex gap-2">
        <button className="rounded-full bg-neutral-900 px-3 py-2 text-white disabled:opacity-50" disabled={decide.isPending || (item.tool === "install_mcp" && !installCard(item.summary))} data-testid={`allow-approval-${item.id}`} onClick={() => decide.mutate({ id: item.id, decision: "allow" })}>允许</button>
        <button className="rounded-full border border-neutral-400 px-3 py-2 disabled:opacity-50" disabled={decide.isPending} data-testid={`deny-approval-${item.id}`} onClick={() => decide.mutate({ id: item.id, decision: "deny" })}>拒绝</button>
        {canRemember(item.tool) ? <RememberRule id={item.id} /> : null}
      </div>
    </article>)}
  </>;
}

function InstallApproval({ item }: { item: Approval }) {
  const card = installCard(item.summary);
  if (!card) {
    return <>
      <h3 className="font-medium">安装 MCP</h3>
      <p className="text-sm" role="alert">安装详情不完整，不能批准。请拒绝后重新申请。</p>
    </>;
  }
  const source = card.source === "catalog" ? "目录应用" : card.source === "remote" ? "远程 MCP" : "包";
  return <>
    <h3 className="font-medium">安装 MCP · {source}</h3>
    <p className="break-all text-sm" data-testid="install-title">{card.title}</p>
    {card.installLine ? <p className="break-all text-sm">安装：{card.installLine}</p> : null}
    <p className="break-all text-sm">启动：{card.command}</p>
    {card.config.length > 0 ? (
      <ul className="grid gap-1 text-sm">
        {card.config.map((entry) => <li key={entry.key} className="break-all">{entry.key}：{entry.display}</li>)}
      </ul>
    ) : null}
    {card.riskyTools.length > 0 ? <p className="text-sm">目录标记的风险工具：{card.riskyTools.join("、")}</p> : null}
    <p className="text-sm">原因：{card.reason}</p>
    {card.runsInstallScript ? <p className="text-sm">会在你的机器上运行安装脚本。</p> : null}
    <p className="text-sm font-medium">批准后，该 MCP 会安装到你的机器上，并对你的所有 bot 启用。</p>
  </>;
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

function ProfileApproval({ item }: { item: Approval }) {
  const card = profileCard(item.summary);
  if (!card) return <><h3 className="font-medium">修改 bot 资料</h3><p className="text-sm">变更详情不完整。</p></>;
  return <div data-testid="profile-diff">
    <h3 className="font-medium">修改 bot 资料</h3>
    {card.changes.map((change) => (
      <div key={change.field} className="grid gap-1 text-sm">
        <p className="font-medium">{change.field}</p>
        {change.diff ? <pre className="overflow-auto whitespace-pre-wrap break-all">{change.diff}</pre> : <p className="break-all">{change.before ?? ""} → {change.after ?? ""}</p>}
      </div>
    ))}
  </div>;
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

function RuleProposal({ item }: { item: Approval }) {
  const card = ruleCard(item.summary);
  const body = card ?? item.args;
  return <div data-testid="rule-proposal">
    <h3 className="font-medium">提议自动审批规则</h3>
    <pre className="overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(body, null, 2)}</pre>
    <p className="text-sm">批准后规则生效。这次批准不能被其他规则、始终允许或全部免审批跳过。</p>
  </div>;
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
  return <button type="button" data-testid="rule-from-approval" className="rounded-full border border-neutral-400 px-3 py-2 disabled:opacity-50" disabled={save.isPending || done} onClick={() => save.mutate()}>{done ? "已记住" : "以后对此自动批准"}</button>;
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
        <input data-testid="approve-none" type="checkbox" checked={settings.data?.approveNone === true} onChange={(event) => toggle.mutate(event.target.checked)} />
        全部免审批
      </label>
      <p data-testid="approve-none-risk" className="mt-2 text-sm text-amber-800">网页中的提示注入可能让 bot 在无人确认的情况下安装 MCP 或永久改写自己的提示词。</p>
      <ul className="mt-2 grid gap-2">
        {(rules.data?.rules ?? []).map((rule) => (
          <li key={rule.id} className="flex items-start justify-between gap-3 rounded-2xl bg-[#f6f6f6] px-3 py-2 text-sm">
            <span className="break-all">{rule.category} {JSON.stringify(rule.match)} · 命中 {rule.hitCount}{rule.lastHitAt ? ` · 最近 ${rule.lastHitAt}` : ""}{rule.expiresAt ? ` · ${rule.expiresAt}` : " · 永久"}</span>
            <button type="button" className="shrink-0 text-neutral-500" onClick={() => remove.mutate(rule.id)}>删除</button>
          </li>
        ))}
        {rules.data && rules.data.rules.length === 0 ? <li className="text-sm text-neutral-400">还没有规则</li> : null}
      </ul>
      <form className="mt-3 grid gap-2" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <select className="rounded-xl border border-neutral-200 px-3 py-2 text-sm" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="shell">命令前缀</option>
          <option value="browser">网页地址</option>
          <option value="fs_write">写入路径</option>
          <option value="mcp">应用工具</option>
        </select>
        <input className="rounded-xl border border-neutral-200 px-3 py-2 text-sm" value={value} placeholder={category === "mcp" ? "应用名 工具名（工具名可空）" : "匹配内容"} onChange={(event) => setValue(event.target.value)} />
        <label className="grid gap-1 text-xs text-neutral-500">过期时间（可选，留空则永久）
          <input data-testid="rule-expires" className="rounded-xl border border-neutral-200 px-3 py-2 text-sm" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </label>
        <button className="rounded-full bg-neutral-900 px-3 py-2 text-sm text-white" type="submit">添加规则</button>
      </form>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
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
  return <section className="mx-auto grid w-full max-w-3xl gap-4 px-6 py-10">
    <h1 className="text-2xl font-semibold">待批准操作</h1>
    <ApprovalList />
  </section>;
}
