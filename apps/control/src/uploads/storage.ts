import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { GetObjectCommandOutput, S3ClientConfig } from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import type { ControlConfig, S3UploadConfig } from "../config.js";

export interface UploadStorage {
  put(userId: string, id: string, source: string | Readable, size: number): Promise<void>;
  get(userId: string, id: string): Promise<Readable>;
  exists(userId: string, id: string): Promise<boolean>;
  remove(userId: string, id: string): Promise<void>;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function uploadObjectKey(prefix: string, userId: string, id: string): string {
  if (!SEGMENT.test(userId) || !SEGMENT.test(id)) throw new Error("附件标识无效");
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  const head = trimmed.length > 0 ? `${trimmed}/` : "";
  return `${head}uploads/${userId}/${id}`;
}

export function localUploadStorage(dataDir: string): UploadStorage {
  return {
    async put(userId, id, source, size) {
      const dest = localPath(dataDir, userId, id);
      mkdirSync(dirname(dest), { recursive: true });
      if (typeof source !== "string") {
        await writeChecked(dest, source, size);
        return;
      }
      const info = await stat(source);
      if (info.size !== size) throw new Error("附件大小不一致");
      await rename(source, dest);
    },
    async get(userId, id) {
      const path = localPath(dataDir, userId, id);
      if (!existsSync(path)) throw new Error("找不到附件");
      return createReadStream(path);
    },
    async exists(userId, id) {
      if (!SEGMENT.test(userId) || !SEGMENT.test(id)) return false;
      return existsSync(join(dataDir, "uploads", userId, id));
    },
    async remove(userId, id) {
      if (!SEGMENT.test(userId) || !SEGMENT.test(id)) return;
      await rm(join(dataDir, "uploads", userId, id), { force: true });
    },
  };
}

export function s3UploadStorage(options: S3UploadConfig): UploadStorage {
  const clientConfig: S3ClientConfig = {
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
  if (options.endpoint !== "") clientConfig.endpoint = options.endpoint;
  if (options.accessKeyId !== "" && options.secretAccessKey !== "") {
    clientConfig.credentials = { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey };
  }
  const client = new S3Client(clientConfig);
  const bucket = options.bucket;
  return {
    async put(userId, id, source, size) {
      const Key = uploadObjectKey(options.prefix, userId, id);
      const Body = await openSource(source, size);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentLength: size }));
    },
    async get(userId, id) {
      const Key = uploadObjectKey(options.prefix, userId, id);
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key }));
        return bodyStream(out.Body);
      } catch (error) {
        if (missingObject(error)) throw new Error("找不到附件");
        throw error;
      }
    },
    async exists(userId, id) {
      if (!SEGMENT.test(userId) || !SEGMENT.test(id)) return false;
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: uploadObjectKey(options.prefix, userId, id) }));
        return true;
      } catch (error) {
        if (missingObject(error)) return false;
        throw error;
      }
    },
    async remove(userId, id) {
      const Key = uploadObjectKey(options.prefix, userId, id);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
    },
  };
}

export function createUploadStorage(config: ControlConfig): UploadStorage {
  if (config.uploadStorage === "local") return localUploadStorage(config.dataDir);
  return s3UploadStorage(config.s3);
}

function localPath(dataDir: string, userId: string, id: string): string {
  if (!SEGMENT.test(userId) || !SEGMENT.test(id)) throw new Error("附件标识无效");
  return join(dataDir, "uploads", userId, id);
}

async function openSource(source: string | Readable, size: number): Promise<Readable> {
  if (typeof source !== "string") return source;
  const info = await stat(source);
  if (info.size !== size) throw new Error("附件大小不一致");
  return createReadStream(source);
}

async function writeChecked(dest: string, source: Readable, size: number): Promise<void> {
  const file = createWriteStream(dest);
  let written = 0;
  try {
    for await (const piece of source) {
      const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      written += buf.length;
      if (written > size) break;
      if (!file.write(buf)) await once(file, "drain");
    }
    await endFile(file);
  } catch (error) {
    file.destroy();
    await rm(dest, { force: true });
    throw error;
  }
  if (written !== size) {
    await rm(dest, { force: true });
    throw new Error("附件大小不一致");
  }
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

function bodyStream(body: GetObjectCommandOutput["Body"]): Readable {
  if (!body) throw new Error("找不到附件");
  if (body instanceof Readable) return body;
  return Readable.from(body as AsyncIterable<Uint8Array>);
}

function missingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return named.$metadata?.httpStatusCode === 404 || named.name === "NotFound" || named.name === "NoSuchKey";
}
