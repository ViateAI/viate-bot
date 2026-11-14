export const HEAD_TAIL_BYTES = 8 * 1024;
export const FS_READ_LIMIT = 64 * 1024;

/** 保留首尾各 8 KB。machined 已经这样做，控制面再挡一层过大的返回。 */
export function capHeadTail(text: string, limit = HEAD_TAIL_BYTES): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= limit * 2) return text;
  const head = buffer.subarray(0, limit).toString("utf8");
  const tail = buffer.subarray(buffer.length - limit).toString("utf8");
  const dropped = buffer.length - limit * 2;
  return `${head}\n…[截断 ${dropped} 字节]…\n${tail}`;
}

export function redactSecret(text: string, secret: string): string {
  if (secret.length < 4 || !text.includes(secret)) return text;
  return text.split(secret).join("[redacted]");
}

export function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}
