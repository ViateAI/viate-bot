import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.js";

type Routine = { id: string; cron: string; timezone: string; prompt: string; state: string; enabled: number; nextRunAt: string | null };
type Run = { id: string; scheduledAt: string; state: string; error: string | null; taskId: string | null };

export function Routines({ botId }: { botId: string }) {
  const client = useQueryClient();
  const [history, setHistory] = useState<string | null>(null);
  const routines = useQuery({ queryKey: ["routines", botId], queryFn: () => api<{ routines: Routine[] }>(`/api/bots/${encodeURIComponent(botId)}/routines`) });
  const runs = useQuery({ queryKey: ["routine-runs", history], enabled: history !== null, queryFn: () => api<{ runs: Run[] }>(`/api/routines/${encodeURIComponent(history!)}/runs`) });
  const change = useMutation({
    mutationFn: ({ id, action, paused }: { id: string; action: "confirm" | "pause" | "run" | "delete"; paused?: boolean }) => api(`/api/routines/${encodeURIComponent(id)}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST", ...(action === "pause" ? { body: JSON.stringify({ paused }) } : {}) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["routines", botId] }); await client.invalidateQueries({ queryKey: ["routine-runs"] }); },
  });
  return <section className="grid gap-3">
    <h2 className="px-1 text-xs font-normal text-neutral-500">定时任务</h2>
    {routines.isLoading && <p>加载中…</p>}
    {routines.error && <p role="alert">{routines.error.message}</p>}
    {change.error && <p role="alert">{change.error.message}</p>}
    {routines.data?.routines.length === 0 && <p>暂无定时任务</p>}
    <ul className="grid gap-2">{routines.data?.routines.map((routine) => <li key={routine.id} className="grid gap-2 rounded-2xl bg-[#f6f6f6] px-3 py-3 text-sm">
      <p className="whitespace-pre-wrap">{routine.prompt}</p>
      <p className="text-neutral-500">{routine.cron} · {routine.timezone} · {routine.state === "draft" ? "待确认" : routine.enabled ? "运行中" : "已暂停"}</p>
      {routine.nextRunAt && <p className="text-neutral-500">下次运行：{new Date(routine.nextRunAt).toLocaleString()}</p>}
      <div className="flex flex-wrap gap-2">
        {routine.state === "draft" ? <button type="button" className="rounded-full bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-40" disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "confirm" })}>确认</button> : <>
          <button type="button" className="rounded-full bg-white px-3 py-1.5 ring-1 ring-black/10 disabled:opacity-40" disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "pause", paused: !!routine.enabled })}>{routine.enabled ? "暂停" : "恢复"}</button>
          <button type="button" className="rounded-full bg-white px-3 py-1.5 ring-1 ring-black/10 disabled:opacity-40" disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "run" })}>运行一次</button>
        </>}
        <button type="button" className="rounded-full bg-white px-3 py-1.5 ring-1 ring-black/10" onClick={() => setHistory(history === routine.id ? null : routine.id)}>运行记录</button>
        <button type="button" className="rounded-full px-3 py-1.5 text-neutral-500 disabled:opacity-40" disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "delete" })}>删除</button>
      </div>
      {history === routine.id && <div className="text-neutral-500">{runs.isLoading ? "加载中…" : runs.error ? runs.error.message : <ul>{runs.data?.runs.map((run) => <li key={run.id}>{new Date(run.scheduledAt).toLocaleString()} · {run.state}{run.error ? ` · ${run.error}` : ""}</li>)}</ul>}</div>}
    </li>)}</ul>
  </section>;
}
