import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readTokenFile(path: string): string {
  return readFileSync(path, "utf8").trim();
}
