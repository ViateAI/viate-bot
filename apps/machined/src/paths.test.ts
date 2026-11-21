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

  it("rejects an outside directory symlink even when it is the final component", async () => {
    const paths = await confined();
    const scratch = mkdtempSync(join(tmpdir(), "vb-paths-"));
    roots.push(scratch);
    const home = join(scratch, "home");
    const outside = join(scratch, "outside");
    mkdirSync(home);
    mkdirSync(outside);
    const link = join(home, "escape");
    symlinkSync(outside, link);
    paths.__setRootsForTest([home]);
    try {
      expect(() => paths.resolveConfined(link)).toThrow(/超出/);
      expect(() => paths.resolveConfined(join(link, "file"))).toThrow(/超出/);
    } finally {
      paths.__setRootsForTest([paths.BOT_HOME, paths.BOT_TMP]);
    }
  });
});

describe("confine policy lists", () => {
  it("keeps the builtin roots when allow is empty and ignores lists when confine is off", async () => {
    const { resolveAccessible, BOT_TMP } = await confined();
    const dir = join(BOT_TMP, `vb-policy-default-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    roots.push(dir);
    expect(resolveAccessible(join(dir, "note.txt"), true, { allow: [], deny: [] })).toBe(join(dir, "note.txt"));
    expect(() => resolveAccessible("/tmp-evil/file", true, { allow: [], deny: [] })).toThrow(/超出/);
    expect(() => resolveAccessible("/etc/hosts", true, { allow: [], deny: [] })).toThrow(/超出/);
    expect(resolveAccessible("/etc/hosts", false, { allow: ["/nope"], deny: ["/etc"] })).toBe("/etc/hosts");
  });

  it("replaces builtin roots, lets deny win, and blocks symlink escapes", async () => {
    const { resolveAccessible } = await confined();
    const scratch = mkdtempSync(join(tmpdir(), "vb-policy-"));
    roots.push(scratch);
    const work = join(scratch, "work");
    const secret = join(work, "secret");
    const other = join(work, "secret-other");
    const outside = join(scratch, "outside");
    mkdirSync(secret, { recursive: true });
    mkdirSync(other, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(secret, "a.txt"), "no");
    writeFileSync(join(other, "a.txt"), "yes");
    writeFileSync(join(outside, "a.txt"), "out");
    symlinkSync(outside, join(work, "leak"));
    symlinkSync(secret, join(work, "alias"));

    const replaced = { allow: [work], deny: [] as string[] };
    expect(resolveAccessible(join(other, "a.txt"), true, replaced)).toBe(join(other, "a.txt"));
    expect(() => resolveAccessible("/home/bot/a.txt", true, replaced)).toThrow(/允许目录/);
    expect(() => resolveAccessible("/tmp/a.txt", true, replaced)).toThrow(/允许目录/);

    const denied = { allow: [work], deny: [secret] };
    expect(() => resolveAccessible(join(secret, "a.txt"), true, denied)).toThrow(/黑名单/);
    expect(resolveAccessible(join(other, "a.txt"), true, denied)).toBe(join(other, "a.txt"));
    expect(() => resolveAccessible(join(work, "alias", "a.txt"), true, denied)).toThrow(/黑名单/);
    expect(() => resolveAccessible(join(work, "leak", "a.txt"), true, denied)).toThrow(/允许目录/);

    expect(() => resolveAccessible("/tmp-evil/file", true, { allow: ["/tmp"], deny: [] })).toThrow(/允许目录/);
    const tmpFile = join("/tmp", `vb-policy-boundary-${process.pid}`);
    writeFileSync(tmpFile, "t");
    roots.push(tmpFile);
    expect(resolveAccessible(tmpFile, true, { allow: ["/tmp"], deny: [] })).toBe(tmpFile);
  });

  it("blocks the real path of a missing deny entry without denying its parent", async () => {
    const { resolveAccessible } = await confined();
    const scratch = mkdtempSync(join(tmpdir(), "vb-policy-anchor-"));
    roots.push(scratch);
    const real = join(scratch, "real");
    const link = join(scratch, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    writeFileSync(join(real, "note.txt"), "ok");
    const policy = { allow: [real, link], deny: [join(link, "secret")] };
    expect(() => resolveAccessible(join(real, "secret", "a.txt"), true, policy)).toThrow(/黑名单/);
    expect(() => resolveAccessible(join(link, "secret", "a.txt"), true, policy)).toThrow(/黑名单/);
    expect(resolveAccessible(join(real, "note.txt"), true, policy)).toBe(join(real, "note.txt"));
    expect(resolveAccessible(join(link, "note.txt"), true, policy)).toBe(join(link, "note.txt"));
  });

  it("does not widen a missing allow entry to its parent, but keeps the real child path", async () => {
    const { resolveAccessible } = await confined();
    const scratch = mkdtempSync(join(tmpdir(), "vb-policy-allow-"));
    roots.push(scratch);
    const real = join(scratch, "real");
    const link = join(scratch, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    writeFileSync(join(real, "note.txt"), "ok");
    const sub = join(link, "sub");
    const policy = { allow: [sub], deny: [] as string[] };
    expect(resolveAccessible(join(sub, "a.txt"), true, policy)).toBe(join(sub, "a.txt"));
    const realChild = join(realpathSync(real), "sub", "a.txt");
    expect(resolveAccessible(realChild, true, policy)).toBe(realChild);
    expect(resolveAccessible(join(real, "sub", "a.txt"), true, policy).endsWith("/sub/a.txt")).toBe(true);
    expect(() => resolveAccessible(join(link, "note.txt"), true, policy)).toThrow(/允许目录/);
    expect(() => resolveAccessible(join(real, "note.txt"), true, policy)).toThrow(/允许目录/);
    expect(() => resolveAccessible(real, true, policy)).toThrow(/允许目录/);
  });

  it("canonicalizes dot and duplicate slashes in deny before the target exists", async () => {
    const { resolveAccessible } = await confined();
    const scratch = mkdtempSync(join(tmpdir(), "vb-policy-dot-"));
    roots.push(scratch);
    const real = join(scratch, "real");
    const link = join(scratch, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(() => resolveAccessible(join(link, "gone.txt"), true, { allow: [link], deny: [`${link}/./gone.txt`] })).toThrow(/黑名单/);
    expect(() => resolveAccessible(join(real, "gone.txt"), true, { allow: [real, link], deny: [`${link}//gone.txt`] })).toThrow(/黑名单/);
  });

  it("rejects an allow root that is a symlink to a different directory", async () => {
    const { resolveAccessible } = await confined();
    const scratch = mkdtempSync(join(tmpdir(), "vb-policy-plant-"));
    roots.push(scratch);
    const planted = join(scratch, "planted");
    symlinkSync("/etc", planted);
    const policy = { allow: [planted], deny: [] as string[] };
    expect(() => resolveAccessible(join(planted, "passwd"), true, policy)).toThrow(/允许目录/);
    expect(() => resolveAccessible("/etc/passwd", true, policy)).toThrow(/允许目录/);
    expect(() => resolveAccessible("/private/etc/passwd", true, policy)).toThrow(/允许目录/);
  });

  it("still allows /tmp when it is a symlink to /private/tmp", async () => {
    const { resolveAccessible } = await confined();
    const file = join("/tmp", `vb-policy-tmp-${process.pid}`);
    roots.push(file);
    expect(resolveAccessible(file, true, { allow: ["/tmp"], deny: [] })).toBe(file);
    expect(resolveAccessible(file.replace("/tmp", "/private/tmp"), true, { allow: ["/tmp"], deny: [] })).toBe(file.replace("/tmp", "/private/tmp"));
    const missingDeny = `/tmp/vb-no-such-${process.pid}/secret`;
    expect(() => resolveAccessible(`${missingDeny}/a.txt`, true, { allow: ["/tmp"], deny: [missingDeny] })).toThrow(/黑名单/);
    expect(resolveAccessible(file, true, { allow: ["/tmp"], deny: [missingDeny] })).toBe(file);
  });

  it("rejects a malformed confine policy instead of ignoring it", async () => {
    const { resolveAccessible, PathEscapeError } = await confined();
    const file = join("/tmp", `vb-policy-bad-${process.pid}`);
    expect(() => resolveAccessible(file, true, { allow: "nope", deny: [] } as unknown as { allow: string[]; deny: string[] })).toThrow(PathEscapeError);
    expect(() => resolveAccessible(file, true, null as unknown as { allow: string[]; deny: string[] })).toThrow(PathEscapeError);
    expect(() => resolveAccessible(file, true, { allow: ["/tmp"], deny: ["relative"] })).toThrow(PathEscapeError);
    expect(() => resolveAccessible(file, true, { allow: ["/tmp/../etc"], deny: [] })).toThrow(PathEscapeError);
  });
});
