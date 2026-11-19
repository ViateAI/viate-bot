import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, rmSync, type WriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { AppDatabase } from "../db/index.js";
import { ulid } from "../id.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_USER_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const UNREFERENCED_UPLOAD_MS = 24 * 60 * 60 * 1000;
export const MAX_MESSAGE_ATTACHMENTS = 10;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const NAME_BYTES = 128;

export class UploadRejected extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "UploadRejected";
  }
}

export interface SavedUpload {
  id: string;
  userId: string;
  messageId: string | null;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  kind: "image" | "file";
  createdAt: string;
}

export interface AttachmentRef {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: "image" | "file";
  /** 机器路径目录。只在投递时确定，不当消息顺序。 */
  place?: string;
}

export interface SaveUploadInput {
  db: AppDatabase;
  dataDir: string;
  userId: string;
  filename: string;
  stream: Readable;
  now: Date;
}

export async function saveUpload(input: SaveUploadInput): Promise<SavedUpload> {
  if (!safeSegment(input.userId)) throw new UploadRejected("\u627e\u4e0d\u5230\u7528\u6237", 404);
  const id = ulid(input.now.getTime());
  const dir = join(input.dataDir, "uploads", input.userId);
  mkdirSync(dir, { recursive: true });
  const partPath = join(dir, `${id}.part`);
  const finalPath = join(dir, id);
  const file = createWriteStream(partPath);
  const hasher = createHash("sha256");
  const heads: Buffer[] = [];
  let headLen = 0;
  let size = 0;
  let overflow = false;
  const ignoreError = () => {};
  input.stream.on("error", ignoreError);
  try {
    try {
      for await (const piece of input.stream) {
        const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        if (size + buf.length > MAX_UPLOAD_BYTES) {
          overflow = true;
          break;
        }
        size += buf.length;
        hasher.update(buf);
        if (headLen < 16) {
          heads.push(buf);
          headLen += buf.length;
        }
        if (!file.write(buf)) await once(file, "drain");
      }
    } finally {
      input.stream.off("error", ignoreError);
      if (!input.stream.destroyed) input.stream.destroy();
    }
    if (overflow) throw new UploadRejected("\u5355\u4e2a\u6587\u4ef6\u4e0d\u80fd\u8d85\u8fc7 25 MB", 413);
    await endFile(file);
    const sniffed = sniffUpload(Buffer.concat(heads).subarray(0, 16));
    const createdAt = input.now.toISOString();
    const sha256 = hasher.digest("hex");
    const name = insertUpload(input.db, {
      id,
      userId: input.userId,
      filename: input.filename,
      size,
      mime: sniffed.mime,
      sha256,
      kind: sniffed.kind,
      createdAt,
    });
    await rename(partPath, finalPath);
    return {
      id,
      userId: input.userId,
      messageId: null,
      name,
      size,
      mime: sniffed.mime,
      sha256,
      kind: sniffed.kind,
      createdAt,
    };
  } catch (error) {
    file.on("error", ignoreError);
    file.destroy();
    await rm(partPath, { force: true });
    throw error;
  }
}

export function findOwnedUpload(db: AppDatabase, userId: string, id: string): SavedUpload | undefined {
  if (!safeSegment(userId) || !safeSegment(id)) return undefined;
  const row = db.$client
    .prepare(
      `select id, user_id as userId, message_id as messageId, name, size, mime, sha256, kind, created_at as createdAt
       from uploads where id=? and user_id=?`,
    )
    .get(id, userId) as SavedUpload | undefined;
  if (!row || (row.kind !== "image" && row.kind !== "file")) return undefined;
  return row;
}

export function readAttachments(db: AppDatabase, userId: string, uploadIds: readonly string[], dataDir: string): AttachmentRef[] {
  if (uploadIds.length > MAX_MESSAGE_ATTACHMENTS) throw new UploadRejected("一条消息最多 10 个附件", 400);
  if (new Set(uploadIds).size !== uploadIds.length) throw new UploadRejected("附件重复", 400);
  const refs: AttachmentRef[] = [];
  let total = 0;
  for (const id of uploadIds) {
    const row = findOwnedUpload(db, userId, id);
    if (!row) throw new UploadRejected("找不到附件", 404);
    if (row.messageId !== null) throw new UploadRejected("附件已经发送过", 409);
    const ready = ownedUploadPath(dataDir, userId, row.id);
    if (!ready || !existsSync(ready)) throw new UploadRejected("附件还没准备好", 409);
    total += row.size;
    refs.push({ id: row.id, name: row.name, size: row.size, mime: row.mime, kind: row.kind });
  }
  if (total > MAX_MESSAGE_ATTACHMENT_BYTES) throw new UploadRejected("附件合计不能超过 100 MB", 400);
  return refs;
}

export function claimUploads(db: AppDatabase, userId: string, messageId: string, uploadIds: readonly string[]): void {
  for (const id of uploadIds) {
    const result = db.$client
      .prepare("update uploads set message_id=? where id=? and user_id=? and message_id is null")
      .run(messageId, id, userId);
    if (result.changes !== 1) throw new UploadRejected("附件已经发送过", 409);
  }
}

