import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";

interface Approval {
  id: string;
  taskId: string;
  tool: string;
  args: unknown;
}

export function Approvals() {
  const client = useQueryClient();
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: () => api<{ approvals: Approval[] }>("/api/approvals"), refetchInterval: 3000 });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "allow" | "deny" }) => api(`/api/approvals/${encodeURIComponent(id)}/decide`, { method: "POST", body: JSON.stringify({ decision }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["approvals"] }),
  });
  return <section className="grid gap-4">
    <h2 className="text-lg font-semibold">待审批操作</h2>
    {approvals.isError ? <p role="alert">无法加载审批</p> : null}
    {decide.isError ? <p role="alert">{decide.error.message}</p> : null}
    {approvals.data?.approvals.length === 0 ? <p>没有待审批操作</p> : null}
    {approvals.data?.approvals.map((item) => <article key={item.id} className="grid gap-3 rounded border border-neutral-700 p-4">
      <h3 className="font-medium">{item.tool}</h3>
      <pre className="overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(item.args, null, 2)}</pre>
      <div className="flex gap-2">
        <button className="rounded bg-white px-3 py-2 text-neutral-950 disabled:opacity-50" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, decision: "allow" })}>允许</button>
        <button className="rounded border border-neutral-600 px-3 py-2 disabled:opacity-50" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, decision: "deny" })}>拒绝</button>
      </div>
    </article>)}
  </section>;
}
