import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TokenStore {
  read(): string | null | Promise<string | null>;
  write(token: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

export function fileTokenStore(path: string): TokenStore {
  return {
    read() {
      try {
        const value = readTokenFile(path);
        return value.length > 0 ? value : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write(token) {
      writeTokenFile(path, token);
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}

export function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readTokenFile(path: string): string {
  return readFileSync(path, "utf8").trim();
}
