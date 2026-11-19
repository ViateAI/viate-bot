import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.js";
import { ScanRow } from "./scan-row.js";

type Routine = { id: string; cron: string; timezone: string; prompt: string; state: string; enabled: number; nextRunAt: string | null };
type Run = { id: string; scheduledAt: string; state: string; error: string | null; taskId: string | null };

const primaryButton = "rounded-full bg-neutral-900 px-3 py-1.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton = "rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-50";
const dangerButton = "rounded-full px-3 py-1.5 text-sm text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-50";
const alertClass = "rounded-md bg-red-100 px-3 py-2 text-sm text-red-900";

function statusText(routine: Routine): string {
  if (routine.state === "draft") return "待确认";
  return routine.enabled ? "运行中" : "已暂停";
}

function statusClass(routine: Routine): string {
  if (routine.state === "draft") return "font-medium text-amber-800";
  return routine.enabled ? "font-medium text-emerald-800" : "text-neutral-500";
}

export function Routines({ botId }: { botId: string }) {
  const client = useQueryClient();
  const [history, setHistory] = useState<string | null>(null);
  const routines = useQuery({ queryKey: ["routines", botId], queryFn: () => api<{ routines: Routine[] }>(`/api/bots/${encodeURIComponent(botId)}/routines`) });
  const runs = useQuery({ queryKey: ["routine-runs", history], enabled: history !== null, queryFn: () => api<{ runs: Run[] }>(`/api/routines/${encodeURIComponent(history!)}/runs`) });
  const change = useMutation({
    mutationFn: ({ id, action, paused }: { id: string; action: "confirm" | "pause" | "run" | "delete"; paused?: boolean }) => api(`/api/routines/${encodeURIComponent(id)}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST", ...(action === "pause" ? { body: JSON.stringify({ paused }) } : {}) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["routines", botId] }); await client.invalidateQueries({ queryKey: ["routine-runs"] }); },
  });
  return <section className="grid min-w-0 gap-3">
    <h2 className="px-1 text-xs font-normal text-neutral-500">定时任务</h2>
    {routines.isLoading && <p className="text-sm text-neutral-500">加载中…</p>}
    {routines.error && <p role="alert" className={alertClass}>{routines.error.message}</p>}
    {change.error && <p role="alert" className={alertClass}>{change.error.message}</p>}
    {routines.data?.routines.length === 0 && <p className="text-sm text-neutral-500">暂无定时任务</p>}
    <ul>
      {routines.data?.routines.map((routine) => <li key={routine.id} className="min-w-0">
        <ScanRow
          subject={routine.prompt}
          meta={<>{routine.cron} · {routine.timezone}{routine.nextRunAt ? <span className="mt-0.5 block">下次运行：{new Date(routine.nextRunAt).toLocaleString()}</span> : null}</>}
          status={<span className={statusClass(routine)}>{statusText(routine)}</span>}
          actions={<>
            {routine.state === "draft" ? <button type="button" className={primaryButton} disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "confirm" })}>确认</button> : <>
              <button type="button" className={secondaryButton} disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "pause", paused: !!routine.enabled })}>{routine.enabled ? "暂停" : "恢复"}</button>
              <button type="button" className={secondaryButton} disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "run" })}>运行一次</button>
            </>}
            <button type="button" className={secondaryButton} onClick={() => setHistory(history === routine.id ? null : routine.id)}>运行记录</button>
            <button type="button" className={dangerButton} disabled={change.isPending} onClick={() => change.mutate({ id: routine.id, action: "delete" })}>删除</button>
          </>}
        />
        {history === routine.id ? <div className="pb-3 text-sm text-neutral-500">{runs.isLoading ? "加载中…" : runs.error ? runs.error.message : runs.data && runs.data.runs.length === 0 ? "没有运行记录" : <ul>{runs.data?.runs.map((run) => <li key={run.id} className="[overflow-wrap:anywhere]">{new Date(run.scheduledAt).toLocaleString()} · {run.state}{run.error ? ` · ${run.error}` : ""}</li>)}</ul>}</div> : null}
      </li>)}
    </ul>
  </section>;
}
