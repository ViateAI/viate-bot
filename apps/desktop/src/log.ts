import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FORBIDDEN = /token|secret|authorization|cookie|host|address|target|url|destination/i;

export interface Logger {
  write(event: string, fields?: Record<string, string | number | boolean>): void;
}

export function createLogger(file: string): Logger {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return {
    write(event, fields = {}) {
      const body: Record<string, string | number | boolean> = { event };
      for (const [key, value] of Object.entries(fields)) {
        if (FORBIDDEN.test(key)) continue;
        body[key] = value;
      }
      const existed = existsSync(file);
      appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), ...body })}\n`);
      if (!existed) chmodSync(file, 0o600);
    },
  };
}
