/**
 * 机器与桌面客户端之间的出口帧，以及拨号前的目标地址检查。
 * 检查看解析后的 IP，不看主机名字面。调用方必须拨这里返回的地址，不能再按主机名解析一次。
 * 私网、回环、链路本地、CGNAT、组播和保留地址一律拒绝。IPv4-mapped、6to4、NAT64 看嵌入的 IPv4。
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export const EGRESS_INITIAL_WINDOW = 256 * 1024;
export const EGRESS_MAX_DATA = 64 * 1024;
export const EGRESS_MAX_STREAMS = 256;
export const EGRESS_OPEN_TIMEOUT_MS = 15_000;
export const EGRESS_PING_INTERVAL_MS = 15_000;
export const EGRESS_PONG_TIMEOUT_MS = 45_000;
export const EGRESS_PROXY_HOST = "127.0.0.1";
export const EGRESS_PROXY_PORT = 3128;
export const EGRESS_ALLOWED_PORTS = [80, 443] as const;

export const FRAME_OPEN = 1;
export const FRAME_OPEN_OK = 2;
export const FRAME_OPEN_FAIL = 3;
export const FRAME_DATA = 4;
export const FRAME_CREDIT = 5;
export const FRAME_END = 6;
export const FRAME_RESET = 7;

const HEADER = 5;
const MAX_CONTROL = 4096;

export const EGRESS_FAIL_CODES = ["blocked", "dns", "connect", "timeout", "offline", "limit"] as const;
export type EgressFailCode = (typeof EGRESS_FAIL_CODES)[number];

export type EgressFrame =
  | { type: "OPEN"; streamId: number; host: string; port: number }
  | { type: "OPEN_OK"; streamId: number }
  | { type: "OPEN_FAIL"; streamId: number; code: EgressFailCode; message: string }
  | { type: "DATA"; streamId: number; payload: Buffer }
  | { type: "CREDIT"; streamId: number; credit: number }
  | { type: "END"; streamId: number }
  | { type: "RESET"; streamId: number };

export type TargetDecision =
  | { ok: true; address: string; addresses: string[] }
  | { ok: false; code: "blocked" | "dns"; message: string };

const FAIL = new Set<string>(EGRESS_FAIL_CODES);

const v4 = new BlockList();
const v6 = new BlockList();

function ban4(address: string, prefix: number): void {
  v4.addSubnet(address, prefix, "ipv4");
}
function ban6(address: string, prefix: number): void {
  v6.addSubnet(address, prefix, "ipv6");
}

ban4("0.0.0.0", 8);
ban4("10.0.0.0", 8);
ban4("100.64.0.0", 10);
ban4("127.0.0.0", 8);
ban4("169.254.0.0", 16);
ban4("172.16.0.0", 12);
ban4("192.0.0.0", 24);
ban4("192.0.2.0", 24);
ban4("192.88.99.0", 24);
ban4("192.168.0.0", 16);
// 198.18.0.0/15 stays allowed: Clash/Surge/sing-box fake-ip DNS hands out these
// addresses for public hosts on both the deployment host and user PCs.
ban4("198.51.100.0", 24);
ban4("203.0.113.0", 24);
ban4("224.0.0.0", 4);
ban4("240.0.0.0", 4);

ban6("::", 128);
ban6("::1", 128);
ban6("fc00::", 7);
ban6("fe80::", 10);
ban6("fec0::", 10);
ban6("ff00::", 8);
ban6("100::", 64);
ban6("2001:db8::", 32);
ban6("2001:2::", 48);
ban6("2001:10::", 28);
ban6("2001:20::", 28);

export function encodeEgressFrame(frame: EgressFrame): Buffer {
  const streamId = frame.streamId;
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffff_ffff) {
    throw new Error("streamId 无效");
  }
  const payload = payloadOf(frame);
  const out = Buffer.allocUnsafe(HEADER + payload.length);
  out[0] = typeOf(frame);
  out.writeUInt32BE(streamId, 1);
  payload.copy(out, HEADER);
  return out;
}

export function decodeEgressFrame(input: Buffer): EgressFrame {
  if (input.length < HEADER) throw new Error("帧太短");
  const type = input[0];
  const streamId = input.readUInt32BE(1);
  if (!Number.isInteger(streamId) || streamId < 1) throw new Error("streamId 无效");
  const payload = input.subarray(HEADER);
  switch (type) {
    case FRAME_OPEN: {
      const body = readControl(payload);
      const host = body.host;
      const port = body.port;
      if (typeof host !== "string" || host.length < 1 || host.length > 253) throw new Error("OPEN 主机名无效");
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OPEN 端口无效");
      return { type: "OPEN", streamId, host, port };
    }
    case FRAME_OPEN_OK: {
      if (payload.length !== 0) throw new Error("OPEN_OK 不能带负载");
      return { type: "OPEN_OK", streamId };
    }
    case FRAME_OPEN_FAIL: {
      const body = readControl(payload);
      const code = body.code;
      const message = body.message;
      if (typeof code !== "string" || !FAIL.has(code)) throw new Error("OPEN_FAIL 代码无效");
      if (typeof message !== "string" || message.length > 400) throw new Error("OPEN_FAIL 说明无效");
      return { type: "OPEN_FAIL", streamId, code: code as EgressFailCode, message };
    }
    case FRAME_DATA: {
      if (payload.length > EGRESS_MAX_DATA) throw new Error("DATA 超过 64 KiB");
      return { type: "DATA", streamId, payload: Buffer.from(payload) };
    }
    case FRAME_CREDIT: {
      if (payload.length !== 4) throw new Error("CREDIT 长度不对");
      return { type: "CREDIT", streamId, credit: payload.readUInt32BE(0) };
    }
    case FRAME_END: {
      if (payload.length !== 0) throw new Error("END 不能带负载");
      return { type: "END", streamId };
    }
    case FRAME_RESET: {
      if (payload.length !== 0) throw new Error("RESET 不能带负载");
      return { type: "RESET", streamId };
    }
    default:
      throw new Error("未知帧类型");
  }
}

export function rewriteStreamId(frame: Buffer, streamId: number): Buffer {
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffff_ffff) throw new Error("streamId 无效");
  const out = Buffer.from(frame);
  out.writeUInt32BE(streamId, 1);
  return out;
}

/** 解析主机名。测试注入自己的解析函数，避免真正去访问 DNS。 */
export async function defaultResolve(host: string): Promise<string[]> {
  const rows = await lookup(host, { all: true, verbatim: true });
  return [...new Set(rows.map((row) => row.address))];
}

