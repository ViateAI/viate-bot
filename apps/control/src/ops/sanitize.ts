const FORBIDDEN = new Set([
  "args",
  "body",
  "cmd",
  "config",
  "content",
  "env",
  "headers",
  "message",
  "password",
  "png",
  "pngbase64",
  "prompt",
  "screenshot",
  "secret",
  "stderr",
  "stdout",
  "summary",
  "text",
  "token",
  "value",
]);

/** 管理端指标只留短的 id、状态和计数。正文、截图和密钥在这里丢掉。 */
export function sanitizeAttrs(input: unknown): Record<string, string | number | boolean | null> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (FORBIDDEN.has(key.toLowerCase())) continue;
    if (typeof value === "string") {
      if (value.length > 80 || value.includes("\n") || value.includes("data:image")) continue;
      out[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      out[key] = value;
    }
  }
  return out;
}
