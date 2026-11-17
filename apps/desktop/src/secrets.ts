import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenStore } from "@viate-bot/egress-client";

export interface StringCipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

export function encryptedTokenStore(file: string, cipher: StringCipher): TokenStore {
  return {
    read() {
      try {
        const blob = readFileSync(file);
        if (!cipher.available()) throw new Error("系统加密不可用，无法读取设备令牌");
        const plain = cipher.decrypt(blob);
        return plain.length > 0 ? plain : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write(token) {
      if (!cipher.available()) throw new Error("系统加密不可用，已拒绝保存设备令牌");
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, cipher.encrypt(token), { mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
    },
    clear() {
      rmSync(file, { force: true });
      rmSync(`${file}.tmp`, { force: true });
    },
  };
}
