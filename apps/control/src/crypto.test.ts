import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decrypt, encrypt, loadOrCreateKey } from "./crypto.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "vb-crypto-"));
  dirs.push(dir);
  return dir;
}

describe("secret key file", () => {
  it("creates a 0600 32-byte key and reuses it", () => {
    const path = join(scratch(), "secret.key");
    const first = loadOrCreateKey(path);
    const second = loadOrCreateKey(path);
    expect(first.equals(second)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a key of the wrong length", () => {
    const path = join(scratch(), "secret.key");
    writeFileSync(path, Buffer.alloc(16));
    chmodSync(path, 0o600);
    expect(() => loadOrCreateKey(path)).toThrow(/32 字节/);
  });
});

describe("aes-256-gcm", () => {
  it("round-trips and rejects a tampered payload", () => {
    const key = Buffer.alloc(32, 7);
    const encoded = encrypt(key, "bot-token");
    expect(decrypt(key, encoded)).toBe("bot-token");
    const bytes = Buffer.from(encoded, "base64url");
    const last = bytes[bytes.length - 1];
    if (last === undefined) throw new Error("empty");
    bytes[bytes.length - 1] = last ^ 1;
    expect(() => decrypt(key, bytes.toString("base64url"))).toThrow();
    expect(() => decrypt(Buffer.alloc(32, 8), encoded)).toThrow();
  });
});
