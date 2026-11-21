import { useCallback, useState } from "react";

export const THEME_KEY = "viate-theme";

export type ThemeName = "light" | "dark";

export function readTheme(storage: Pick<Storage, "getItem">, prefersDark: boolean): ThemeName {
  const stored = storage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function writeTheme(storage: Pick<Storage, "setItem">, theme: ThemeName): void {
  storage.setItem(THEME_KEY, theme);
}

export function nextTheme(theme: ThemeName): ThemeName {
  return theme === "dark" ? "light" : "dark";
}

export function applyTheme(theme: ThemeName, root: { dataset: DOMStringMap } = document.documentElement): void {
  root.dataset.theme = theme;
}

export function useTheme(): { theme: ThemeName; toggleTheme: () => void } {
  const [theme, setTheme] = useState<ThemeName>(() => {
    if (typeof document === "undefined") return "light";
    const current = document.documentElement.dataset.theme;
    if (current === "light" || current === "dark") return current;
    const prefersDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
    try {
      return readTheme(localStorage, prefersDark);
    } catch {
      return prefersDark ? "dark" : "light";
    }
  });

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = nextTheme(current);
      try {
        writeTheme(localStorage, next);
      } catch {
        /* keep the in-memory choice when storage is blocked */
      }
      applyTheme(next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
