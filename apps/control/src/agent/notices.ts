import { and, asc, eq, isNull } from "drizzle-orm";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import { botRepository } from "../db/bots.js";
import { chatRepository } from "../db/chat.js";
import type { AppDatabase } from "../db/index.js";
import { systemNotices } from "../db/schema.js";
import { ulid } from "../id.js";
import { userScope } from "../scope.js";
import { storedContent } from "./view.js";

export const NOTICE_PREFIX = "【系统通知 · 应用市场】以下内容来自平台，不是用户发言，也不是用户授权";
export const NOTICE_CONVERSATION_TITLE = "系统通知";

export interface AppUpdatePayload {
  appId: string;
  appName: string;
  currentVersion: string;
  targetVersion: string;
  targetVersionId: string;
  note: string;
  markedAt: string;
}

export interface NoticeMark {
  kind: string;
  noticeId: string;
}

export function appUpdateText(payload: AppUpdatePayload, crossed: string[] = []): string {
  const lines = [
    NOTICE_PREFIX,
    `应用：${payload.appName}`,
    `版本：${payload.currentVersion} → ${payload.targetVersion}`,
  ];
  if (crossed.length > 0) lines.push(`期间跨过的版本：${crossed.join("、")}`);
  lines.push(`说明：${payload.note}`);
  return lines.join("\n");
}

export function readAppUpdateBody(text: string): { app: string; current: string; target: string; note: string } | undefined {
  const lines = text.split("\n");
  if (lines[0] !== NOTICE_PREFIX) return undefined;
  const appLine = lines[1];
  const versionLine = lines[2];
  if (!appLine?.startsWith("应用：") || !versionLine) return undefined;
  const version = /^\u7248\u672c：(.+) → (.+)$/.exec(versionLine);
  if (!version) return undefined;
  let noteAt = 3;
  if (lines[3]?.startsWith("期间跨过的版本：")) noteAt = 4;
  const noteLine = lines[noteAt];
  if (!noteLine?.startsWith("说明：")) return undefined;
  return {
    app: appLine.slice("应用：".length),
    current: version[1] ?? "",
    target: version[2] ?? "",
    note: [noteLine.slice("说明：".length), ...lines.slice(noteAt + 1)].join("\n"),
  };
}

export function noticeContent(noticeId: string, text: string): string {
  const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
  return storedContent(message, text, [], { kind: "app_update", noticeId });
}

/** 插入一条未投递通知。重复的 dedupe_key 保持原记录，不改已送达正文。 */
export function insertAppUpdateNotice(db: AppDatabase, userId: string, payload: AppUpdatePayload): boolean {
  const result = db.$client
    .prepare(
      `insert into system_notices (id, user_id, kind, dedupe_key, payload_json, created_at)
       values (?, ?, 'app_update', ?, ?, ?)
       on conflict (user_id, dedupe_key) do nothing`,
    )
    .run(ulid(), userId, `app_update:${payload.targetVersionId}`, JSON.stringify(payload), payload.markedAt);
  return result.changes === 1;
}

