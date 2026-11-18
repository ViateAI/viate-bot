/** Cache key is the bot row version, not the list refetch time. No avatar means no image. */
export function botAvatarUrl(id: string, avatar: string | null | undefined, version: string | null | undefined): string | undefined {
  if (!avatar) return undefined;
  return `/api/bots/${id}/avatar?v=${encodeURIComponent(version ?? "")}`;
}
