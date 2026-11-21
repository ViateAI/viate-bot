import type { ReactNode } from "react";

/**
 * 主题 / 状态 / 操作扫描行。宽容器把状态和操作放进固定列；窄容器把次要信息留在主题下面，操作换到下一行。
 * 侧栏约 320px，所以用容器宽度而不是视口宽度。
 */
export function ScanRow({
  subject,
  meta,
  status,
  actions,
  tone = "light",
  rule = true,
  pad = true,
}: {
  subject: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  tone?: "light" | "dark";
  rule?: boolean;
  pad?: boolean;
}) {
  const line = rule ? "border-b border-line" : "";
  const metaTone = "text-muted";
  void tone;
  const grid = status && actions
    ? "grid-cols-[minmax(0,1fr)_5.5rem] @min-[40rem]:grid-cols-[minmax(0,1fr)_5.5rem_minmax(0,18rem)]"
    : status
      ? "grid-cols-[minmax(0,1fr)_5.5rem]"
      : actions
        ? "grid-cols-1 @min-[40rem]:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]"
        : "grid-cols-1";
  const actionsClass = status
    ? "col-span-2 col-start-1 row-start-2 flex flex-wrap items-center gap-2 @min-[40rem]:col-span-1 @min-[40rem]:col-start-3 @min-[40rem]:row-start-1 @min-[40rem]:justify-end"
    : "row-start-2 flex flex-wrap items-center gap-2 @min-[40rem]:col-start-2 @min-[40rem]:row-start-1 @min-[40rem]:justify-end";
  return (
    <div className="@container min-w-0">
      <div className={`grid items-start gap-x-3 gap-y-2 ${pad ? "py-2.5" : ""} ${line} ${grid}`}>
        <div className="col-start-1 row-start-1 min-w-0">
          <div className="font-medium whitespace-pre-wrap [overflow-wrap:anywhere]">{subject}</div>
          {meta ? <div className={`mt-0.5 text-sm font-normal whitespace-pre-wrap [overflow-wrap:anywhere] ${metaTone}`}>{meta}</div> : null}
        </div>
        {status ? <div className="col-start-2 row-start-1 w-full text-right text-sm [overflow-wrap:anywhere]">{status}</div> : null}
        {actions ? <div className={actionsClass}>{actions}</div> : null}
      </div>
    </div>
  );
}
