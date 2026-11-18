export function usesMarkdown(role: string, isError: boolean | undefined): boolean {
  return role === "assistant" && isError !== true;
}
