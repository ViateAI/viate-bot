import { Readable } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import { localUploadStorage, type UploadStorage } from "./storage.js";
import type { AttachmentRef } from "./store.js";
import { MAX_UPLOAD_BYTES, sniffUpload } from "./store.js";

export const IMAGE_RETAIN_TURNS = 2;
export const IMAGE_MODEL_BYTES = 5 * 1024 * 1024;
const IMAGE_CAP = 10;

export interface PresentedEntry {
  id: string;
  message: AgentMessage;
  attachments: AttachmentRef[];
}

export async function presentForModel(
  entries: readonly PresentedEntry[],
  options: {
    vision: boolean;
    userId: string;
    dataDir?: string;
    storage?: UploadStorage;
    retainTurns?: number;
    unavailable?: (id: string) => boolean;
  },
): Promise<PresentedEntry[]> {
  const storage = options.storage ?? (options.dataDir === undefined ? undefined : localUploadStorage(options.dataDir));
  const retain = options.retainTurns ?? IMAGE_RETAIN_TURNS;
  const presented: PresentedEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.message.role !== "user" || entry.attachments.length === 0 || !storage) {
      presented.push({ ...entry });
      continue;
    }
    const later = entries.slice(index + 1).filter((item) => item.message.role === "user").length;
    const allowImages = options.vision && later <= retain;
    const lines: string[] = [];
    const images: ImageContent[] = [];
    const base = typeof entry.message.content === "string"
      ? entry.message.content
      : entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    for (const file of entry.attachments) {
      const remote = `/home/bot/uploads/${file.place ?? entry.id}/${file.name}`;
      const tooBig = file.size > IMAGE_MODEL_BYTES;
      let bytes: Buffer | undefined;
      if (!tooBig && options.unavailable?.(file.id) !== true) {
        try {
          bytes = await readBounded(await storage.get(options.userId, file.id), MAX_UPLOAD_BYTES);
        } catch {
          bytes = undefined;
        }
      }
      const sniffed = sniffUpload(bytes ? bytes.subarray(0, 16) : Buffer.alloc(0));
      const mime = sniffed.kind === "image" ? sniffed.mime : file.mime;
      const reason = tooBig ? "，超过 5 MB，未发给模型" : "";
      lines.push(`附件：${remote}（${formatSize(file.size)}，${mime}${reason}）`);
      if (allowImages && !tooBig && sniffed.kind === "image" && bytes && images.length < IMAGE_CAP) {
        images.push({ type: "image", data: bytes.toString("base64"), mimeType: sniffed.mime });
      }
    }
    const note = lines.join("\n");
    const text = base.length > 0 ? `${base}\n${note}` : note;
    const next: UserMessage = {
      role: "user",
      timestamp: entry.message.timestamp,
      content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
    };
    presented.push({ ...entry, message: next });
  }
  return presented;
}

/** 每一轮模型请求前按用户轮次丢掉过期图片。只改送出的副本，不改已经记下的消息。 */
export function cropUserImages(messages: readonly AgentMessage[], options: { vision: boolean; retainTurns?: number }): AgentMessage[] {
  const retain = options.retainTurns ?? IMAGE_RETAIN_TURNS;
  return messages.map((message, index) => {
    if (message.role !== "user" || typeof message.content === "string") return message;
    const later = messages.slice(index + 1).filter((item) => item.role === "user").length;
    if (options.vision && later <= retain) return message;
    if (!message.content.some((block) => block.type === "image")) return message;
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    return { ...message, content: text };
  });
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) {
    const text = (size / (1024 * 1024)).toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text} MB`;
  }
  if (size >= 1024) {
    const text = (size / 1024).toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text} KB`;
  }
  return `${size} B`;
}

async function readBounded(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const piece of stream) {
    const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    total += buf.length;
    if (total > max) {
      stream.destroy();
      throw new Error("附件超过上限");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
