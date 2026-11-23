import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { ScanRow } from "./scan-row.js";

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
  routinePunctuality7d: {
    planned: number;
    onTime: number;
    late: number;
    missed: number;
    skipped: number;
    onTimeRate: number | null;
  };
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
  const punctual = data?.routinePunctuality7d;
  const punctualRate = punctual?.onTimeRate == null ? "—" : `${(punctual.onTimeRate * 100).toFixed(1)}%`;
  return (
    <section className="work-page grid min-w-0 gap-6">
      <div className="work-head">
        <h1 className="text-2xl font-semibold">运维总览</h1>
      </div>
      {overview.isPending ? <p className="text-muted">正在加载…</p> : null}
      {overview.isError ? <p role="alert" className="ui-alert">看板加载失败</p> : null}
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
          {punctual ? (
            <div data-testid="routine-punctuality">
              <h2 className="mb-2 text-sm text-muted">定时任务按时率（近 7 天）</h2>
              <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                <Stat label="按时率" value={punctualRate} />
                <Stat label="计划次数" value={String(punctual.planned)} />
                <Stat label="按时" value={String(punctual.onTime)} />
                <Stat label="迟到" value={String(punctual.late)} />
                <Stat label="错过" value={String(punctual.missed)} />
                <Stat label="跳过" value={String(punctual.skipped)} />
              </dl>
              <p className="mt-2 text-xs text-muted">计划时刻后 2 分钟内开始算按时。跳过不计入按时率。控制面停机错过的次数记在「错过」。</p>
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <section className={`rounded-xl border p-4 ${data.anomalies.length > 0 ? "border-danger-border bg-danger-bg" : "border-line bg-surface"}`}>
              <h2 className={`mb-2 text-sm ${data.anomalies.length > 0 ? "text-danger" : "text-muted"}`}>资源异常</h2>
              <ul className="grid gap-1 text-sm">
                {data.anomalies.length === 0 ? <li className="text-muted">没有</li> : null}
                {data.anomalies.map((item) => (
                  <li key={`${item.machineId}-${item.kind}`}>
                    <ScanRow tone="dark" subject={<IdText value={item.machineId} />} status={anomalyLabel[item.kind]} />
                  </li>
                ))}
              </ul>
            </section>
            <section className={`rounded-xl border p-4 ${data.alerts.length > 0 ? "border-danger-border bg-danger-bg" : "border-line bg-surface"}`}>
              <h2 className={`mb-2 text-sm ${data.alerts.length > 0 ? "text-danger" : "text-muted"}`}>站内告警</h2>
              <ul className="grid gap-1 text-sm">
                {data.alerts.length === 0 ? <li className="text-muted">没有</li> : null}
                {data.alerts.map((item) => (
                  <li key={`${item.kind}-${item.target}`}>
                    <ScanRow tone="dark" subject={<IdText value={item.target} />} status={alertLabel[item.kind]} />
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-xl border border-line bg-surface p-4">
              <h2 className="mb-2 text-sm text-muted">失败类别</h2>
              <ul className="grid gap-1 text-sm">
                {data.failureClasses.length === 0 ? <li className="text-muted">没有</li> : null}
                {data.failureClasses.map((item) => (
                  <li key={item.errorClass}>
                    <ScanRow tone="dark" subject={item.errorClass} status={String(item.count)} />
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-xl border border-line bg-surface p-4">
              <h2 className="mb-2 text-sm text-muted">活跃趋势</h2>
              <ul className="grid gap-1 text-sm">
                {data.activeTrend.map((item) => (
                  <li key={item.day}>
                    <ScanRow tone="dark" subject={item.day} status={String(item.count)} />
                  </li>
                ))}
              </ul>
            </section>
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
    <section className="work-page grid min-w-0 gap-3">
      <div className="work-head">
        <h1 className="text-2xl font-semibold">审计</h1>
      </div>
      {audit.isPending ? <p className="text-sm text-muted">正在加载…</p> : null}
      {audit.isError ? <p role="alert" className="ui-alert">{audit.error.message}</p> : null}
      {audit.data && audit.data.audit.length === 0 ? <p className="text-sm text-muted">没有审计记录</p> : null}
      <ul className="text-sm">
        {(audit.data?.audit ?? []).map((row) => (
          <li key={row.id}>
            <ScanRow tone="dark" subject={row.action} meta={`${row.ts} · ${row.target}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2">
      <dt className="text-muted">{props.label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{props.value}</dd>
    </div>
  );
}

const anomalyLabel = { heartbeat: "心跳", disk: "磁盘", error: "异常" } as const;
const alertLabel = { machine: "机器", routine: "定时任务" } as const;

function IdText({ value }: { value: string }) {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(value)) return value;
  return <span title={value}>{`${value.slice(0, 6)}…${value.slice(-4)}`}</span>;
}