export function deliveredUploadIds(db: AppDatabase, userId: string, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const marks = ids.map(() => "?").join(", ");
  const rows = db.$client
    .prepare(`select id from uploads where user_id=? and delivered_at is not null and id in (${marks})`)
    .all(userId, ...ids) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

export function markUploadDelivered(db: AppDatabase, userId: string, id: string, at: string): void {
  const updated = db.$client
    .prepare("update uploads set delivered_at=? where id=? and user_id=? and delivered_at is null")
    .run(at, id, userId);
  if (updated.changes !== 1) throw new Error("无法记录附件已经投递");
}

/** 这次发送没有写成消息。清掉投递标记，避免下一次新消息路径被旧标记跳过。 */
export function clearUnclaimedDeliveries(db: AppDatabase, userId: string, ids: readonly string[]): void {
  for (const id of ids) {
    db.$client.prepare("update uploads set delivered_at=null where id=? and user_id=? and message_id is null").run(id, userId);
  }
}

export function ownedUploadPath(dataDir: string, userId: string, id: string): string | undefined {
  if (!safeSegment(userId) || !safeSegment(id)) return undefined;
  return join(dataDir, "uploads", userId, id);
}

export function cleanupUnreferencedUploads(db: AppDatabase, dataDir: string, now: Date, maxAgeMs = UNREFERENCED_UPLOAD_MS): number {
  const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
  const rows = db.$client
    .prepare("select id, user_id as userId from uploads where message_id is null and created_at <= ?")
    .all(cutoff) as Array<{ id: string; userId: string }>;
  let removed = 0;
  for (const row of rows) {
    const path = ownedUploadPath(dataDir, row.userId, row.id);
    if (!path) continue;
    try {
      rmSync(path, { force: true });
    } catch {
      continue;
    }
    const deleted = db.$client.prepare("delete from uploads where id=? and message_id is null").run(row.id);
    if (deleted.changes === 1) removed += 1;
  }
  return removed;
}

function insertUpload(
  db: AppDatabase,
  row: { id: string; userId: string; filename: string; size: number; mime: string; sha256: string; kind: "image" | "file"; createdAt: string },
): string {
  const tx = db.$client.transaction(() => {
    const used = db.$client.prepare("select coalesce(sum(size), 0) from uploads where user_id=?").pluck().get(row.userId);
    if (Number(used) + row.size > MAX_USER_UPLOAD_BYTES) throw new UploadRejected("\u4e0a\u4f20\u7a7a\u95f4\u5df2\u6ee1\uff0c\u8bf7\u5220\u9664\u65e7\u5bf9\u8bdd", 413);
    const names = db.$client.prepare("select name from uploads where user_id=?").all(row.userId) as Array<{ name: string }>;
    const name = uniqueName(new Set(names.map((item) => item.name)), row.filename);
    db.$client
      .prepare(
        `insert into uploads (id, user_id, message_id, name, size, mime, sha256, kind, created_at)
         values (?, ?, null, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.userId, name, row.size, row.mime, row.sha256, row.kind, row.createdAt);
    return name;
  });
  return tx();
}

export function sanitizeUploadName(raw: string): string {
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  const parts = stripped.split(/[/\\]/);
  const last = parts[parts.length - 1] ?? "";
  const base = last === "" || last === "." || last === ".." ? "file" : last;
  return limitName(base, NAME_BYTES);
}

function uniqueName(used: Set<string>, raw: string): string {
  const base = sanitizeUploadName(raw);
  if (!used.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = withIndex(base, index);
    if (!used.has(candidate)) return candidate;
  }
  throw new UploadRejected("\u6587\u4ef6\u540d\u51b2\u7a81", 409);
}

function withIndex(name: string, index: number): string {
  const suffix = `-${index}`;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const suffixBytes = Buffer.byteLength(suffix);
  const extBytes = Buffer.byteLength(ext);
  if (suffixBytes + extBytes >= NAME_BYTES) return truncateUtf8(`${suffix}${ext}`, NAME_BYTES);
  return truncateUtf8(stem, NAME_BYTES - suffixBytes - extBytes) + suffix + ext;
}

function limitName(name: string, max: number): string {
  if (Buffer.byteLength(name) <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const extBytes = Buffer.byteLength(ext);
  if (extBytes === 0 || extBytes >= max) return truncateUtf8(name, max);
  return truncateUtf8(name.slice(0, dot), max - extBytes) + ext;
}

function truncateUtf8(value: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > max) break;
    out += char;
    bytes += size;
  }
  return out.length > 0 ? out : "file";
}

export function sniffUpload(head: Buffer): { mime: string; kind: "image" | "file" } {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", kind: "image" };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: "image/jpeg", kind: "image" };
  const gif = head.length >= 6 ? head.subarray(0, 6).toString("ascii") : "";
  if (gif === "GIF87a" || gif === "GIF89a") return { mime: "image/gif", kind: "image" };
  if (head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mime: "image/webp", kind: "image" };
  }
  return { mime: "application/octet-stream", kind: "file" };
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function endFile(file: WriteStream): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onError = (error: Error) => reject(error);
  file.once("error", onError);
  file.end(() => {
    file.off("error", onError);
    resolve();
  });
  return promise;
}
