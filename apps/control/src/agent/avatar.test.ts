import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, sniffImage } from "./avatar.js";

describe("avatar sniff", () => {
  it("accepts png, jpeg, and webp by content", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const webp = Buffer.alloc(12);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    expect(sniffImage(png)).toBe("image/png");
    expect(sniffImage(jpeg)).toBe("image/jpeg");
    expect(sniffImage(webp)).toBe("image/webp");
  });

  it("rejects the wrong type, an empty file, and anything over 1 MiB", () => {
    expect(sniffImage(Buffer.from("GIF89a"))).toBeUndefined();
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(AVATAR_MAX_BYTES + 1, 0xff))).toBeUndefined();
  });
});
