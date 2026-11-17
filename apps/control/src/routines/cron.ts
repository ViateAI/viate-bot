const MINUTE = 60_000;
const LIMIT = 366 * 24 * 60;

type Field = { values: Set<number>; wildcard: boolean };

function field(text: string, min: number, max: number, sunday = false): Field {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error("无效的 cron 字段");
    const start = match[1] === "*" ? min : Number(match[1]);
    const end = match[2] ? Number(match[2]) : match[1] === "*" ? max : start;
    const step = match[3] ? Number(match[3]) : 1;
    if (start < min || end > max || start > end || step < 1) throw new Error("无效的 cron 字段");
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return { values, wildcard: text === "*" };
}

export function parseCron(cron: string, timezone: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 必须有五个字段");
  const [minute, hour, day, month, weekday] = [field(parts[0]!, 0, 59), field(parts[1]!, 0, 23), field(parts[2]!, 1, 31), field(parts[3]!, 1, 12), field(parts[4]!, 0, 7, true)];
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short" });
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return (date: Date): boolean => {
    const p = Object.fromEntries(formatter.formatToParts(date).map((item) => [item.type, item.value]));
    const dom = day.values.has(Number(p.day));
    const dow = weekday.values.has(weekdays[p.weekday!]!);
    const dayMatches = day.wildcard ? dow : weekday.wildcard ? dom : dom || dow;
    return minute.values.has(Number(p.minute)) && hour.values.has(Number(p.hour)) && month.values.has(Number(p.month)) && dayMatches;
  };
}

export function nextCron(cron: string, timezone: string, after: Date): Date {
  const matches = parseCron(cron, timezone);
  const start = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < LIMIT; i++) {
    const date = new Date(start + i * MINUTE);
    if (matches(date)) return date;
  }
  throw new Error("366 天内没有匹配的时间");
}
