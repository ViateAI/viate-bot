import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, rememberCsrf, type Me } from "./api.js";

interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  online: boolean;
  allowFakeIp: boolean;
}

interface EgressView {
  mode: "direct" | "user_network";
  offlinePolicy: "pause" | "fallback_direct";
  deviceId: string | null;
  deviceOnline: boolean;
  devices: Device[];
}

export function EgressSettings() {
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      const user = await api<Me>("/api/me");
      rememberCsrf(user.csrf);
      return user;
    },
  });
  const egress = useQuery({ queryKey: ["egress"], queryFn: () => api<EgressView>("/api/egress"), retry: false });
  const devices = useQuery({ queryKey: ["client-devices"], queryFn: () => api<{ devices: Device[] }>("/api/client/devices") });
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const save = useMutation({
    mutationFn: (body: { mode: string; offlinePolicy: string; deviceId: string | null }) =>
      api("/api/egress", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["egress"] });
    },
    onError: (caught: Error) => setError(caught.message),
  });
  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api(`/api/client/devices/${input.id}/rename`, { method: "POST", body: JSON.stringify({ name: input.name }) }),
    onSuccess: async () => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["client-devices"] });
      await queryClient.invalidateQueries({ queryKey: ["egress"] });
    },
    onError: (caught: Error) => setError(caught.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/client/devices/${id}/revoke`, { method: "POST", body: "{}" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["client-devices"] });
      await queryClient.invalidateQueries({ queryKey: ["egress"] });
    },
    onError: (caught: Error) => setError(caught.message),
  });

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const device = String(form.get("deviceId") ?? "");
    save.mutate({
      mode: String(form.get("mode") ?? "direct"),
      offlinePolicy: String(form.get("offlinePolicy") ?? "pause"),
      deviceId: device.length > 0 ? device : null,
    });
  }

  const current = egress.data;
  const rows = devices.data?.devices ?? current?.devices ?? [];
  const download = httpUrl(me.data?.desktopDownloadUrl);
  return (
    <section className="mx-auto grid max-w-3xl gap-6 px-6 py-8">
      <h1 className="text-2xl font-semibold">网络出口</h1>
      {download ? (
        <p className="text-sm text-neutral-400">
          选择用户网络后，电脑里的浏览器流量从你自己的网络出去。
          <a className="mx-1 text-neutral-200 underline" href={download} rel="noreferrer" target="_blank">下载桌面客户端</a>
          ，安装后填写这个站点的地址并完成绑定。不认代理环境变量的 shell 程序仍可能直连。
        </p>
      ) : (
        <p className="text-sm text-neutral-400">
          选择用户网络后，电脑里的浏览器流量从你自己的网络出去。现在用命令行客户端：
          <code className="mx-1 text-neutral-200">viate-egress link</code>
          然后
          <code className="mx-1 text-neutral-200">viate-egress run</code>
          。不认代理环境变量的 shell 程序仍可能直连。
        </p>
      )}
      {egress.isError ? <p className="text-sm text-neutral-400">还没有电脑，开通之后才能切换出口。</p> : null}
      {current ? (
        <form data-testid="egress-form" className="grid gap-3 rounded border border-neutral-800 p-4" onSubmit={onSave}>
          <label className="grid gap-1 text-sm">
            方式
            <select name="mode" defaultValue={current.mode} className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1">
              <option value="direct">直连（宿主机网络）</option>
              <option value="user_network">用户网络</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            客户端离线时
            <select name="offlinePolicy" defaultValue={current.offlinePolicy} className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1">
              <option value="pause">暂停新连接</option>
              <option value="fallback_direct">改回直连</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            出口设备
            <select name="deviceId" defaultValue={current.deviceId ?? ""} className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1">
              <option value="">不选择</option>
              {rows.filter((device) => !device.revokedAt).map((device) => (
                <option key={device.id} value={device.id}>{device.name}{device.online ? "（在线）" : ""}</option>
              ))}
            </select>
          </label>
          <p className="text-sm text-neutral-400">当前{current.mode === "user_network" ? "用户网络" : "直连"} · 设备{current.deviceOnline ? "在线" : "离线"}</p>
          <button data-testid="egress-save" className="w-fit rounded bg-neutral-100 px-3 py-1 text-sm text-neutral-900" type="submit">保存</button>
        </form>
      ) : null}
      <h2 className="text-lg font-medium">设备</h2>
      <ul data-testid="device-list" className="grid gap-2">
        {rows.map((device) => (
          <li key={device.id} data-testid="device-row" className="rounded border border-neutral-800 p-3 text-sm">
            <p>{device.name} · {device.revokedAt ? "已吊销" : device.online ? "在线" : "离线"}</p>
            {device.allowFakeIp ? <span data-testid="allow-fake-ip" className="text-amber-400">允许 fake-ip</span> : null}
            <p className="text-neutral-500">最后在线 {device.lastSeenAt ?? "无"}</p>
            {device.revokedAt ? null : (
              <span className="mt-2 flex gap-2">
                <button type="button" className="rounded border border-neutral-600 px-2 py-1" onClick={() => rename.mutate({ id: device.id, name: name || device.name })}>重命名</button>
                <button data-testid={`revoke-${device.id}`} type="button" className="rounded border border-neutral-600 px-2 py-1" onClick={() => revoke.mutate(device.id)}>吊销</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <label className="grid max-w-xs gap-1 text-sm">
        新名字
        <input data-testid="device-name" className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
    </section>
  );
}

function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
