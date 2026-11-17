import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";

interface Overview {
  provisionedUsers: number;
  activeUsers1d: number;
  machinesRunning: number;
  tasksToday: number;
  tasksSucceededToday: number;
  costUsdToday: number;
  anomalies: Array<{ machineId: string; kind: "heartbeat" | "disk" | "error" }>;
  failureClasses: Array<{ errorClass: string; count: number }>;
  activeTrend: Array<{ day: string; count: number }>;
  alerts: Array<{ kind: "machine" | "routine"; target: string }>;
}

interface AuditRow {
  id: string;
  ts: string;
  actorUserId: string | null;
  action: string;
  target: string;
}

export function AdminMetrics() {
  const overview = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => api<Overview>("/api/admin/overview"),
  });
  const data = overview.data;
  const rate = data && data.tasksToday > 0 ? Math.round((data.tasksSucceededToday / data.tasksToday) * 100) : 0;
  return (
    <section className="grid gap-6">
      <h2 className="text-lg">运维总览</h2>
      {overview.isPending ? <p className="text-neutral-400">正在加载…</p> : null}
      {overview.isError ? <p className="text-red-300">看板加载失败</p> : null}
      {data ? (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <Stat label="已开通" value={String(data.provisionedUsers)} />
            <Stat label="近 24 小时活跃" value={String(data.activeUsers1d)} />
            <Stat label="运行中的机器" value={String(data.machinesRunning)} />
            <Stat label="今日任务" value={String(data.tasksToday)} />
            <Stat label="今日成功率" value={`${rate}%`} />
            <Stat label="今日费用" value={data.costUsdToday.toFixed(4)} />
          </dl>
          <div>
            <h3 className="mb-2 text-sm text-neutral-400">资源异常</h3>
            <ul className="grid gap-1 text-sm">
              {data.anomalies.length === 0 ? <li className="text-neutral-500">没有</li> : null}
              {data.anomalies.map((item) => (
                <li key={`${item.machineId}-${item.kind}`}>
                  {item.machineId} · {item.kind}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-sm text-neutral-400">失败类别</h3>
            <ul className="grid gap-1 text-sm">
              {data.failureClasses.length === 0 ? <li className="text-neutral-500">没有</li> : null}
              {data.failureClasses.map((item) => (
                <li key={item.errorClass}>
                  {item.errorClass} · {item.count}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-sm text-neutral-400">活跃趋势</h3>
            <ul className="grid gap-1 text-sm">
              {data.activeTrend.map((item) => (
                <li key={item.day}>
                  {item.day} · {item.count}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-sm text-neutral-400">站内告警</h3>
            <ul className="grid gap-1 text-sm">
              {data.alerts.length === 0 ? <li className="text-neutral-500">没有</li> : null}
              {data.alerts.map((item) => (
                <li key={`${item.kind}-${item.target}`}>
                  {item.kind} · {item.target}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function AdminAudit() {
  const audit = useQuery({
    queryKey: ["admin-audit"],
    queryFn: () => api<{ audit: AuditRow[] }>("/api/admin/audit"),
  });
  return (
    <section className="grid gap-3">
      <h2 className="text-lg">审计</h2>
      <ul className="grid gap-1 text-sm text-neutral-300">
        {(audit.data?.audit ?? []).map((row) => (
          <li key={row.id}>
            {row.ts} · {row.action} · {row.target}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 px-3 py-2">
      <dt className="text-neutral-500">{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}
