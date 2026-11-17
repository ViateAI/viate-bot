import { allowPrivatePredicate } from "@viate-bot/protocol";

/**
 * 发布构建不引用这个文件。
 * 测试包用它读 VB_EGRESS_ALLOW_PRIVATE，只放行调用方写明的地址。
 */
export function devPrivateAllowlist(): ((ip: string) => boolean) | undefined {
  const raw = process.env.VB_EGRESS_ALLOW_PRIVATE;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const entries = raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  if (entries.length === 0) return undefined;
  return allowPrivatePredicate(entries);
}
