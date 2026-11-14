import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function confined() {
  return import("./paths.js");
}

describe("path confinement", () => {
  it("rejects lexical escapes", async () => {
    const { resolveConfined } = await confined();
    expect(() => resolveConfined("/home/bot/../../etc/passwd")).toThrow(/超出/);
    expect(() => resolveConfined("/tmp/../etc/passwd")).toThrow(/超出/);
    expect(() => resolveConfined("home/bot/file")).toThrow(/绝对路径/);
    expect(() => resolveConfined("/etc/hosts")).toThrow(/超出/);
    expect(() => resolveConfined("/tmp-evil/file")).toThrow(/超出/);
    expect(() => resolveConfined("/home/bot-evil/file")).toThrow(/超出/);
  });

  it("rejects a symlink whose target leaves the roots", async () => {
    const paths = await confined();
    const scratch = mkdtempSync(join(tmpdir(), "vb-paths-"));
    roots.push(scratch);
    const home = join(scratch, "home");
    const outside = join(scratch, "outside");
    mkdirSync(home);
    writeFileSync(outside, "secret");
    const link = join(home, "escape");
    symlinkSync(outside, link);
    paths.__setRootsForTest([home, join(scratch, "tmp")]);
    expect(() => paths.resolveConfined(link)).toThrow(/超出/);
    const inside = join(home, "keep");
    mkdirSync(inside);
    symlinkSync(inside, join(home, "alias"));
    expect(paths.resolveConfined(join(home, "alias", "note.txt"))).toBe(join(realpathSync(inside), "note.txt"));
  });

  it("accepts a path that stays inside a root", async () => {
    const { resolveConfined, BOT_TMP } = await confined();
    const dir = join(BOT_TMP, `vb-path-ok-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    roots.push(dir);
    expect(resolveConfined(join(dir, "note.txt"))).toBe(join(dir, "note.txt"));
  });
});
