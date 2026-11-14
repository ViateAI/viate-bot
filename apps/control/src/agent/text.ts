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

/** 把已知密钥值换回占位符。长的先替换，避免短值先切掉长值。 */
export function maskSecrets(text: string, secrets: Array<{ name: string; value: string }>): string {
  const ordered = secrets
    .filter((item) => item.value.length > 0)
    .sort((left, right) => right.value.length - left.value.length || left.name.localeCompare(right.name));
  let masked = text;
  for (const item of ordered) {
    if (!masked.includes(item.value)) continue;
    masked = masked.split(item.value).join(`{{secret:${item.name}}}`);
  }
  return masked;
}

/** 逐个字符串打码。不能对序列化后的 JSON 打码：转义后的值匹配不上，短值还会改坏 JSON 结构。 */
export function maskDeep<T>(value: T, secrets: Array<{ name: string; value: string }>): T {
  if (typeof value === "string") return maskSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, secrets)) as T;
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[key] = maskDeep(item, secrets);
  return output as T;
}

export function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}