/**
 * 把各种写法的 IP 字面量规范成拨号地址。
 * 不是字面量时返回 null，调用方再走 DNS。
 * 看起来像 IP 却解不开的字符串返回 "invalid"，调用方当拒绝，不再查 DNS。
 */
export function parseIpLiteral(host: string): string | "invalid" | null {
  const text = host.trim();
  if (text.length === 0 || text.length > 253) return "invalid";
  if (text.includes("%") || /\s/.test(text)) return "invalid";
  if (text.includes(":")) {
    const groups = parseIpv6(text);
    if (!groups) return text.startsWith("[") || text.includes(":") ? "invalid" : null;
    return dialOf(groups);
  }
  if (!/^[0-9a-fx.]+$/i.test(text)) return null;
  const v4literal = parseIpv4Literal(text);
  return v4literal ?? "invalid";
}

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4.check(ip, "ipv4");
  if (family !== 6) return true;
  const groups = parseIpv6(ip);
  if (!groups) return true;
  return blockedGroups(groups);
}

export async function checkEgressTarget(
  host: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
  allow?: (ip: string) => boolean,
): Promise<TargetDecision> {
  const trimmed = host.trim().replace(/\.+$/, "");
  if (trimmed.length === 0 || trimmed.length > 253 || /[\s/@\\#?]/.test(host)) {
    return { ok: false, code: "blocked", message: "目标地址不允许" };
  }
  const literal = parseIpLiteral(trimmed);
  let candidates: string[];
  if (literal === "invalid") return { ok: false, code: "blocked", message: "目标地址不允许" };
  if (literal) candidates = [literal];
  else {
    try {
      candidates = await resolve(trimmed);
    } catch {
      return { ok: false, code: "dns", message: "无法解析目标" };
    }
    if (candidates.length === 0) return { ok: false, code: "dns", message: "无法解析目标" };
  }
  const addresses: string[] = [];
  for (const candidate of candidates) {
    const dial = canonicalDial(candidate);
    if (!dial) return { ok: false, code: "blocked", message: "目标地址不允许" };
    if (isBlockedIp(dial) && !allow?.(dial)) return { ok: false, code: "blocked", message: "目标地址不允许" };
    addresses.push(dial);
  }
  const address = addresses[0];
  if (!address) return { ok: false, code: "dns", message: "无法解析目标" };
  return { ok: true, address, addresses };
}

export function allowPrivatePredicate(entries: readonly string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/");
    const addr = slash >= 0 ? entry.slice(0, slash) : entry;
    const prefix = slash >= 0 ? Number(entry.slice(slash + 1)) : null;
    const family = isIP(addr);
    if (family === 0 || (prefix !== null && (!Number.isInteger(prefix) || prefix < 0))) {
      throw new Error(`无法识别的允许地址 ${entry}`);
    }
    const kind = family === 4 ? "ipv4" : "ipv6";
    if (prefix === null) list.addAddress(addr, kind);
    else list.addSubnet(addr, prefix, kind);
  }
  return (ip: string) => {
    const family = isIP(ip);
    if (family === 0) return false;
    return list.check(ip, family === 4 ? "ipv4" : "ipv6");
  };
}

export function portAllowed(port: number): boolean {
  return port === 80 || port === 443;
}

