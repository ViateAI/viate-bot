import { describe, expect, it } from "vitest";
import { THEME_KEY, applyTheme, nextTheme, readTheme, writeTheme } from "./theme.js";

function memoryStorage(initial?: string): Storage {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(THEME_KEY, initial);
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, value),
  };
}

describe("viate-theme", () => {
  it("falls back to the system preference when viate-theme is missing or invalid", () => {
    expect(readTheme(memoryStorage(), true)).toBe("dark");
    expect(readTheme(memoryStorage(), false)).toBe("light");
    expect(readTheme(memoryStorage("system"), true)).toBe("dark");
    expect(readTheme(memoryStorage(""), false)).toBe("light");
  });

  it("reads and writes localStorage viate-theme, and toggles light and dark", () => {
    const storage = memoryStorage();
    writeTheme(storage, "dark");
    expect(storage.getItem(THEME_KEY)).toBe("dark");
    expect(readTheme(storage, false)).toBe("dark");
    writeTheme(storage, nextTheme("dark"));
    expect(storage.getItem(THEME_KEY)).toBe("light");
    expect(readTheme(storage, true)).toBe("light");
    expect(nextTheme("light")).toBe("dark");
  });

  it("applies the chosen theme on the document element", () => {
    const root = { dataset: {} as DOMStringMap };
    applyTheme("dark", root);
    expect(root.dataset.theme).toBe("dark");
    applyTheme(nextTheme("dark"), root);
    expect(root.dataset.theme).toBe("light");
  });
});
