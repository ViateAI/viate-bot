import { describe, expect, it } from "vitest";
import { acceptedBaseUrl, externalAllowed, parseBaseInput } from "./policy.js";

describe("desktop base url", () => {
  it("accepts https origins and loopback http only in dev builds", () => {
    expect(acceptedBaseUrl("https://bot.example/settings", false)).toBe("https://bot.example");
    expect(acceptedBaseUrl("https://bot.example:8443", true)).toBe("https://bot.example:8443");
    expect(acceptedBaseUrl("http://127.0.0.1:4418/client/link", true)).toBe("http://127.0.0.1:4418");
    expect(acceptedBaseUrl("http://localhost:4420", true)).toBe("http://localhost:4420");
    expect(acceptedBaseUrl("http://127.0.0.1:4418", false)).toBeNull();
    expect(acceptedBaseUrl("http://localhost", false)).toBeNull();
    expect(acceptedBaseUrl("http://evil.example", true)).toBeNull();
    expect(acceptedBaseUrl("http://127.0.0.1.evil.example", true)).toBeNull();
    expect(acceptedBaseUrl("https://user:pass@bot.example", false)).toBeNull();
    expect(acceptedBaseUrl("javascript:alert(1)", true)).toBeNull();
    expect(parseBaseInput(1, true)).toEqual({ ok: false, error: "地址无效" });
    expect(parseBaseInput("http://127.0.0.1:4418", false).ok).toBe(false);
    expect(parseBaseInput(" https://bot.example/a ", false)).toEqual({ ok: true, base: "https://bot.example" });
  });

  it("opens only the configured origin's home and link pages", () => {
    const base = "https://bot.example";
    expect(externalAllowed("https://bot.example/", base)).toBe(true);
    expect(externalAllowed("https://bot.example/client/link?state=abc", base)).toBe(true);
    expect(externalAllowed("https://bot.example/api/egress", base)).toBe(false);
    expect(externalAllowed("https://other.example/client/link", base)).toBe(false);
    expect(externalAllowed("https://user:pass@bot.example/client/link", base)).toBe(false);
    expect(externalAllowed("https://bot.example/client/link/../admin", base)).toBe(false);
    expect(externalAllowed("http://127.0.0.1:4418/client/link?x=1", "http://127.0.0.1:4418")).toBe(true);
  });
});
