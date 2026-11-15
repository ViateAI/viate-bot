import { and, desc, eq, sql } from "drizzle-orm";
import type { UserScope } from "../scope.js";
import { botRepository } from "./bots.js";
import type { AppDatabase } from "./index.js";
import { memories } from "./schema.js";

export const MEMORY_MAX_ITEMS = 200;
export const MEMORY_MAX_CHARS = 2000;

export class MemoryRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRejected";
  }
}

export interface MemoryRecord {
  id: string;
  botId: string;
  content: string;
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  bot_id: string;
  content: string;
  source_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export function memoryRepository(db: AppDatabase) {
  const bots = botRepository(db);
  return {
    list(scope: UserScope, botId: string): MemoryRecord[] | undefined {
      if (!bots.findById(scope, botId)) return undefined;
      return db
        .select()
        .from(memories)
        .where(eq(memories.botId, botId))
        .orderBy(desc(memories.updatedAt), desc(sql`rowid`))
        .limit(MEMORY_MAX_ITEMS)
        .all()
        .map(toRecord);
    },
    recent(scope: UserScope, botId: string, limit: number): MemoryRecord[] | undefined {
      if (!bots.findById(scope, botId)) return undefined;
      return db
        .select()
        .from(memories)
        .where(eq(memories.botId, botId))
        // 同一毫秒内写入的记忆时间戳相同，用插入顺序兜底，否则“最近 N 条”不确定。
        .orderBy(desc(memories.updatedAt), desc(sql`rowid`))
        .limit(limit)
        .all()
        .map(toRecord);
    },
    /**
     * 查询词少于 3 个字符时 FTS5 trigram 不可用，退回 LIKE。
     * 更长的词用短语查询，命中记忆正文里的这段子串。
     */
    search(scope: UserScope, botId: string, query: string, limit: number): MemoryRecord[] | undefined {
      if (!bots.findById(scope, botId)) return undefined;
      const text = query.trim();
      if (text.length === 0 || limit <= 0) return [];
      const clipped = [...text].slice(0, 200).join("");
      if ([...clipped].length < 3) return likeSearch(db, botId, clipped, limit);
      try {
        return ftsSearch(db, botId, clipped, limit);
      } catch {
        return likeSearch(db, botId, clipped, limit);
      }
    },
    save(scope: UserScope, botId: string, input: { id: string; content: string; sourceTaskId: string | null }): MemoryRecord {
      if (!bots.findById(scope, botId)) throw new MemoryRejected("找不到 bot");
      const content = input.content.trim();
      if (content.length === 0) throw new MemoryRejected("记忆内容不能为空");
      if ([...content].length > MEMORY_MAX_CHARS) throw new MemoryRejected(`记忆最长 ${MEMORY_MAX_CHARS} 个字符`);
      const count = db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.botId, botId))
        .all().length;
      if (count >= MEMORY_MAX_ITEMS) {
        throw new MemoryRejected(`记忆已有 ${MEMORY_MAX_ITEMS} 条，请先用 memory_delete 删除再保存`);
      }
      const now = new Date().toISOString();
      db.insert(memories)
        .values({
          id: input.id,
          botId,
          content,
          sourceTaskId: input.sourceTaskId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const created = db
        .select()
        .from(memories)
        .where(and(eq(memories.id, input.id), eq(memories.botId, botId)))
        .get();
      if (!created) throw new MemoryRejected("写入记忆后读不回来");
      return toRecord(created);
    },
    /** 找不到 bot 返回 undefined，找到 bot 但没有这条记忆返回 false。 */
    remove(scope: UserScope, botId: string, id: string): boolean | undefined {
      if (!bots.findById(scope, botId)) return undefined;
      const result = db
        .delete(memories)
        .where(and(eq(memories.id, id), eq(memories.botId, botId)))
        .run();
      return result.changes > 0;
    },
  };
}

function ftsSearch(db: AppDatabase, botId: string, query: string, limit: number): MemoryRecord[] {
  const phrase = `"${query.replace(/"/g, '""')}"`;
  const rows = db.$client
    .prepare(
      `select m.id, m.bot_id, m.content, m.source_task_id, m.created_at, m.updated_at
       from memories_fts
       join memories m on m.rowid = memories_fts.rowid
       where memories_fts match ? and m.bot_id = ?
       order by rank
       limit ?`,
    )
    .all(phrase, botId, limit) as MemoryRow[];
  return rows.map(fromSql);
}

function likeSearch(db: AppDatabase, botId: string, query: string, limit: number): MemoryRecord[] {
  const pattern = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const rows = db.$client
    .prepare(
      `select id, bot_id, content, source_task_id, created_at, updated_at
       from memories
       where bot_id = ? and content like ? escape '\\'
       order by updated_at desc
       limit ?`,
    )
    .all(botId, pattern, limit) as MemoryRow[];
  return rows.map(fromSql);
}

function toRecord(row: typeof memories.$inferSelect): MemoryRecord {
  return {
    id: row.id,
    botId: row.botId,
    content: row.content,
    sourceTaskId: row.sourceTaskId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function fromSql(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    botId: row.bot_id,
    content: row.content,
    sourceTaskId: row.source_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
