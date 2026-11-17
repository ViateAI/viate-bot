import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DesktopSettings {
  baseUrl: string;
  allowFakeIp: boolean;
  openAtLogin: boolean;
  statsDay: string;
  statsBytes: number;
}

export function readDesktopSettings(file: string): DesktopSettings {
  const settings: DesktopSettings = { baseUrl: "", allowFakeIp: false, openAtLogin: false, statsDay: "", statsBytes: 0 };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return settings;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return settings;
  }
  if (!value || typeof value !== "object") return settings;
  const record = value as Record<string, unknown>;
  if (typeof record.baseUrl === "string") settings.baseUrl = record.baseUrl;
  if (record.allowFakeIp === true) settings.allowFakeIp = true;
  if (record.openAtLogin === true) settings.openAtLogin = true;
  if (typeof record.statsDay === "string") settings.statsDay = record.statsDay;
  if (Number.isInteger(record.statsBytes) && typeof record.statsBytes === "number" && record.statsBytes >= 0) settings.statsBytes = record.statsBytes;
  return settings;
}

export function writeDesktopSettings(file: string, settings: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const body = {
    baseUrl: settings.baseUrl,
    allowFakeIp: settings.allowFakeIp,
    openAtLogin: settings.openAtLogin,
    statsDay: settings.statsDay,
    statsBytes: settings.statsBytes,
  };
  writeFileSync(file, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
