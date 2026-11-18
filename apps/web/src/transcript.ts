/** Pixels from the bottom that still count as following the latest content. */
export const TRANSCRIPT_STICK_PX = 48;

export function transcriptNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= TRANSCRIPT_STICK_PX;
}
