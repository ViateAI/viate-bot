import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRandom = "";

/** 本地 ULID。时间 48 位；同一毫秒内递增，后分配的 id 更大。 */
export function ulid(now = Date.now()): string {
  const random = now === lastTime && lastRandom.length === 16 ? increment(lastRandom) : randomText();
  lastTime = now;
  lastRandom = random;
  return encodeTime(now) + random;
}

function encodeTime(now: number): string {
  let time = now;
  let chars = "";
  for (let index = 0; index < 10; index += 1) {
    chars = ENCODING[time % 32]! + chars;
    time = Math.floor(time / 32);
  }
  return chars;
}

function randomText(): string {
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
  return random;
}

function increment(text: string): string {
  const chars = text.split("");
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const at = ENCODING.indexOf(chars[index] ?? "");
    if (at < 0 || at >= ENCODING.length - 1) {
      chars[index] = ENCODING[0]!;
      continue;
    }
    chars[index] = ENCODING[at + 1]!;
    return chars.join("");
  }
  return randomText();
}
