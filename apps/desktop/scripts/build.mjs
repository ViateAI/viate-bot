import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const mode = process.argv[2] === "test" ? "test" : "release";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dev = mode === "test";
const outfile = join(root, "dist/main.cjs");

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(join(root, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, mode === "test" ? "src/main-test.ts" : "src/main-release.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  external: ["electron", "bufferutil", "utf-8-validate"],
  define: { __VB_DESKTOP_DEV__: dev ? "true" : "false" },
  legalComments: "none",
});
await build({
  entryPoints: [join(root, "src/preload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(root, "dist/preload.cjs"),
  external: ["electron"],
  legalComments: "none",
});
cpSync(join(root, "src/renderer"), join(root, "dist/renderer"), { recursive: true });

if (!dev) {
  const js = readFileSync(outfile, "utf8");
  for (const marker of ["VB_EGRESS_ALLOW_PRIVATE", "devPrivateAllowlist", "allow-private"]) {
    if (js.includes(marker)) throw new Error(`发布构建包含测试入口 ${marker}`);
  }
}

const stage = join(root, "stage");
rmSync(stage, { recursive: true, force: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
writeFileSync(join(stage, "package.json"), `${JSON.stringify({
  name: "viate-bot",
  version: "0.0.1",
  private: true,
  main: "dist/main.cjs",
  productName: "viate-bot",
}, null, 2)}\n`);
writeIcon(join(root, "build/icon.png"));

function writeIcon(file) {
  const size = 512;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const dx = x - size / 2;
      const dy = y - size / 2;
      const on = dx * dx + dy * dy <= (size * 0.28) ** 2;
      const i = row + 1 + x * 4;
      raw[i] = on ? 32 : 0;
      raw[i + 1] = on ? 32 : 0;
      raw[i + 2] = on ? 32 : 0;
      raw[i + 3] = on ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
