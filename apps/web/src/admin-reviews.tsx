import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.js";
import { ScanRow } from "./scan-row.js";

interface ReviewListItem {
  id: string;
  name: string;
  version: string;
  kinds: string[];
  requester: string;
  bot: string | null;
  createdAt: string;
  state: string;
}

interface ReviewDetail {
  id: string;
  name: string;
  version: string;
  note: string;
  sha256: string;
  manifest: string;
  files: Array<{ path: string; size: number; executable: boolean }>;
  mcp: Array<{ name: string; command?: string; args?: string[]; url?: string }>;
  config: Array<{ key: string; secret: boolean }>;
  routines: Array<{ cron: string; timezone: string; prompt: string }>;
  diff: { added: string[]; removed: string[]; modified: string[] } | null;
}

interface ReviewFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
  binary: boolean;
  text?: string;
  truncated?: boolean;
}

const button = "rounded bg-white px-3 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-200";
const field = "rounded border border-neutral-700 bg-neutral-900 px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-200";

export function AdminReviews() {
  const client = useQueryClient();
  const reviews = useQuery({
    queryKey: ["admin-app-reviews"],
    queryFn: () => api<{ pendingCount: number; requests: ReviewListItem[] }>("/api/admin/app-reviews"),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected ?? reviews.data?.requests[0]?.id ?? null;
  return (
    <section className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6" data-testid="admin-review-list">
      <h1 className="text-xl font-semibold">应用审批</h1>
      {reviews.isError ? <p role="alert" className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-900">无法加载审批</p> : null}
      {reviews.isPending ? <p className="text-sm text-neutral-400">正在加载…</p> : null}
      {reviews.data && reviews.data.requests.length === 0 ? <p className="text-sm text-neutral-400">没有发布申请</p> : null}
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <ul className="grid gap-2">
          {(reviews.data?.requests ?? []).map((item) => (
            <li key={item.id}>
              <button
                className="w-full rounded border border-neutral-800 px-3 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-200"
                type="button"
                data-testid={`admin-review-${item.id}`}
                onClick={() => setSelected(item.id)}
              >
                <ScanRow
                  tone="dark"
                  rule={false}
                  pad={false}
                  subject={`${item.name} ${item.version}`}
                  status={<span className={stateClass(item.state)}>{stateText(item.state)}</span>}
                  meta={`${item.kinds.join("、") || "未识别"} · ${item.requester} · ${item.bot ?? "页面提交"} · ${item.createdAt}`}
                />
              </button>
            </li>
          ))}
        </ul>
        {current ? <ReviewDetail id={current} onDecided={() => { void client.invalidateQueries({ queryKey: ["admin-app-reviews"] }); }} /> : null}
      </div>
    </section>
  );
}

function ReviewDetail({ id, onDecided }: { id: string; onDecided: () => void }) {
  const detail = useQuery({
    queryKey: ["admin-app-review", id],
    queryFn: () => api<ReviewDetail>(`/api/admin/app-reviews/${encodeURIComponent(id)}`),
  });
  const [path, setPath] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const decide = useMutation({
    mutationFn: (body: { decision: "approve" } | { decision: "reject"; reason: string }) => {
      const suffix = body.decision === "approve" ? "approve" : "reject";
      return api(`/api/admin/app-reviews/${encodeURIComponent(id)}/${suffix}`, {
        method: "POST",
        ...(body.decision === "reject" ? { body: JSON.stringify({ reason: body.reason }) } : {}),
      });
    },
    onSuccess: () => {
      setReason("");
      onDecided();
      void detail.refetch();
    },
  });
  const file = useQuery({
    queryKey: ["admin-app-review-file", id, path],
    enabled: path !== null,
    queryFn: () => api<ReviewFile>(`/api/admin/app-reviews/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path ?? "")}`),
  });
  const card = detail.data;
  if (detail.isPending) return <p className="text-sm text-neutral-400">正在加载详情…</p>;
  if (!card) return <p role="alert" className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-900">无法加载详情</p>;
  return (
    <article className="grid min-w-0 gap-4" data-testid="admin-review-detail">
      <h2 className="text-lg font-medium [overflow-wrap:anywhere]">{card.name} {card.version}</h2>
      <p className="break-all text-sm">SHA-256 {card.sha256}</p>
      <p className="whitespace-pre-wrap break-all text-sm">说明：{card.note}</p>
      <section className="grid gap-2">
        <h3 className="font-medium">manifest</h3>
        <pre className="overflow-auto whitespace-pre-wrap break-all text-sm">{card.manifest}</pre>
      </section>
      <section className="grid gap-2">
        <h3 className="font-medium">文件</h3>
        <ul className="grid gap-1 text-sm">
          {card.files.map((item) => (
            <li key={item.path}>
              <button className="break-all text-left" type="button" onClick={() => setPath(item.path)}>
                {item.path} · {item.size} 字节{item.executable ? " · 可执行" : ""}
              </button>
            </li>
          ))}
        </ul>
        {file.data ? <FileView file={file.data} /> : null}
      </section>
      <section className="grid gap-1 text-sm">
        <h3 className="font-medium">MCP</h3>
        {card.mcp.length === 0 ? <p>（没有 MCP）</p> : card.mcp.map((server) => (
          <p key={server.name} className="whitespace-pre-wrap break-all">{server.name}：{server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")}</p>
        ))}
      </section>
      <section className="grid gap-1 text-sm">
        <h3 className="font-medium">配置</h3>
        {card.config.map((item) => <p key={item.key} className="break-all">{item.key}{item.secret ? " · secret" : ""}</p>)}
      </section>
      <section className="grid gap-2 text-sm">
        <h3 className="font-medium">定时任务</h3>
        {card.routines.map((item) => (
          <div key={`${item.cron}-${item.timezone}`}>
            <p className="break-all">{item.cron} · {item.timezone}</p>
            <p className="whitespace-pre-wrap break-all">{item.prompt}</p>
          </div>
        ))}
      </section>
      <section className="grid gap-1 text-sm">
        <h3 className="font-medium">与上一个已批准版本的差异</h3>
        {card.diff ? (
          <>
            <p className="break-all">新增：{card.diff.added.join("、") || "无"}</p>
            <p className="break-all">删除：{card.diff.removed.join("、") || "无"}</p>
            <p className="break-all">修改：{card.diff.modified.join("、") || "无"}</p>
          </>
        ) : <p>没有更早的已批准版本</p>}
      </section>
      {decide.isError ? <p role="alert">{decide.error.message}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <button className={button} type="button" data-testid="admin-review-approve" disabled={decide.isPending} onClick={() => decide.mutate({ decision: "approve" })}>通过</button>
        <label className="grid gap-1 text-sm">
          驳回原因
          <input className={field} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <button className={button} type="button" data-testid="admin-review-reject" disabled={decide.isPending || reason.trim().length === 0} onClick={() => decide.mutate({ decision: "reject", reason })}>驳回</button>
      </div>
    </article>
  );
}

function FileView({ file }: { file: ReviewFile }) {
  if (file.binary) {
    return <p className="break-all text-sm" data-testid="admin-review-file">二进制 · {file.size} 字节 · SHA-256 {file.sha256}</p>;
  }
  return (
    <div data-testid="admin-review-file">
      <p className="break-all text-sm">SHA-256 {file.sha256}{file.truncated ? " · 只显示前 256 KB" : ""}</p>
      <pre className="overflow-auto whitespace-pre-wrap break-all text-sm">{file.text}</pre>
    </div>
  );
}

function stateText(state: string): string {
  switch (state) {
    case "pending":
      return "待审批";
    case "approved":
      return "已通过";
    case "rejected":
      return "已驳回";
    case "withdrawn":
      return "已撤回";
    default:
      return "状态未知";
  }
}

function stateClass(state: string): string {
  switch (state) {
    case "pending":
      return "font-medium text-amber-300";
    case "approved":
      return "font-medium text-emerald-300";
    case "rejected":
      return "font-medium text-red-300";
    default:
      return "text-neutral-400";
  }
}
