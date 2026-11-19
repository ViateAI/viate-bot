import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderMessageForSummary } from "../agent/compact.js";
import { presentForModel, type PresentedEntry } from "./present.js";
import type { AttachmentRef } from "./store.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("model attachment notes", () => {
  it("sends a header-sniffed image to a vision model and only a path for a renamed non-image", () => {
    const dir = scratch();
    writeFileSync(join(dir, "uploads", "user-a", "img"), PNG);
    writeFileSync(join(dir, "uploads", "user-a", "fake"), Buffer.from("<svg></svg>"));
    const entries = [entry("m1", "看一下", [
      { id: "img", name: "dot.png", size: PNG.length, mime: "application/octet-stream", kind: "file" },
      { id: "fake", name: "photo.png", size: 11, mime: "image/png", kind: "image" },
    ])];
    const vision = presentForModel(entries, { vision: true, dataDir: dir, userId: "user-a" });
    const encoded = JSON.stringify(vision[0]?.message);
    expect(encoded).toContain("附件：/home/bot/uploads/m1/dot.png");
    expect(encoded).toContain("附件：/home/bot/uploads/m1/photo.png");
    expect(encoded).toContain(PNG.toString("base64"));
    expect(encoded).not.toContain(Buffer.from("<svg></svg>").toString("base64"));
    const blind = presentForModel(entries, { vision: false, dataDir: dir, userId: "user-a" });
    expect(JSON.stringify(blind[0]?.message)).not.toContain(PNG.toString("base64"));
    expect(JSON.stringify(blind[0]?.message)).toContain("附件：/home/bot/uploads/m1/dot.png");
    const summary = renderMessageForSummary(vision[0]!.message);
    expect(summary).toContain("/home/bot/uploads/m1/dot.png");
    expect(summary).not.toContain(PNG.toString("base64"));
  });

  it("keeps an image over 5 MB out of the model and says why", () => {
    const dir = scratch();
    writeFileSync(join(dir, "uploads", "user-a", "big"), PNG);
    const entries = [entry("m1", "看大图", [
      { id: "big", name: "big.png", size: 5 * 1024 * 1024 + 1, mime: "image/png", kind: "image" },
    ])];
    const vision = presentForModel(entries, { vision: true, dataDir: dir, userId: "user-a" });
    const encoded = JSON.stringify(vision[0]?.message);
    expect(encoded).toContain("附件：/home/bot/uploads/m1/big.png");
    expect(encoded).toContain("超过 5 MB");
    expect(encoded).not.toContain(PNG.toString("base64"));
  });

  it("resends the image for two later user turns and then keeps only the path", () => {
    const dir = scratch();
    writeFileSync(join(dir, "uploads", "user-a", "img"), PNG);
    const image = entry("m1", "看一下", [
      { id: "img", name: "dot.png", size: PNG.length, mime: "image/png", kind: "image" },
    ]);
    const withLater = (count: number) => [
      image,
      ...Array.from({ length: count }, (_, index) => entry(`u${index}`, "继续", [])),
    ];
    const kept = presentForModel(withLater(2), { vision: true, dataDir: dir, userId: "user-a" });
    const dropped = presentForModel(withLater(3), { vision: true, dataDir: dir, userId: "user-a" });
    expect(JSON.stringify(kept[0]?.message)).toContain(PNG.toString("base64"));
    expect(JSON.stringify(dropped[0]?.message)).not.toContain(PNG.toString("base64"));
    expect(JSON.stringify(dropped[0]?.message)).toContain("附件：/home/bot/uploads/m1/dot.png");
  });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "vb-present-"));
  dirs.push(dir);
  mkdirSync(join(dir, "uploads", "user-a"), { recursive: true });
  return dir;
}

function entry(id: string, text: string, attachments: AttachmentRef[]): PresentedEntry {
  return { id, message: { role: "user", content: text, timestamp: 1 }, attachments };
}
