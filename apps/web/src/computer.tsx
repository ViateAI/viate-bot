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
  const socketId = useRef(newSocketId());
  const [lease, setLease] = useState<Lease | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!target.current) return;
    const url = new URL(`/api/bots/${encodeURIComponent(botId)}/screen/vnc`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("socket", socketId.current);
    const rfb = new RFB(target.current, url.toString());
    rfb.viewOnly = true;
    rfb.scaleViewport = true;
    client.current = rfb;
    let alive = true;
    const refresh = async () => {
      try {
        const result = await api<{ leases: Lease[] }>(`/api/bots/${encodeURIComponent(botId)}/screen/leases?socket=${encodeURIComponent(socketId.current)}`);
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
  return <section className="space-y-3">
    <div className="flex items-center gap-3">
      <button type="button" disabled={!lease || lease.state !== "requested"} onClick={() => void change("grant")} className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-40">接管</button>
      <button type="button" disabled={!lease?.controlledHere} onClick={() => void change("release")} className="rounded border px-3 py-2 disabled:opacity-40">交还</button>
      <span className="text-sm text-gray-500">{lease?.controlledHere ? "正在接管，可以输入" : "只读观察"}</span>
    </div>
    <p className="text-sm text-neutral-400">
      你的各个 bot 共用这一块桌面和同一个浏览器。切换 bot 不会换成另一块屏幕，也不是安全边界。现在只能看；接管生效后才能输入。别的用户和管理员看不到这块屏幕。
    </p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <div ref={target} className="min-h-80 overflow-hidden rounded bg-black" />
  </section>;
}
