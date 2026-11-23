import { useRef, useSyncExternalStore } from "react";

const desktopQuery = "(min-width: 1024px)";

function desktopMedia() {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? undefined : window.matchMedia(desktopQuery);
}

export function isWorkDesktop(): boolean {
  return desktopMedia()?.matches ?? false;
}

function subscribeDesktop(onChange: () => void) {
  const media = desktopMedia();
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

export function workPageFrame(pathname: string): string | undefined {
  switch (pathname.replace(/\/$/, "")) {
    case "/apps":
    case "/admin/apps":
    case "/admin/app-reviews":
      return "work-page-wide";
    case "/approvals":
    case "/secrets":
    case "/admin":
    case "/admin/machines":
    case "/admin/templates":
    case "/admin/settings":
    case "/admin/metrics":
    case "/admin/audit":
      return "work-page";
    default:
      return undefined;
  }
}

/** Desktop shows the chosen row, or the first visible row. Mobile stays on the list until a visible row is chosen. */
export function resolveMasterId(selectedId: string | null, visibleIds: readonly string[], desktop: boolean): string | null {
  const selected = selectedId !== null && visibleIds.includes(selectedId) ? selectedId : null;
  if (!desktop) return selected;
  return selected ?? visibleIds[0] ?? null;
}

export function useWorkDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, isWorkDesktop, () => false);
}

export function useMasterReturn() {
  const master = useRef<HTMLDivElement>(null);
  const origin = useRef<{ row: HTMLButtonElement; stage: HTMLElement; top: number } | null>(null);

  function remember(row: HTMLButtonElement) {
    const stage = row.closest<HTMLElement>(".stage-fill");
    if (stage) origin.current = { row, stage, top: stage.scrollTop };
  }

  function restore() {
    const previous = origin.current;
    origin.current = null;
    requestAnimationFrame(() => {
      const list = master.current;
      if (!list?.getClientRects().length) return;
      const row = previous?.row;
      const target = row && list.contains(row) ? row : list.querySelector<HTMLElement>("input, button");
      (target ?? list).focus({ preventScroll: true });
      if (previous) previous.stage.scrollTop = previous.top;
    });
  }

  return { master, remember, restore };
}
