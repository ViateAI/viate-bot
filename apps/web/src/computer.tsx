import { useEffect, useRef, useState } from "react";
// @ts-expect-error noVNC does not publish TypeScript declarations.
import RFB from "@novnc/novnc";
import { api } from "./api.js";

interface Lease { id: string; state: string; controlledHere: boolean }

function newSocketId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function Computer({ botId }: { botId: string }) {
  const target = useRef<HTMLDivElement>(null);
  const client = useRef<{ viewOnly: boolean; disconnect: () => void } | null>(null);
  const socketId = useRef("");
  const [lease, setLease] = useState<Lease | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!target.current) return;
    const connectionId = newSocketId();
    socketId.current = connectionId;
    setLease(null);
    setError("");
    const url = new URL(`/api/bots/${encodeURIComponent(botId)}/screen/vnc`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("socket", connectionId);
    const rfb = new RFB(target.current, url.toString());
    rfb.viewOnly = true;
    rfb.scaleViewport = true;
    client.current = rfb;
    let alive = true;
    rfb.addEventListener("disconnect", () => { if (alive) setError("屏幕连接已断开，请重新打开页面。"); });
    const refresh = async () => {
      try {
        const result = await api<{ leases: Lease[] }>(`/api/bots/${encodeURIComponent(botId)}/screen/leases?socket=${encodeURIComponent(connectionId)}`);
        if (alive) setLease(result.leases[0] ?? null);
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : "屏幕连接失败"); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { alive = false; clearInterval(timer); rfb.disconnect(); client.current = null; };
  }, [botId]);
  useEffect(() => { if (client.current) client.current.viewOnly = !lease?.controlledHere; }, [lease]);
  const change = async (action: "grant" | "release") => {
    if (!lease) return;
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/screen/${action}`, { method: "POST", body: JSON.stringify({ leaseId: lease.id, socketId: socketId.current }) });
      setLease(action === "grant" ? { ...lease, state: "active", controlledHere: true } : null);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
  };
  const owned = lease?.controlledHere === true;
  return (
    <section className={owned ? "screen-own" : "screen-watch"}>
      <div className={owned ? "lease" : "watch-bar"}>
        <strong>{owned ? "接管中" : "只读观看"}</strong>
        <span>{owned ? "租约生效，可以输入" : "不能输入"}</span>
        <button type="button" disabled={!lease || lease.state !== "requested"} onClick={() => void change("grant")} className="ui-btn">接管</button>
        <button type="button" disabled={!owned} onClick={() => void change("release")} className="ui-btn-ghost">交还</button>
      </div>
      <p className="px-3 py-2 text-xs leading-5 text-muted">
        你的各个 bot 共用这一块桌面和同一个浏览器。切换 bot 不会换成另一块屏幕，也不是安全边界。现在只能看；接管生效后才能输入。别的用户和管理员看不到这块屏幕。
      </p>
      {error ? <p role="alert" className="ui-alert mx-3">{error}</p> : null}
      <div ref={target} className="screen-canvas" />
    </section>
  );
}
