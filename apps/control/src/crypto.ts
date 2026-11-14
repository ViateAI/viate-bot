import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VERSION = 1;

export function loadOrCreateKey(path: string): Buffer {
  try {
    const existing = readFileSync(path);
    if (existing.length !== 32) {
      throw new Error(`${path} 必须是 32 字节的 AES-256 密钥，实际是 ${existing.length} 字节`);
    }
    return existing;
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]).toString("base64url");
}

export function decrypt(key: Buffer, encoded: string): string {
  const payload = Buffer.from(encoded, "base64url");
  if (payload.length < 1 + 12 + 16 || payload[0] !== VERSION) {
    throw new Error("无法解密：密文格式不对");
  }
  const iv = payload.subarray(1, 13);
  const tag = payload.subarray(13, 29);
  const ciphertext = payload.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
