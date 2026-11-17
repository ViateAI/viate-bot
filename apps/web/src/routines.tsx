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
  return <section className="grid gap-4">
    <h2 className="text-xl font-semibold">定时任务</h2>
    {routines.isLoading && <p>加载中…</p>}
    {routines.error && <p role="alert">{routines.error.message}</p>}
    {change.error && <p role="alert">{change.error.message}</p>}
    {routines.data?.routines.length === 0 && <p>暂无定时任务</p>}
    <ul className="grid gap-3">{routines.data?.routines.map((routine) => <li key={routine.id} className="grid gap-2 rounded-lg border border-neutral-700 p-4">
      <p className="whitespace-pre-wrap">{routine.prompt}</p>
      <p>{routine.cron} · {routine.timezone} · {routine.state === "draft" ? "待确认" : routine.enabled ? "运行中" : "已暂停"}</p>
      {routine.nextRunAt && <p>下次运行：{new Date(routine.nextRunAt).toLocaleString()}</p>}
      <div className="flex flex-wrap gap-3">
        {routine.state === "draft" ? <button disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "confirm" })}>确认</button> : <>
          <button disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "pause", paused: !!routine.enabled })}>{routine.enabled ? "暂停" : "恢复"}</button>
          <button disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "run" })}>运行一次</button>
        </>}
        <button onClick={() => setHistory(history === routine.id ? null : routine.id)}>运行记录</button>
        <button disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "delete" })}>删除</button>
      </div>
      {history === routine.id && <div>{runs.isLoading ? "加载中…" : runs.error ? runs.error.message : <ul>{runs.data?.runs.map((run) => <li key={run.id}>{new Date(run.scheduledAt).toLocaleString()} · {run.state}{run.error ? ` · ${run.error}` : ""}</li>)}</ul>}</div>}
    </li>)}</ul>
  </section>;
}
