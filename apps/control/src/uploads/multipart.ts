import { Readable } from "node:stream";
import { UploadRejected } from "./store.js";

export async function openMultipartFile(source: Readable, contentType: string): Promise<{ filename: string; file: Readable }> {
  const boundary = boundaryOf(contentType);
  const headerEnd = Buffer.from("\r\n\r\n");
  let pending = Buffer.alloc(0);
  while (pending.indexOf(headerEnd) < 0) {
    const chunk = await readChunk(source);
    if (!chunk) throw new UploadRejected("\u9644\u4ef6\u683c\u5f0f\u65e0\u6548", 400);
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 64 * 1024) throw new UploadRejected("\u9644\u4ef6\u683c\u5f0f\u65e0\u6548", 400);
  }
  const splitAt = pending.indexOf(headerEnd);
  const filename = filenameOf(pending.subarray(0, splitAt).toString("latin1"));
  const file = new FileBody(source, pending.subarray(splitAt + headerEnd.length), Buffer.from(`\r\n--${boundary}`));
  return { filename, file };
}

function boundaryOf(contentType: string): string {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const value = match?.[1] ?? match?.[2];
  if (!value) throw new UploadRejected("\u9644\u4ef6\u683c\u5f0f\u65e0\u6548", 400);
  return value;
}

function filenameOf(headers: string): string {
  const star = /filename\*\s*=\s*UTF-8''([^;\r\n]+)/i.exec(headers);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/.exec(headers);
  const plain = quoted?.[1] ?? /filename\s*=\s*([^;\r\n]+)/.exec(headers)?.[1]?.trim();
  if (plain === undefined) return "file";
  return Buffer.from(plain, "latin1").toString("utf8");
}

class FileBody extends Readable {
  private reading = false;
  constructor(
    private readonly source: Readable,
    private pending: Buffer,
    private readonly marker: Buffer,
  ) {
    super({ highWaterMark: 64 * 1024 });
  }

  override _read(): void {
    if (this.reading) return;
    this.reading = true;
    void this.pull();
  }

  private async pull(): Promise<void> {
    try {
      while (!this.destroyed) {
        const index = this.pending.indexOf(this.marker);
        if (index >= 0) {
          const body = this.pending.subarray(0, index);
          this.pending = Buffer.alloc(0);
          if (body.length > 0) this.push(body);
          this.push(null);
          return;
        }
        if (this.pending.length > this.marker.length) {
          const body = this.pending.subarray(0, this.pending.length - this.marker.length);
          this.pending = this.pending.subarray(this.pending.length - this.marker.length);
          if (!this.push(body)) return;
          continue;
        }
        const chunk = await readChunk(this.source);
        if (this.destroyed) return;
        if (!chunk) {
          this.destroy(new UploadRejected("\u9644\u4ef6\u683c\u5f0f\u65e0\u6548", 400));
          return;
        }
        this.pending = Buffer.concat([this.pending, chunk]);
      }
    } catch (error) {
      if (!this.destroyed) this.destroy(error instanceof Error ? error : new Error("\u8bfb\u53d6\u9644\u4ef6\u5931\u8d25"));
    } finally {
      this.reading = false;
    }
  }
}

function readChunk(stream: Readable): Promise<Buffer | null> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer | null>();
  const cleanup = () => {
    stream.off("readable", onReadable);
    stream.off("end", onEnd);
    stream.off("close", onEnd);
    stream.off("error", onError);
  };
  const onReadable = () => {
    const chunk = stream.read() as Buffer | string | null;
    if (chunk === null) return;
    cleanup();
    resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  const onEnd = () => {
    cleanup();
    resolve(null);
  };
  const onError = (error: Error) => {
    cleanup();
    reject(error);
  };
  stream.on("readable", onReadable);
  stream.on("end", onEnd);
  stream.on("close", onEnd);
  stream.on("error", onError);
  onReadable();
  return promise;
}
