import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { startFakeModel } from "./fake-model.ts";

test("两张同格式图片按像素判色，并复述实际 shell stdout", async () => {
  const server = await startFakeModel(0);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("假模型没有端口");
  const port: number = address.port;
  const red = solidPng(32, 24, [220, 10, 10]);
  const blue = solidPng(32, 24, [10, 10, 220]);
  assert.equal(red.subarray(0, 8).equals(blue.subarray(0, 8)), true);
  assert.equal(red.toString("base64").slice(0, 32), blue.toString("base64").slice(0, 32));
  assert.notEqual(red.toString("base64"), blue.toString("base64"));
  const stdout = `upload-${crypto.randomUUID()}\n`;
  try {
    const forward = await reply(port, chat(stdout, [red, blue]));
    assert.ok(forward.includes(stdout.trim()));
    assert.ok(forward.indexOf("红色") >= 0 && forward.indexOf("红色") < forward.indexOf("蓝色"));
    const backward = await reply(port, chat(stdout, [blue, red]));
    assert.ok(backward.includes(stdout.trim()));
    assert.ok(backward.indexOf("蓝色") >= 0 && backward.indexOf("蓝色") < backward.indexOf("红色"));
    const prefix = await reply(port, {
      messages: [
        { role: "user", content: `e2e-upload ${red.toString("base64").slice(0, 24)}` },
        { role: "tool", content: stdout },
      ],
    });
    assert.ok(prefix.includes(stdout.trim()));
    assert.equal(prefix.includes("红色") || prefix.includes("蓝色"), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function chat(stdout: string, images: Buffer[]): unknown {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "e2e-upload\n/home/bot/uploads/abc/notes.txt" },
          ...images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
          })),
        ],
      },
      { role: "tool", content: stdout },
    ],
  };
}

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc ^ 0xffffffff;
}

async function reply(port: number, body: unknown): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const sse = await response.text();
  const line = sse.split("\n").find((item) => item.startsWith("data: {") && item.includes("\"content\""));
  const payload: unknown = JSON.parse(line?.slice(6) ?? "null");
  if (typeof payload !== "object" || payload === null || !("choices" in payload) || !Array.isArray(payload.choices)) return "";
  const choice: unknown = payload.choices[0];
  if (typeof choice !== "object" || choice === null || !("delta" in choice)) return "";
  const delta = choice.delta;
  if (typeof delta !== "object" || delta === null || !("content" in delta) || typeof delta.content !== "string") return "";
  return delta.content;
}
