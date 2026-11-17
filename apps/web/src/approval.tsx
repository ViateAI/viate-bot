import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
      {item.tool === "install_mcp" ? <InstallApproval item={item} /> : <>
        <h3 className="font-medium">{item.tool}</h3>
        <pre className="overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(item.args, null, 2)}</pre>
      </>}
      <div className="flex gap-2">
        <button className="rounded-full bg-neutral-900 px-3 py-2 text-white disabled:opacity-50" disabled={decide.isPending || (item.tool === "install_mcp" && !installCard(item.summary))} data-testid={`allow-approval-${item.id}`} onClick={() => decide.mutate({ id: item.id, decision: "allow" })}>允许</button>
        <button className="rounded-full border border-neutral-400 px-3 py-2 disabled:opacity-50" disabled={decide.isPending} data-testid={`deny-approval-${item.id}`} onClick={() => decide.mutate({ id: item.id, decision: "deny" })}>拒绝</button>
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

export function Approvals() {
  return <section className="mx-auto grid w-full max-w-3xl gap-4 px-6 py-10">
    <h1 className="text-2xl font-semibold">待批准操作</h1>
    <ApprovalList />
  </section>;
}
