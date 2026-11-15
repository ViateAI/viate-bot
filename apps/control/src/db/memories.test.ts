import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { botRepository } from "./bots.js";
import { openDatabase, type AppDatabase } from "./index.js";
import { MEMORY_MAX_ITEMS, MemoryRejected, memoryRepository } from "./memories.js";
import { ensureDevUser } from "./users.js";
import { userScope } from "../scope.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), "vb-mem-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  ensureDevUser(db, "user-a");
  ensureDevUser(db, "user-b");
  return db;
}

function bot(db: AppDatabase, userId: string, id: string) {
  return botRepository(db).insert(userScope(userId), { id, name: id, model: "m" });
}

describe("memories", () => {
  it("backfills existing memories and keeps the FTS index synchronized through update and deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-mem-upgrade-"));
    dirs.push(dir);
    const migrations = fileURLToPath(new URL("../../drizzle", import.meta.url));
    const previous = join(dir, "previous");
    mkdirSync(join(previous, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 2);
    writeFileSync(join(previous, "meta/_journal.json"), JSON.stringify(journal));
    for (const name of ["0000_init.sql", "0001_session_validation.sql"]) copyFileSync(join(migrations, name), join(previous, name));
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      migrate(db, { migrationsFolder: previous });
      ensureDevUser(db, "user-a");
      bot(db, "user-a", "bot-a");
      memoryRepository(db).save(userScope("user-a"), "bot-a", { id: "existing", content: "喜欢上海红茶", sourceTaskId: null });
      const { rowid } = db.$client.prepare("select rowid from memories where id = 'existing'").get() as { rowid: number };
      migrate(db, { migrationsFolder: migrations });
      const match = (text: string) => db.$client.prepare("select rowid from memories_fts where memories_fts match ?").all(`"${text}"`);
      expect(match("上海红茶")).toEqual([{ rowid }]);
      db.$client.prepare("update memories set content = ? where id = ?").run("喜欢杭州绿茶", "existing");
      expect(match("上海红茶")).toEqual([]);
      expect(match("杭州绿茶")).toEqual([{ rowid }]);
      expect(memoryRepository(db).remove(userScope("user-a"), "bot-a", "existing")).toBe(true);
      expect(match("杭州绿茶")).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("treats FTS operators, quotes and LIKE wildcards as literal search text", () => {
    const db = database();
    const scope = userScope("user-a");
    bot(db, "user-a", "bot-a");
    const store = memoryRepository(db);
    store.save(scope, "bot-a", { id: "literal", content: '有 50% 与 a_b 和 "quoted"，甲 OR 乙', sourceTaskId: null });
    store.save(scope, "bot-a", { id: "other", content: "50元与acb，甲独有", sourceTaskId: null });
    for (const query of ["%", "_", '"quoted"', "甲 OR 乙"]) {
      expect(store.search(scope, "bot-a", query, 5)?.map((item) => item.id), query).toEqual(["literal"]);
    }
    db.$client.close();
  });

  it("saves, searches Chinese with FTS, falls back under 3 characters, and deletes", () => {
    const db = database();
    const scope = userScope("user-a");
    bot(db, "user-a", "bot-a");
    const memories = memoryRepository(db);
    const saved = memories.save(scope, "bot-a", {
      id: "mem-1",
      content: "用户喜欢喝红茶，上海天气很好",
      sourceTaskId: null,
    });
    expect(saved.sourceTaskId).toBeNull();
    expect(memories.search(scope, "bot-a", "天气很", 5)?.map((item) => item.id)).toEqual(["mem-1"]);
    expect(memories.search(scope, "bot-a", "茶", 5)?.map((item) => item.id)).toEqual(["mem-1"]);
    expect(memories.search(scope, "bot-a", "ab", 5)).toEqual([]);
    db.$client.prepare("update memories set content = ? where id = ?").run("改成喜欢绿茶", "mem-1");
    expect(memories.search(scope, "bot-a", "红茶", 5)).toEqual([]);
    expect(memories.search(scope, "bot-a", "绿茶", 5)?.map((item) => item.id)).toEqual(["mem-1"]);
    expect(memories.remove(scope, "bot-a", "mem-1")).toBe(true);
    expect(memories.search(scope, "bot-a", "绿茶", 5)).toEqual([]);
    expect(memories.list(scope, "bot-a")).toEqual([]);
    db.$client.close();
  });

  it("rejects the 201st memory and keeps bots and users apart", () => {
    const db = database();
    const scope = userScope("user-a");
    bot(db, "user-a", "bot-a");
    bot(db, "user-a", "bot-b");
    bot(db, "user-b", "bot-c");
    const memories = memoryRepository(db);
    for (let index = 0; index < MEMORY_MAX_ITEMS; index += 1) {
      memories.save(scope, "bot-a", { id: `mem-${index}`, content: `第${index}条记忆内容`, sourceTaskId: null });
    }
    expect(() => memories.save(scope, "bot-a", { id: "mem-over", content: "再多一条就会超", sourceTaskId: null })).toThrow(
      MemoryRejected,
    );
    expect(memories.save(scope, "bot-b", { id: "mem-other", content: "另一个 bot 的秘密记忆", sourceTaskId: null }).botId).toBe(
      "bot-b",
    );
    expect(memories.search(scope, "bot-a", "秘密记忆", 5)).toEqual([]);
    expect(memories.list(userScope("user-b"), "bot-a")).toBeUndefined();
    expect(memories.remove(userScope("user-b"), "bot-a", "mem-0")).toBeUndefined();
    expect(memories.remove(scope, "bot-a", "mem-other")).toBe(false);
    expect(memories.list(userScope("user-b"), "bot-c")).toEqual([]);
    db.$client.close();
  });
});
