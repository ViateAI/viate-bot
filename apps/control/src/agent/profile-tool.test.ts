import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { applyBotProfile, lineDiff, profileForbidden, profileNeedsApproval, profileSummary } from "./profile-tool.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbFor() {
  const dir = mkdtempSync(join(tmpdir(), "vb-profile-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "t.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  db.$client.exec(`insert into users (id,email,name,status,created_at) values ('u','u@x','u','active','now'),('v','v@x','v','active','now');
    insert into bots (id,user_id,name,instructions,model,settings_json,created_at,updated_at) values
      ('bot','u','旧名字','旧提示','fake','{"alwaysAllow":["shell"]}','now','now'),
      ('other','v','别人','','fake','{}','now','now');`);
  return { dir, db };
}

describe("update_bot_profile", () => {
  it("refuses approval settings and another bot, and requires approval for instructions", async () => {
    expect(profileForbidden({ alwaysAllow: [] })).toMatch(/不能修改/);
    expect(profileForbidden({ approveNone: true })).toMatch(/不能修改/);
    expect(profileForbidden({ quota: 1 })).toMatch(/不能修改/);
    expect(profileNeedsApproval({ name: "新" })).toBe(false);
    expect(profileNeedsApproval({ instructions: "新" })).toBe(true);
    expect(profileNeedsApproval({ model: "other" })).toBe(true);
    expect(profileNeedsApproval({ enabledAppIds: [] })).toBe(true);
    const { dir, db } = dbFor();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    await applyBotProfile(
      {
        db,
        dataDir: dir,
        userId: "u",
        botId: "bot",
        taskId: "task",
        allowModel: (model) => model === "fake" || model === "other",
        readFile: async () => ({ bytes: png, truncated: false }),
      },
      { name: "新名字", avatarPath: "/home/bot/face.png" },
    );
    const row = db.$client.prepare("select name, avatar, settings_json as settingsJson from bots where id='bot'").get() as {
      name: string;
      avatar: string;
      settingsJson: string;
    };
    expect(row.name).toBe("新名字");
    expect(row.avatar).toBe("image/png");
    expect(row.settingsJson).toContain("shell");
    expect(readFileSync(join(dir, "avatars", "bot")).subarray(0, 4).toString("hex")).toBe("89504e47");
    await expect(applyBotProfile({
      db,
      dataDir: dir,
      userId: "u",
      botId: "other",
      taskId: "task",
      allowModel: () => true,
      readFile: async () => ({ bytes: png, truncated: false }),
    }, { name: "偷" })).rejects.toThrow(/找不到 bot/);
    await expect(applyBotProfile({
      db,
      dataDir: dir,
      userId: "u",
      botId: "bot",
      taskId: "task",
      allowModel: () => false,
      readFile: async () => ({ bytes: png, truncated: false }),
    }, { model: "hidden" })).rejects.toThrow(/白名单/);
    await expect(applyBotProfile({
      db,
      dataDir: dir,
      userId: "u",
      botId: "bot",
      taskId: "task",
      allowModel: () => true,
      readFile: async () => ({ bytes: Buffer.from("not-an-image"), truncated: false }),
    }, { avatarPath: "/home/bot/face.txt" })).rejects.toThrow(/png/);
    const audit = db.$client.prepare("select action, attrs_json as attrs from audit_log").get() as { action: string; attrs: string };
    expect(audit.action).toBe("bot.profile");
    expect(audit.attrs).toContain("bot");
    expect(audit.attrs).toContain("task");
    db.$client.close();
  });

  it("shows an instruction diff", () => {
    const summary = JSON.parse(profileSummary({ name: "a", bio: "", instructions: "第一行\n第二行", model: "fake" }, { instructions: "第一行\n改过" })) as {
      kind: string;
      changes: Array<{ diff?: string }>;
    };
    expect(summary.kind).toBe("bot_profile");
    expect(summary.changes[0]?.diff).toBe(lineDiff("第一行\n第二行", "第一行\n改过"));
    expect(summary.changes[0]?.diff).toContain("-第二行");
    expect(summary.changes[0]?.diff).toContain("+改过");
    const longBefore = `${"unchanged\n".repeat(201)}old instruction`;
    const longAfter = `${"unchanged\n".repeat(201)}new instruction`;
    expect(lineDiff(longBefore, longAfter)).toContain("-old instruction");
    expect(lineDiff(longBefore, longAfter)).toContain("+new instruction");
  });

  it("reads an absolute avatar outside the roots only when confine is off", async () => {
    const { dir, db } = dbFor();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const seen: string[] = [];
    const deps = {
      db,
      dataDir: dir,
      userId: "u",
      botId: "bot",
      taskId: "task",
      allowModel: () => true,
      readFile: async (path: string) => {
        seen.push(path);
        return { bytes: png, truncated: false };
      },
    };
    await expect(applyBotProfile({ ...deps, confineNow: () => true }, { avatarPath: "/etc/passwd.png" })).rejects.toThrow(/\/home\/bot|\/tmp/);
    expect(seen).toEqual([]);
    await applyBotProfile({ ...deps, confineNow: () => false }, { avatarPath: "/etc/passwd.png" });
    expect(seen).toEqual(["/etc/passwd.png"]);
    await expect(applyBotProfile({ ...deps, confineNow: () => false }, { avatarPath: "etc/passwd.png" })).rejects.toThrow(/绝对路径/);
    db.$client.close();
  });

  it("accepts an avatar inside the admin allow list and rejects deny and outside paths", async () => {
    const { dir, db } = dbFor();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const seen: string[] = [];
    const deps = {
      db,
      dataDir: dir,
      userId: "u",
      botId: "bot",
      taskId: "task",
      allowModel: () => true,
      confineNow: () => true,
      confinePolicyNow: () => ({ allow: ["/work"], deny: ["/work/secret"] }),
      readFile: async (path: string) => {
        seen.push(path);
        return { bytes: png, truncated: false };
      },
    };
    await applyBotProfile(deps, { avatarPath: "/work/a.png" });
    expect(seen).toEqual(["/work/a.png"]);
    await expect(applyBotProfile(deps, { avatarPath: "/work/secret/a.png" })).rejects.toThrow(/黑名单/);
    await expect(applyBotProfile(deps, { avatarPath: "/tmp/a.png" })).rejects.toThrow(/允许目录/);
    await expect(applyBotProfile(deps, { avatarPath: "/work/secret-other/a.png" })).resolves.toEqual(["avatar"]);
    db.$client.close();
  });
});
