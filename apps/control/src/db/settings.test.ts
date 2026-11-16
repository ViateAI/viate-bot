import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./index.js";
import { DEFAULT_PLATFORM_PROMPT, PLATFORM_PROMPT_KEY, settingsRepository } from "./settings.js";

const OLD_BUILTIN = DEFAULT_PLATFORM_PROMPT.split("\n").slice(0, -1).join("\n");

describe("platform prompt", () => {
  it("upgrades an untouched builtin and leaves admin text alone", () => {
    const db = openDatabase(":memory:");
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    const settings = settingsRepository(db);

    expect(settings.platformPrompt()).toEqual({ version: 1, text: DEFAULT_PLATFORM_PROMPT });

    settings.setJson(PLATFORM_PROMPT_KEY, { version: 1, text: OLD_BUILTIN });
    expect(settings.platformPrompt()).toEqual({ version: 1, text: DEFAULT_PLATFORM_PROMPT });
    expect(settings.platformPrompt().text).toContain("不要反复尝试，也不要寻求绕过或破解验证。");

    settings.setJson(PLATFORM_PROMPT_KEY, { version: 1, text: "只回答天气。" });
    expect(settings.platformPrompt()).toEqual({ version: 1, text: "只回答天气。" });

    settings.setJson(PLATFORM_PROMPT_KEY, { version: 2, text: OLD_BUILTIN });
    expect(settings.platformPrompt()).toEqual({ version: 2, text: OLD_BUILTIN });

    db.$client.close();
  });
});
