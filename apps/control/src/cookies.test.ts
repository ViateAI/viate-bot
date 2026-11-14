import { describe, expect, it } from "vitest";
import { cookieSecure, safeReturnPath } from "./cookies.js";

describe("cookie and return path", () => {
  it("drops Secure only for http loopback", () => {
    expect(cookieSecure("http://127.0.0.1:4418")).toBe(false);
    expect(cookieSecure("http://localhost:3000")).toBe(false);
    expect(cookieSecure("http://bot.example")).toBe(true);
    expect(cookieSecure("https://127.0.0.1")).toBe(true);
  });

  it("allows a site-relative path and rejects open redirects", () => {
    expect(safeReturnPath(undefined)).toBe("/");
    expect(safeReturnPath("/home?tab=1")).toBe("/home?tab=1");
    expect(safeReturnPath("/foo/../home")).toBe("/home");
    expect(() => safeReturnPath("https://evil.example")).toThrow(/站内路径/);
    expect(() => safeReturnPath("//evil.example")).toThrow(/站内路径/);
    expect(() => safeReturnPath("/\\evil.example")).toThrow(/站内路径/);
    expect(() => safeReturnPath("/.//evil.example")).toThrow(/站内路径/);
    expect(() => safeReturnPath("/%2e//evil.example")).toThrow(/站内路径/);
    expect(() => safeReturnPath("/foo/..//evil.example")).toThrow(/站内路径/);
  });
});
