import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 本地 ULID。时间 48 位，随机 80 位。 */
export function ulid(now = Date.now()): string {
  let time = now;
  let chars = "";
  for (let i = 0; i < 10; i += 1) {
    chars = ENCODING[time % 32]! + chars;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(10);
  let random = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += ENCODING[(buffer >> bits) & 31]!;
    }
  }
  return chars + random;
}
