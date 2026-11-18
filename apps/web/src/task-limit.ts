export function showContinueButton(tasks: Array<{ state: string; error: string | null }>): boolean {
  const latest = tasks[0];
  if (!latest || latest.state !== "failed" || !latest.error) return false;
  return latest.error.includes("达到时长上限") || latest.error.includes("达到步数上限");
}
