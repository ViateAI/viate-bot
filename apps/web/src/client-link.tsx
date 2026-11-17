import { useState } from "react";
import { api } from "./api.js";

export function ClientLink() {
  const params = new URLSearchParams(window.location.search);
  const deviceName = params.get("device_name") ?? "";
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function allow() {
    setPending(true);
    setError("");
    try {
      const result = await api<{ location: string }>("/api/client/link", {
        method: "POST",
        body: JSON.stringify({
          redirect_port: params.get("redirect_port") ?? "",
          state: params.get("state") ?? "",
          code_challenge: params.get("code_challenge") ?? "",
          device_name: deviceName,
        }),
      });
      window.location.assign(result.location);
    } catch (caught) {
      setPending(false);
      setError(caught instanceof Error ? caught.message : "绑定失败");
    }
  }

  return (
    <section className="mx-auto grid max-w-lg gap-4 px-6 py-10">
      <h1 className="text-2xl font-semibold">连接桌面客户端</h1>
      <p className="text-sm text-neutral-300">允许这台电脑作为网络出口：{deviceName || "未命名设备"}</p>
      <p className="text-sm text-neutral-500">允许之后，浏览器会回到你电脑上的客户端。设备令牌只用于建立出口连接。</p>
      <button data-testid="link-allow" className="w-fit rounded bg-neutral-100 px-3 py-2 text-sm text-neutral-900 disabled:opacity-40" type="button" disabled={pending} onClick={() => void allow()}>
        允许
      </button>
      {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
    </section>
  );
}
