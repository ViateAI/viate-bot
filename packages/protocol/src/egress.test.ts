import { describe, expect, it } from "vitest";
import {
  EGRESS_MAX_DATA,
  allowPrivatePredicate,
  checkEgressTarget,
  decodeEgressFrame,
  encodeEgressFrame,
  isBlockedIp,
  parseIpLiteral,
  parseIpv4Literal,
} from "./egress.js";

describe("egress frames", () => {
  it("round-trips every frame type and rejects oversized DATA", () => {
    const frames = [
      encodeEgressFrame({ type: "OPEN", streamId: 7, host: "example.com", port: 443 }),
      encodeEgressFrame({ type: "OPEN_OK", streamId: 7 }),
      encodeEgressFrame({ type: "OPEN_FAIL", streamId: 7, code: "blocked", message: "目标地址不允许" }),
      encodeEgressFrame({ type: "DATA", streamId: 7, payload: Buffer.from("abc") }),
      encodeEgressFrame({ type: "CREDIT", streamId: 7, credit: 12 }),
      encodeEgressFrame({ type: "END", streamId: 7 }),
      encodeEgressFrame({ type: "RESET", streamId: 7 }),
    ];
    expect(frames.map((frame) => decodeEgressFrame(frame))).toEqual([
      { type: "OPEN", streamId: 7, host: "example.com", port: 443 },
      { type: "OPEN_OK", streamId: 7 },
      { type: "OPEN_FAIL", streamId: 7, code: "blocked", message: "目标地址不允许" },
      { type: "DATA", streamId: 7, payload: Buffer.from("abc") },
      { type: "CREDIT", streamId: 7, credit: 12 },
      { type: "END", streamId: 7 },
      { type: "RESET", streamId: 7 },
    ]);
    expect(() => encodeEgressFrame({ type: "DATA", streamId: 1, payload: Buffer.alloc(EGRESS_MAX_DATA + 1) })).toThrow(/64/);
    expect(() => decodeEgressFrame(Buffer.from([4, 0, 0, 0, 0]))).toThrow(/streamId/);
  });
});

describe("egress address check", () => {
  it("resolves ordinary domain names made entirely of hexadecimal letters", async () => {
    expect(await checkEgressTarget("abc.de", async () => ["8.8.8.8"])).toMatchObject({ ok: true, address: "8.8.8.8" });
  });

  it("normalizes decimal, octal, hex and shorthand IPv4", () => {
    expect(parseIpv4Literal("2130706433")).toBe("127.0.0.1");
    expect(parseIpv4Literal("0177.0.0.1")).toBe("127.0.0.1");
    expect(parseIpv4Literal("0x7f.0.0.1")).toBe("127.0.0.1");
    expect(parseIpv4Literal("127.1")).toBe("127.0.0.1");
    expect(parseIpv4Literal("0300.0250.1")).toBe("192.168.0.1");
    expect(parseIpv4Literal("8.8.8.8")).toBe("8.8.8.8");
    expect(parseIpLiteral("08.8.8.8")).toBe("invalid");
  });

  it("blocks private, reserved, mapped and embedded addresses without asking DNS", async () => {
    const resolve = async () => {
      throw new Error("不应该查 DNS");
    };
    const blocked = [
      "127.0.0.1",
      "2130706433",
      "0177.0.0.1",
      "127.1",
      "0x7f.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "240.1.2.3",
      "192.0.2.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "2002:7f00:1::",
      "64:ff9b::7f00:1",
    ];
    for (const host of blocked) {
      const result = await checkEgressTarget(host, resolve);
      expect(result.ok, host).toBe(false);
      if (!result.ok) expect(result.code).toBe("blocked");
    }
    const mappedPublic = await checkEgressTarget("::ffff:8.8.8.8", resolve);
    expect(mappedPublic).toEqual({ ok: true, address: "8.8.8.8", addresses: ["8.8.8.8"] });
    const v6 = await checkEgressTarget("2606:4700:4700::1111", resolve);
    expect(v6.ok).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("198.18.9.106")).toBe(true);
  });

  it("rejects benchmark LANs and non-global IPv6 transition destinations", async () => {
    for (const host of ["198.18.0.1", "64:ff9b:1::a00:1", "2001:0:4136:e378:8000:63bf:80ff:fffe", "4000::1", "::ffff:0:7f00:1"]) {
      expect((await checkEgressTarget(host)).ok, host).toBe(false);
    }
  });

  it("diagnoses fake-ip DNS while retaining the blocked failure code", async () => {
    expect(await checkEgressTarget("public.example", async () => ["198.18.9.106"])).toEqual({
      ok: false, code: "blocked", message: "目标解析到 198.18.0.0/15，疑似 fake-ip DNS；请改用真实 DNS",
    });
  });

  it("blocks a name that resolves to a private address and dials the resolved public IP", async () => {
    const blocked = await checkEgressTarget("rebind.example", async () => ["10.1.2.3"]);
    expect(blocked).toEqual({ ok: false, code: "blocked", message: "目标地址不允许" });
    const mixed = await checkEgressTarget("mixed.example", async () => ["8.8.8.8", "192.168.0.1"]);
    expect(mixed.ok).toBe(false);
    const mapped = await checkEgressTarget("mapped.example", async () => ["::ffff:10.0.0.1"]);
    expect(mapped.ok).toBe(false);
    const ok = await checkEgressTarget("ok.example", async () => ["1.1.1.1", "8.8.8.8"]);
    expect(ok).toEqual({ ok: true, address: "1.1.1.1", addresses: ["1.1.1.1", "8.8.8.8"] });
    const missing = await checkEgressTarget("missing.example", async () => []);
    expect(missing).toMatchObject({ ok: false, code: "dns" });
  });

  it("allows a private address only when the caller passes an explicit predicate", async () => {
    const allow = allowPrivatePredicate(["10.0.0.0/8", "192.168.1.9"]);
    const cidr = await checkEgressTarget("10.1.2.3", async () => {
      throw new Error("literal");
    }, allow);
    expect(cidr).toEqual({ ok: true, address: "10.1.2.3", addresses: ["10.1.2.3"] });
    const exact = await checkEgressTarget("lan.example", async () => ["192.168.1.9"], allow);
    expect(exact.ok).toBe(true);
    const other = await checkEgressTarget("192.168.1.10", async () => ["192.168.1.10"], allow);
    expect(other.ok).toBe(false);
    const def = await checkEgressTarget("10.1.2.3", async () => ["10.1.2.3"]);
    expect(def.ok).toBe(false);
  });
});
