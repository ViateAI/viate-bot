import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./log.js";
import { encryptedTokenStore, type StringCipher } from "./secrets.js";
import { readDesktopSettings, writeDesktopSettings } from "./settings.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vb-desktop-"));
  dirs.push(dir);
  return dir;
}

function cipher(available = true): StringCipher {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(Buffer.from(plain, "utf8").toString("base64"), "utf8"),
    decrypt: (blob) => Buffer.from(blob.toString("utf8"), "base64").toString("utf8"),
  };
}

describe("desktop shell storage", () => {
  it("refuses to store a token when encryption is unavailable", () => {
    const file = join(tempDir(), "nested", "device-token.bin");
    const store = encryptedTokenStore(file, cipher(false));
    expect(() => store.write("plain-token")).toThrow(/拒绝保存/);
    expect(() => statSync(file)).toThrow();
    expect(store.read()).toBeNull();
  });

  it("stores ciphertext and deletes it on logout", async () => {
    const file = join(tempDir(), "device-token.bin");
    const store = encryptedTokenStore(file, cipher(true));
    await store.write("plain-token");
    expect(readFileSync(file).includes(Buffer.from("plain-token"))).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.read()).toBe("plain-token");
    await store.clear();
    expect(() => statSync(file)).toThrow();
    expect(await store.read()).toBeNull();
  });

  it("does not write tokens, target hosts, or addresses to the log", () => {
    const file = join(tempDir(), "logs", "desktop.log");
    const log = createLogger(file);
    log.write("dial", { category: "blocked", token: "secret-token", host: "10.1.2.3", address: "10.1.2.3", url: "https://secret.example" });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("blocked");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("10.1.2.3");
    expect(text).not.toContain("secret.example");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps login and fake-ip off by default and does not persist a token field", () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    expect(readDesktopSettings(file)).toMatchObject({ baseUrl: "", allowFakeIp: false, openAtLogin: false, statsBytes: 0 });
    writeDesktopSettings(file, { baseUrl: "https://bot.example", allowFakeIp: true, openAtLogin: false, statsDay: "2026-11-17", statsBytes: 12 });
    expect(readDesktopSettings(file)).toEqual({
      baseUrl: "https://bot.example",
      allowFakeIp: true,
      openAtLogin: false,
      statsDay: "2026-11-17",
      statsBytes: 12,
    });
    writeFileSync(file, "{\"token\":\"secret-token\",\"baseUrl\":\"https://bot.example\"}", "utf8");
    expect(readDesktopSettings(file).baseUrl).toBe("https://bot.example");
    writeDesktopSettings(file, readDesktopSettings(file));
    expect(readFileSync(file, "utf8")).not.toContain("secret-token");
    writeFileSync(file, "{", "utf8");
    expect(readDesktopSettings(file).allowFakeIp).toBe(false);
  });
});
