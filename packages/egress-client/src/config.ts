import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ClientConfig { allowFakeIp: boolean }

export function readClientConfig(path: string): ClientConfig {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { allowFakeIp: false };
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("allowFakeIp" in value) || typeof value.allowFakeIp !== "boolean") {
    throw new Error("客户端配置 allowFakeIp 必须是布尔值");
  }
  return { allowFakeIp: value.allowFakeIp };
}

export function writeClientConfig(path: string, config: ClientConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
}
