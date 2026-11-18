function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part);
}

/** Chromium `--host-resolver-rules`。显式规则优先；否则把 curl `--resolve` 形式转成 `MAP host ip`。端口只为对齐 curl。地址必须已是 IPv4，主机名留给 docker-run.sh 先解析。 */
export function hostResolverRules(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.VB_E2E_HOST_RESOLVER_RULES?.trim();
  if (explicit) return explicit;
  const resolve = env.VB_E2E_RESOLVE?.trim();
  if (!resolve) return undefined;
  const rules = resolve.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const parts = item.split(":");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new Error(`VB_E2E_RESOLVE 应为 host:port:address，收到 ${item}`);
    }
    if (!isIpv4(parts[2])) throw new Error(`VB_E2E_RESOLVE 的地址必须是 IPv4，收到 ${parts[2]}`);
    return `MAP ${parts[0]} ${parts[2]}`;
  });
  if (rules.length === 0) return undefined;
  return rules.join(",");
}
