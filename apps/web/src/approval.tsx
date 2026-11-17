import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";

interface Approval {
  id: string;
  taskId: string;
  tool: string;
  args: unknown;
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
    {items.map((item) => <article key={item.id} className="grid gap-3 rounded-2xl border border-neutral-300 p-4" data-testid="approval-item">
      <h3 className="font-medium">{item.tool}</h3>
      <pre className="overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(item.args, null, 2)}</pre>
      <div className="flex gap-2">
        <button className="rounded-full bg-neutral-900 px-3 py-2 text-white disabled:opacity-50" disabled={decide.isPending} data-testid={`allow-approval-${item.id}`} onClick={() => decide.mutate({ id: item.id, decision: "allow" })}>允许</button>
        <button className="rounded-full border border-neutral-400 px-3 py-2 disabled:opacity-50" disabled={decide.isPending} data-testid={`deny-approval-${item.id}`} onClick={() => decide.mutate({ id: item.id, decision: "deny" })}>拒绝</button>
      </div>
    </article>)}
  </>;
}

export function Approvals() {
  return <section className="mx-auto grid w-full max-w-3xl gap-4 px-6 py-10">
    <h1 className="text-2xl font-semibold">待批准操作</h1>
    <ApprovalList />
  </section>;
}