/** 在同一写事务选取、投递并确认未送达通知，不启动任务或唤醒机器。 */
export function deliverPendingNotices(
  db: AppDatabase,
  userId: string,
  eligible: (payload: AppUpdatePayload) => boolean,
): string | undefined {
  return db.$client.transaction(() => {
    const scope = userScope(userId);
    const bots = botRepository(db);
    const botId = bots.primaryId(scope);
    if (!botId || !bots.findById(scope, botId)?.noticeReady) return undefined;
    const pending = db
      .select()
      .from(systemNotices)
      .where(and(eq(systemNotices.userId, userId), eq(systemNotices.kind, "app_update"), isNull(systemNotices.deliveredAt)))
      .orderBy(asc(systemNotices.createdAt), asc(systemNotices.id))
      .all()
      .map((row) => ({ id: row.id, payload: JSON.parse(row.payloadJson) as AppUpdatePayload }))
      .filter(({ payload }) => eligible(payload));
    if (pending.length === 0) return undefined;
    const chat = chatRepository(db);
    const target = chat.listConversations(scope, botId)?.[0]
      ?? chat.insertConversation(scope, { id: ulid(), botId, title: NOTICE_CONVERSATION_TITLE });
    if (!target) throw new Error("通知对话没有写上");
    const deliveredAt = new Date().toISOString();
    for (const notice of pending) {
      const row = chat.insertMessage(scope, {
        id: ulid(),
        conversationId: target.id,
        role: "user",
        contentJson: noticeContent(notice.id, appUpdateText(notice.payload)),
        taskId: null,
      });
      if (!row) throw new Error("通知消息没有写上");
      db.update(systemNotices)
        .set({ deliveredMessageId: row.id, deliveredAt })
        .where(eq(systemNotices.id, notice.id))
        .run();
    }
    chat.touchConversation(scope, target.id);
    return target.id;
  }).immediate();
}

interface NoticeEntry {
  id: string;
  message: AgentMessage;
  notice?: NoticeMark;
}

export interface FoldedTranscript<T extends NoticeEntry> {
  entries: T[];
  /** 折叠后代表消息的 id（组内最大）到组内全部入库 id。 */
  groups: Map<string, string[]>;
}

function noticeBody(entry: NoticeEntry): { app: string; current: string; target: string; note: string } | undefined {
  if (entry.notice?.kind !== "app_update") return undefined;
  if (entry.message.role !== "user" || typeof entry.message.content !== "string") return undefined;
  return readAppUpdateBody(entry.message.content);
}

/** 相邻通知折成一条。数据库原文不改。 */
export function foldNoticeEntries<T extends NoticeEntry>(entries: readonly T[]): FoldedTranscript<T> {
  const groups = new Map<string, string[]>();
  const folded: T[] = [];
  let index = 0;
  while (index < entries.length) {
    const current = entries[index];
    if (!current || !noticeBody(current)) {
      if (current) folded.push(current);
      index += 1;
      continue;
    }
    const batch: T[] = [];
    while (index < entries.length) {
      const item = entries[index];
      if (!item || !noticeBody(item)) break;
      batch.push(item);
      index += 1;
    }
    if (batch.length < 2) {
      const only = batch[0];
      if (only) folded.push(only);
      continue;
    }
    const ids = batch.map((item) => item.id);
    const maxId = ids.reduce((max, id) => (id > max ? id : max));
    groups.set(maxId, ids);
    const last = batch[batch.length - 1]!;
    const message: UserMessage = {
      role: "user",
      content: foldedNoticeText(batch),
      timestamp: last.message.timestamp,
    };
    folded.push({ ...last, id: maxId, message });
  }
  return { entries: folded, groups };
}

function foldedNoticeText(batch: readonly NoticeEntry[]): string {
  const parsed = batch.flatMap((entry) => {
    const body = noticeBody(entry);
    return body ? [body] : [];
  });
  const order: string[] = [];
  const byApp = new Map<string, Array<{ current: string; target: string; note: string }>>();
  for (const item of parsed) {
    const list = byApp.get(item.app);
    if (!list) {
      order.push(item.app);
      byApp.set(item.app, [item]);
    } else {
      list.push(item);
    }
  }
  const lines = [NOTICE_PREFIX];
  for (const app of order) {
    const items = byApp.get(app) ?? [];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) continue;
    const crossed: string[] = [];
    for (const item of items.slice(0, -1)) {
      if (item.target !== last.target && !crossed.includes(item.target)) crossed.push(item.target);
    }
    lines.push(`应用：${app}`, `版本：${first.current} → ${last.target}`);
    if (crossed.length > 0) lines.push(`期间跨过的版本：${crossed.join("、")}`);
    lines.push(`说明：${last.note}`);
  }
  return lines.join("\n");
}