function payloadOf(frame: EgressFrame): Buffer {
  switch (frame.type) {
    case "OPEN":
      return Buffer.from(JSON.stringify({ host: frame.host, port: frame.port }), "utf8");
    case "OPEN_FAIL":
      return Buffer.from(JSON.stringify({ code: frame.code, message: frame.message }), "utf8");
    case "DATA":
      if (frame.payload.length > EGRESS_MAX_DATA) throw new Error("DATA 超过 64 KiB");
      return frame.payload;
    case "CREDIT": {
      if (!Number.isInteger(frame.credit) || frame.credit < 0 || frame.credit > 0xffff_ffff) {
        throw new Error("CREDIT 无效");
      }
      const buf = Buffer.allocUnsafe(4);
      buf.writeUInt32BE(frame.credit, 0);
      return buf;
    }
    case "OPEN_OK":
    case "END":
    case "RESET":
      return Buffer.alloc(0);
  }
}

function typeOf(frame: EgressFrame): number {
  switch (frame.type) {
    case "OPEN":
      return FRAME_OPEN;
    case "OPEN_OK":
      return FRAME_OPEN_OK;
    case "OPEN_FAIL":
      return FRAME_OPEN_FAIL;
    case "DATA":
      return FRAME_DATA;
    case "CREDIT":
      return FRAME_CREDIT;
    case "END":
      return FRAME_END;
    case "RESET":
      return FRAME_RESET;
  }
}

function readControl(payload: Buffer): Record<string, unknown> {
  if (payload.length > MAX_CONTROL) throw new Error("控制帧过大");
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    throw new Error("控制帧不是 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("控制帧不是对象");
  return value as Record<string, unknown>;
}

function canonicalDial(ip: string): string | null {
  if (isIP(ip) === 4) return ip;
  const groups = parseIpv6(ip);
  if (!groups) return null;
  return dialOf(groups);
}

function blockedGroups(groups: number[]): boolean {
  if (mapped(groups) || nat64(groups)) return isBlockedIp(v4From(groups[6] ?? 0, groups[7] ?? 0));
  if (groups[0] === 0x2002) return isBlockedIp(v4From(groups[1] ?? 0, groups[2] ?? 0));
  const compatible = groups.slice(0, 6).every((part) => part === 0) && ((groups[6] ?? 0) !== 0 || (groups[7] ?? 0) !== 0);
  if (compatible && !loopback(groups)) return isBlockedIp(v4From(groups[6] ?? 0, groups[7] ?? 0));
  return v6.check(formatV6(groups), "ipv6");
}

function dialOf(groups: number[]): string {
  if (mapped(groups)) return v4From(groups[6] ?? 0, groups[7] ?? 0);
  return formatV6(groups);
}

function mapped(groups: number[]): boolean {
  return groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
}

function nat64(groups: number[]): boolean {
  return (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  );
}

function loopback(groups: number[]): boolean {
  return groups.every((part, index) => part === (index === 7 ? 1 : 0));
}

function parseIpv6(input: string): number[] | null {
  let text = input.trim().toLowerCase();
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) return null;
    text = text.slice(1, -1);
  }
  if (text.includes("%") || text.includes(":::")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side.length === 0) return [];
    const parts = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part === undefined || part.length === 0) return null;
      if (part.includes(".")) {
        if (i !== parts.length - 1) return null;
        const addr = parseIpv4Literal(part);
        if (!addr || addr.split(".").length !== 4) return null;
        const [a, b, c, d] = addr.split(".").map((item) => Number(item));
        if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
        out.push(((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const full = parseSide(halves[0] ?? "");
    return full && full.length === 8 ? full : null;
  }
  const left = parseSide(halves[0] ?? "");
  const right = parseSide(halves[1] ?? "");
  if (!left || !right || left.length + right.length > 7) return null;
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** inet_aton：十进制、八进制、十六进制，以及 1 到 4 段的简写。 */
export function parseIpv4Literal(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const value = parsePart(part);
    if (value === null) return null;
    numbers.push(value);
  }
  const a = numbers[0];
  if (a === undefined) return null;
  let packed: number;
  if (numbers.length === 1) {
    if (a > 0xffff_ffff) return null;
    packed = a;
  } else if (numbers.length === 2) {
    const b = numbers[1];
    if (b === undefined || a > 0xff || b > 0xff_ffff) return null;
    packed = a * 2 ** 24 + b;
  } else if (numbers.length === 3) {
    const b = numbers[1];
    const c = numbers[2];
    if (b === undefined || c === undefined || a > 0xff || b > 0xff || c > 0xffff) return null;
    packed = a * 2 ** 24 + b * 2 ** 16 + c;
  } else {
    const b = numbers[1];
    const c = numbers[2];
    const d = numbers[3];
    if (b === undefined || c === undefined || d === undefined) return null;
    if (a > 0xff || b > 0xff || c > 0xff || d > 0xff) return null;
    packed = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
  }
  return v4From((packed >>> 16) & 0xffff, packed & 0xffff);
}

function parsePart(part: string): number | null {
  if (part.length === 0 || part.length > 10) return null;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const value = Number.parseInt(part, 16);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (/^0[0-7]+$/.test(part)) {
    const value = Number.parseInt(part, 8);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (/^[1-9][0-9]*$/.test(part) || part === "0") {
    const value = Number.parseInt(part, 10);
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
}

function v4From(hi: number, lo: number): string {
  return `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
}

function formatV6(groups: number[]): string {
  return groups.map((part) => part.toString(16)).join(":");
}
