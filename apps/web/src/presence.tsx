const palette = ["#1c1c1c", "#8d6e63", "#7e57c2", "#26a69a", "#fb8c00", "#e53935", "#5c6bc0", "#546e7a"];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length] ?? "#1c1c1c";
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && /^[A-Za-z]/.test(parts[0] ?? "") && /^[A-Za-z]/.test(parts[1] ?? "")) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  const mark = [...trimmed].slice(0, 2).join("");
  return /^[A-Za-z]+$/.test(mark) ? mark.toUpperCase() : mark;
}

export function BotMark({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center font-medium text-white ${className ?? ""}`}
      style={{ background: avatarColor(name || "?") }}
    >
      {initials(name)}
    </span>
  );
}
