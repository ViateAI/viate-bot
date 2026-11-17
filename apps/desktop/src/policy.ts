const MAX_URL_LENGTH = 300;

export function acceptedBaseUrl(input: string, dev: boolean): string | null {
  if (input.length < 1 || input.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") {
    if (url.hostname.length === 0) return null;
    return url.origin;
  }
  if (url.protocol !== "http:" || !dev) return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  return url.origin;
}

export function parseBaseInput(value: unknown, dev: boolean): { ok: true; base: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "地址无效" };
  const base = acceptedBaseUrl(value, dev);
  if (!base) {
    return {
      ok: false,
      error: dev ? "只接受 https://。开发构建另允许 http://127.0.0.1 和 http://localhost" : "只接受 https://",
    };
  }
  return { ok: true, base };
}

/** 外部链接只能打开已配置的 viate-bot origin，且路径只能是站点根或绑定页。 */
export function externalAllowed(target: string, base: string): boolean {
  let url: URL;
  let origin: URL;
  try {
    url = new URL(target);
    origin = new URL(base);
  } catch {
    return false;
  }
  if (url.origin !== origin.origin) return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return url.pathname === "/" || url.pathname === "/client/link";
}
