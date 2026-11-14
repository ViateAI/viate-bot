import { timingSafeEqual } from "node:crypto";
import { LoginRejected } from "./login.js";

export const OAUTH_COOKIE = "vb_oauth";
export const SESSION_COOKIE = "vb_session";
export const OAUTH_MAX_AGE_SECONDS = 10 * 60;
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** Secure 只在 http 的 localhost / 127.0.0.1 上去掉。其他地址一律带上。 */
export function cookieSecure(publicUrl: string): boolean {
  const url = new URL(publicUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return !(url.protocol === "http:" && local);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return undefined;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; path: string; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function csrfEqual(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * 登录后的跳转只允许站内相对路径。协议相对地址、反斜杠和带用户信息的 URL 都拒绝。
 * `/.//evil.example` 这类输入规范化后会变成 `//evil.example`，所以规范化之后再查一次。
 * 空值回到站点根路径。
 */
export function safeReturnPath(input: string | undefined): string {
  if (input === undefined || input === "") return "/";
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\") || input.includes("\0")) {
    throw new LoginRejected("跳转地址必须是站内路径", 400);
  }
  const url = new URL(input, "http://viate-bot.local");
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (
    url.hostname !== "viate-bot.local" ||
    url.username !== "" ||
    url.password !== "" ||
    !path.startsWith("/") ||
    path.startsWith("//")
  ) {
    throw new LoginRejected("跳转地址必须是站内路径", 400);
  }
  return path;
}
