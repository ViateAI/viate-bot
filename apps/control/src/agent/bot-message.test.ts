import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { createBot } from "../bot-service.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { createRuntime } from "../compose.js";
import { loadOrCreateKey } from "../crypto.js";
import { findBotMessage, insertBotMessage } from "../db/bot-messages.js";
import { botRepository } from "../db/bots.js";
import { chatRepository } from "../db/chat.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { ensureDevUser } from "../db/users.js";
import { ulid } from "../id.js";
import { approvalClass, READ_ONLY_TOOLS } from "../m2/risk.js";
import { userScope, type UserScope } from "../scope.js";
import { attachBotMessageCards, createSendToBotTool, terminalReplyBody } from "./bot-messaging.js";
import { foldNoticeEntries } from "./notices.js";
import { toolLabel } from "./process-detail.js";
import { recoverInterruptedTasks, type ChatServiceDeps } from "./service.js";
import { messageView, storedContent } from "./view.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("send_to_bot", () => {
  it("is exempt from approval", () => {
    expect(READ_ONLY_TOOLS.send_to_bot).toBe(true);
    expect(approvalClass("send_to_bot")).toBeUndefined();
    expect(toolLabel("send_to_bot")).toBe("正在发给另一个 bot");
  });

  it("resolves a peer by name or id and refuses duplicates, self, other users, deleted bots, and overlong text", async () => {
    const fx = fixture();
    const peer = insertBot(fx, "user-a", "Bea");
    const twin = insertBot(fx, "user-a", "Bea");
    const gone = insertBot(fx, "user-a", "Gone");
    fx.db.$client.prepare("update bots set deleted_at = 't' where id = ?").run(gone);
    insertBot(fx, "user-b", "Other");
    const tool = createSendToBotTool({
      db: fx.db,
      userId: "user-a",
      fromBotId: fx.botId,
      taskId: fx.taskId,
      hop: 0,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      scheduleDispatch: () => undefined,
    });
    if (!tool) throw new Error("tool missing");
    expect(tool.description).toContain(peer);
    expect(tool.description).toContain("Bea");
    expect(tool.description).not.toContain("Other");
    expect(tool.description).not.toContain("Gone");

    const byName = await tool.execute("c1", { bot: "Bea", text: "你好" });
    expect(byName.isError).toBe(true);
    expect(textOf(byName)).toContain(peer);
    expect(textOf(byName)).toContain(twin);
    expect(countMessages(fx.db)).toBe(0);

    const byId = await tool.execute("c2", { bot: peer, text: "  去处理  " });
    expect(byId.isError).toBeUndefined();
    expect(textOf(byId)).toContain("已发给Bea");
    expect(textOf(byId)).toContain("不要等待或轮询");
    const stored = onlyMessage(fx.db);
    expect(stored).toMatchObject({ fromBotId: fx.botId, toBotId: peer, hop: 1, body: "去处理", state: "queued", originTaskId: fx.taskId, replyToId: null });

    expect(textOf(await tool.execute("c3", { bot: fx.botId, text: "自己" }))).toContain("不能发给自己");
    expect(textOf(await tool.execute("c4", { bot: "Ada", text: "自己" }))).toContain("不能发给自己");
    expect(textOf(await tool.execute("c5", { bot: gone, text: "没了" }))).toContain("找不到这个 bot");
    expect(textOf(await tool.execute("c6", { bot: "Other", text: "别人" }))).toContain("找不到这个 bot");
    expect(textOf(await tool.execute("c7", { bot: "没有", text: "x" }))).toContain("可用：");
    expect(textOf(await tool.execute("c8", { bot: peer, text: "   " }))).toContain("消息不能为空");
    expect(textOf(await tool.execute("c9", { bot: peer, text: "x".repeat(20_001) }))).toContain("20000");
    expect(countMessages(fx.db)).toBe(1);
  });

  it("does not register when the user has only one bot", () => {
    const fx = fixture();
    expect(createSendToBotTool({
      db: fx.db,
      userId: "user-a",
      fromBotId: fx.botId,
      taskId: fx.taskId,
      hop: 0,
      now: () => new Date(),
      scheduleDispatch: () => undefined,
    })).toBeUndefined();
  });

  it("acknowledges the persisted message before a blocked recipient dispatch completes", async () => {
    const fx = fixture();
    const peer = insertBot(fx, "user-a", "Bea");
    const dispatch = Promise.withResolvers<void>();
    const tool = createSendToBotTool({
      db: fx.db, userId: "user-a", fromBotId: fx.botId, taskId: fx.taskId,
      hop: 0, now: () => new Date(), scheduleDispatch: () => dispatch.promise,
    })!;
    let acknowledged = false;
    const result = tool.execute("call", { bot: peer, text: "处理" }).then((value) => {
      acknowledged = true;
      return value;
    });
    try {
      const tick = Promise.withResolvers<void>();
      setImmediate(tick.resolve);
      await tick.promise;
      expect(onlyMessage(fx.db)).toMatchObject({ state: "queued", body: "处理" });
      expect(acknowledged).toBe(true);
    } finally {
      dispatch.resolve();
      await result;
    }
  });

  it("rejects hop 11 without inserting a row", async () => {
    const fx = fixture();
    const peer = insertBot(fx, "user-a", "Bea");
    const tool = createSendToBotTool({
      db: fx.db,
      userId: "user-a",
      fromBotId: fx.botId,
      taskId: fx.taskId,
      hop: 10,
      now: () => new Date(),
      scheduleDispatch: () => {
        throw new Error("不应派发");
      },
    });
    if (!tool) throw new Error("tool missing");
    const refused = await tool.execute("c", { bot: peer, text: "再转发" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("已达 bot 间转发上限 10");
    expect(countMessages(fx.db)).toBe(0);

    const allowed = createSendToBotTool({
      db: fx.db,
      userId: "user-a",
      fromBotId: fx.botId,
      taskId: fx.taskId,
      hop: 9,
      now: () => new Date(),
      scheduleDispatch: () => undefined,
    });
    if (!allowed) throw new Error("tool missing");
    expect((await allowed.execute("c2", { bot: peer, text: "第十跳" })).isError).toBeUndefined();
    expect(onlyMessage(fx.db).hop).toBe(10);
  });

  it("does not fold bot messages the way app updates fold", () => {
    const entry = (id: string, kind: string) => ({
      id,
      message: { role: "user" as const, content: `${kind} ${id}`, timestamp: 1 },
      attachments: [],
      notice: { kind, noticeId: id },
    });
    const folded = foldNoticeEntries([
      entry("a", "bot_message"),
      entry("b", "bot_reply"),
      entry("c", "app_update"),
    ]);
    expect(folded.entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("adds the sender and the shown flag when a card is read", () => {
    const fx = fixture();
    const peer = insertBot(fx, "user-a", "Bea");
    const id = ulid();
    insertBotMessage(fx.db, {
      id,
      userId: "user-a",
      fromBotId: peer,
      toBotId: fx.botId,
      hop: 2,
      body: "结论",
      state: "shown",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const [card] = attachBotMessageCards(fx.db, fx.scope, [{ notice: { kind: "bot_reply", noticeId: id } }]);
    expect(card?.notice).toMatchObject({ peerBotId: peer, peerName: "Bea", shown: true });
  });

  it("points a card to the source task's conversation, not the peer's newest conversation", () => {
    const fx = fixture();
    const peer = insertBot(fx, fx.scope.userId, "Bea");
    const original = chatRepository(fx.db).findTask(fx.scope, fx.taskId)?.conversationId;
    chatRepository(fx.db).insertConversation(fx.scope, { id: ulid(), botId: fx.botId, title: "更新的对话" });
    const request = queue(fx.db, fx.botId, peer, "内容", "2026-01-01T00:00:00.000Z", fx.taskId);
    const [card] = attachBotMessageCards(fx.db, fx.scope, [{ notice: { kind: "bot_message", noticeId: request } }]);
    expect(card?.notice).toMatchObject({ peerBotId: fx.botId, peerConversationId: original });
  });
});

describe("bot message dispatch and reply", () => {
  it("only shows the reply when a user stops a request and endpoint preparation then fails", async () => {
    const endpoint = Promise.withResolvers<never>();
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("不应进入模型"));
    });
    const run = await pair(modelPort, { prepareEndpoint: () => endpoint.promise });
    const request = queue(run.db, run.ada, run.bea, "等待启动", "2026-01-01T00:00:00.000Z");
    await run.service.flushBotMessages(run.bea);
    const taskId = findBotMessage(run.db, request)?.taskId;
    expect(taskId).toBeTruthy();
    expect(run.service.stop(run.scope, taskId!)).toBe(true);
    endpoint.reject(new Error("模拟机器启动失败"));
    await run.service.idle();
    expect(chatRepository(run.db).findTask(run.scope, taskId!)?.state).toBe("cancelled");
    expect(run.db.$client.prepare("select state from bot_messages where reply_to_id=?").get(request)).toEqual({ state: "shown" });
    expect(tasksOf(run.db, run.ada)).toEqual([]);
  });

  it("does not dispatch the next job to a bot while it is being deleted", async () => {
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("完成"));
    });
    const run = await pair(modelPort);
    const held = await run.service.send({ userId: run.scope.userId, botId: run.bea, text: "第一件", mode: "queue" });
    const request = queue(run.db, run.ada, run.bea, "第二件", "2026-01-01T00:00:00.000Z");
    await run.service.cancelBot(run.scope, run.bea, async () => {
      expect(findBotMessage(run.db, request)?.state).toBe("queued");
      return botRepository(run.db).softDelete(run.scope, run.bea);
    });
    await run.service.idle();
    expect(findBotMessage(run.db, request)).toMatchObject({ state: "dropped", error: "接收方 bot 已删除" });
    expect(tasksOf(run.db, run.bea).map(({ id }) => id)).toEqual([held.taskId]);
    expect(run.db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  it("falls back when the original conversation is deleted while the request is running", async () => {
    const release = Promise.withResolvers<void>();
    const begun = Promise.withResolvers<void>();
    const modelPort = await listen(async (_req, res, body) => {
      if (lastUser(body).startsWith("【bot 消息")) {
        begun.resolve();
        await release.promise;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("完成"));
    });
    const run = await pair(modelPort);
    const chat = chatRepository(run.db);
    const original = await run.service.send({ userId: run.scope.userId, botId: run.ada, text: "原对话", mode: "queue" });
    await run.service.idle();
    const fallback = chat.insertConversation(run.scope, { id: ulid(), botId: run.ada, title: "最新对话" })!;
    const request = queue(run.db, run.ada, run.bea, "任务", "2026-01-01T00:00:00.000Z", original.taskId);
    await run.service.flushBotMessages(run.bea);
    try {
      await begun.promise;
      expect(chat.deleteConversation(run.scope, original.conversationId)).toEqual([]);
      expect(findBotMessage(run.db, request)?.originTaskId).toBeNull();
    } finally {
      release.resolve();
      await run.service.idle();
    }
    const [reply] = chat.listTasks(run.scope, fallback.id) ?? [];
    expect(reply).toMatchObject({ trigger: "bot_message", state: "succeeded" });
    expect(taskText(run.db, run.scope, reply!.id)).toContain("来自Bea");
    expect(run.db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  it("commits the interrupted task and its visible reply together on restart", () => {
    const fx = fixture();
    fx.db.$client.prepare("update tasks set state='succeeded', ended_at='t' where id=?").run(fx.taskId);
    const { request, task } = interruptedRequest(fx);
    fx.db.$client.exec(`create trigger block_card before insert on messages
      begin select raise(abort, '模拟回复卡片写入失败'); end;`);
    expect(() => recoverInterruptedTasks(fx.db)).toThrow("模拟回复卡片写入失败");
    expect(chatRepository(fx.db).findTask(fx.scope, task)?.state).toBe("running");
    expect(countMessages(fx.db)).toBe(1);
    fx.db.$client.exec("drop trigger block_card");
    expect(recoverInterruptedTasks(fx.db)).toBe(1);
    expect(recoverInterruptedTasks(fx.db)).toBe(0);
    expect(fx.db.$client.prepare("select state from bot_messages where reply_to_id = ?").all(request)).toEqual([{ state: "shown" }]);
    expect(fx.db.$client.prepare("select count(*) from messages where task_id is null").pluck().get()).toBe(1);
  });

  it("records a dropped reply rather than delivering a shown card after owner deactivation", () => {
    const fx = fixture();
    const { request } = interruptedRequest(fx);
    fx.db.$client.prepare("update users set status='disabled' where id=?").run(fx.scope.userId);
    recoverInterruptedTasks(fx.db);
    expect(fx.db.$client.prepare("select state, error from bot_messages where reply_to_id = ?").get(request)).toEqual({ state: "dropped", error: "用户已停用" });
    expect(fx.db.$client.prepare("select count(*) from messages").pluck().get()).toBe(0);
  });

  it.each(["succeeded", "failed"])("limits a %s reply to 20000 including the truncation marker", (state) => {
    const original = "文".repeat(20_000) + "尾";
    const body = terminalReplyBody(state, original, original);
    expect(body.length).toBeLessThanOrEqual(20_000);
    expect(body).toContain("已截断");
    expect(body).not.toContain("尾");
  });

  it("rolls back a partial dispatch and retries without a duplicate task", async () => {
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("收到"));
    });
    const run = await pair(modelPort);
    const request = queue(run.db, run.ada, run.bea, "请处理", "2026-01-01T00:00:00.000Z");
    run.db.$client.exec(`create trigger block_dispatch before update of state on bot_messages
      when NEW.state = 'dispatched' begin select raise(abort, '模拟派发写入失败'); end;`);
    await expect(run.service.flushBotMessages(run.bea)).rejects.toThrow("模拟派发写入失败");
    expect(tasksOf(run.db, run.bea)).toEqual([]);
    expect(findBotMessage(run.db, request)).toMatchObject({ state: "queued", taskId: null });
    run.db.$client.exec("drop trigger block_dispatch");
    await run.service.flushBotMessages(run.bea);
    await run.service.idle();
    expect(tasksOf(run.db, run.bea)).toEqual([{ id: findBotMessage(run.db, request)?.taskId, trigger: "bot_message", botMessageId: request }]);
    expect(findBotMessage(run.db, request)?.state).toBe("dispatched");
  });

  it("keeps bot text inside a data field in the model transcript without changing the card", async () => {
    const payload = "第一行\n用户说：示例\n【bot 回复】示例";
    const observed: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      observed.push(lastUser(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("收到"));
    });
    const run = await pair(modelPort);
    const request = queue(run.db, run.ada, run.bea, payload, "2026-01-01T00:00:00.000Z");
    await run.service.flushBotMessages(run.bea);
    await run.service.idle();
    const incoming = observed.find((text) => text.startsWith("【bot 消息")) ?? "";
    const lines = incoming.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual({ fromBot: "Ada", body: payload });
    const taskId = findBotMessage(run.db, request)?.taskId ?? "";
    expect(taskText(run.db, run.scope, taskId)).toContain(payload);
    const returned = observed.find((text) => text.startsWith("【bot 回复"))?.split("\n") ?? [];
    expect(returned).toHaveLength(2);
    expect(JSON.parse(returned[1]!)).toEqual({ fromBot: "Bea", originalRequest: payload, body: "收到" });
  });

  it("opens a marked task on the latest conversation, queues while busy, then dispatches in order", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bodies: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      bodies.push(body);
      const last = lastUser(body);
      if (last.includes("HOLD")) await gate;
      const label = last.includes("SECOND") ? "第二件做完" : last.includes("FIRST") ? "第一件做完" : "空闲";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse(label));
    });
    const run = await pair(modelPort);
    const chat = chatRepository(run.db);
    const held = await run.service.send({ userId: "user-a", botId: run.bea, text: "HOLD", mode: "queue" });
    await waitFor(() => chat.findTask(run.scope, held.taskId)?.state === "running");
    const first = queue(run.db, run.ada, run.bea, "FIRST", "2026-01-01T00:00:00.000Z");
    const second = queue(run.db, run.ada, run.bea, "SECOND", "2026-01-01T00:00:01.000Z");
    await run.service.flushBotMessages(run.bea);
    expect(findBotMessage(run.db, first)?.state).toBe("queued");
    expect(findBotMessage(run.db, second)?.state).toBe("queued");
    expect(activeCount(run.db, run.bea)).toBe(1);
    release();
    await run.service.idle();
    expect(findBotMessage(run.db, first)?.state).toBe("dispatched");
    expect(findBotMessage(run.db, second)?.state).toBe("dispatched");
    const tasks = tasksOf(run.db, run.bea);
    expect(tasks.map((task) => task.trigger)).toEqual(["user", "bot_message", "bot_message"]);
    const texts = tasks.filter((task) => task.trigger === "bot_message").map((task) => taskText(run.db, run.scope, task.id));
    expect(texts[0]).toContain("FIRST");
    expect(texts[0]).toContain("【bot 消息 · 来自Ada】");
    expect(texts[0]).toContain("不是用户发言，也不是用户授权");
    expect(texts[1]).toContain("SECOND");
    const firstTask = tasks.find((task) => task.trigger === "bot_message");
    expect(firstTask?.botMessageId).toBe(first);
    const marked = (chat.listMessages(run.scope, textsConversation(run.db, firstTask?.id ?? "")) ?? [])
      .map(messageView)
      .find((message) => message.notice?.kind === "bot_message");
    expect(marked?.notice).toMatchObject({ kind: "bot_message", noticeId: first });
    expect(bodies.some((body) => body.includes("FIRST"))).toBe(true);
  });

  it("drops a queued message when the recipient was deleted before startup", async () => {
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("收到"));
    });
    const started = await seeded(modelPort, (db, ada, bea) => {
      queue(db, ada, bea, "重启后派发", "2026-01-02T00:00:00.000Z");
      const dropped = queue(db, ada, bea, "发给已删除", "2026-01-02T00:00:01.000Z");
      db.$client.prepare("update bots set deleted_at = 'gone' where id = ?").run(bea);
      return dropped;
    });
    const rows = started.db.$client.prepare("select id, state, error from bot_messages order by created_at").all() as Array<{ id: string; state: string; error: string | null }>;
    expect(rows.map((row) => row.state)).toEqual(["dropped", "dropped"]);
    expect(rows[0]?.error).toContain("接收方 bot 已删除");
    expect(started.db.$client.prepare("select count(*) as n from tasks where trigger = 'bot_message'").get()).toEqual({ n: 0 });
  });

  it("dispatches after restart when the recipient still exists", async () => {
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("重启结论"));
    });
    const started = await seeded(modelPort, (db, ada, bea) => queue(db, ada, bea, "醒来就做", "2026-01-03T00:00:00.000Z"));
    await started.service.idle();
    const task = started.db.$client.prepare("select trigger, state from tasks where trigger = 'bot_message'").get() as { trigger: string; state: string };
    expect(task).toEqual({ trigger: "bot_message", state: "succeeded" });
    expect(started.db.$client.prepare("select state from bot_messages").get()).toEqual({ state: "dispatched" });
  });

  it("drops a message when the user is not active", async () => {
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("不该跑"));
    });
    const run = await pair(modelPort);
    run.db.$client.prepare("update users set status = 'disabled' where id = 'user-a'").run();
    const id = queue(run.db, run.ada, run.bea, "停用", "2026-01-04T00:00:00.000Z");
    await run.service.flushBotMessages(run.bea);
    expect(findBotMessage(run.db, id)).toMatchObject({ state: "dropped", error: "用户已停用" });
    expect(activeCount(run.db, run.bea)).toBe(0);
  });

  it("returns the last assistant text to the origin conversation and does not reply again", async () => {
    const modelPort = await listen(async (_req, res, body) => {
      const last = lastUser(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (last.includes("【bot 消息")) {
        res.end(textSse("结论-42"));
        return;
      }
      if (last.includes("【bot 回复")) {
        res.end(textSse("继续-7"));
        return;
      }
      if (!body.includes("已发给")) {
        res.end(toolSse("send_to_bot", { bot: "Bea", text: "请统计" }));
        return;
      }
      res.end(textSse("已派出"));
    });
    const run = await pair(modelPort);
    const sent = await run.service.send({ userId: "user-a", botId: run.ada, text: "派活", mode: "queue" });
    await run.service.idle();
    const messages = run.db.$client.prepare("select id, state, hop, reply_to_id as replyToId, body from bot_messages order by created_at").all() as Array<{ id: string; state: string; hop: number; replyToId: string | null; body: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ state: "dispatched", hop: 1, replyToId: null, body: "请统计" });
    expect(messages[1]).toMatchObject({ state: "dispatched", hop: 2, replyToId: messages[0]?.id, body: "结论-42" });
    const replyTasks = run.db.$client.prepare("select id, conversation_id as conversationId, trigger from tasks where bot_id = ? and trigger = 'bot_message'").all(run.ada) as Array<{ id: string; conversationId: string; trigger: string }>;
    expect(replyTasks).toHaveLength(1);
    expect(replyTasks[0]?.conversationId).toBe(sent.conversationId);
    expect(taskText(run.db, run.scope, replyTasks[0]?.id ?? "")).toContain("【bot 回复 · 来自Bea】");
    expect(taskText(run.db, run.scope, replyTasks[0]?.id ?? "")).toContain("请统计");
    expect(taskText(run.db, run.scope, replyTasks[0]?.id ?? "")).toContain("结论-42");
    const assistant = (chatRepository(run.db).listMessages(run.scope, sent.conversationId) ?? []).filter((row) => row.taskId === replyTasks[0]?.id && row.role === "assistant").map(messageView);
    expect(assistant.some((message) => message.text.includes("继续-7"))).toBe(true);
    expect(run.db.$client.prepare("select count(*) as n from bot_messages").get()).toEqual({ n: 2 });
    expect(run.db.$client.prepare("select count(*) as n from tasks where bot_id = ?").get(run.bea)).toEqual({ n: 1 });
  });

  it("opens a task for a failure and only shows a stopped task", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const modelPort = await listen(async (_req, res, body) => {
      const last = lastUser(body);
      if (last.includes("FAIL-BOT")) {
        res.writeHead(500);
        res.end();
        return;
      }
      if (last.includes("STOP-BOT")) await gate;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse(last.includes("【bot 回复") ? "看到了" : "ok"));
    });
    const failed = await pair(modelPort);
    queue(failed.db, failed.ada, failed.bea, "FAIL-BOT", "2026-01-05T00:00:00.000Z");
    await failed.service.flushBotMessages(failed.bea);
    await failed.service.idle();
    const failReply = failed.db.$client.prepare("select body, state from bot_messages where reply_to_id is not null").get() as { body: string; state: string };
    expect(failReply.state).toBe("dispatched");
    expect(failReply.body).toContain("对方任务失败：");
    expect(taskText(failed.db, failed.scope, failed.db.$client.prepare("select id from tasks where bot_id = ? and trigger = 'bot_message'").pluck().get(failed.ada) as string)).toContain("对方任务失败：");

    const stopped = await pair(modelPort);
    const primer = await stopped.service.send({ userId: "user-a", botId: stopped.ada, text: "准备", mode: "queue" });
    await stopped.service.idle();
    const stopId = queue(stopped.db, stopped.ada, stopped.bea, "STOP-BOT", "2026-01-05T00:00:01.000Z", primer.taskId);
    await stopped.service.flushBotMessages(stopped.bea);
    await waitFor(() => stopped.db.$client.prepare("select id from tasks where bot_id = ? and state = 'running'").pluck().get(stopped.bea) !== undefined);
    const running = stopped.db.$client.prepare("select id from tasks where bot_id = ? and state = 'running'").pluck().get(stopped.bea) as string;
    expect(stopped.service.stop(stopped.scope, running)).toBe(true);
    release();
    await stopped.service.idle();
    const stopReply = stopped.db.$client.prepare("select body, state, hop from bot_messages where reply_to_id = ?").get(stopId) as { body: string; state: string; hop: number };
    expect(stopReply).toMatchObject({ body: "对方任务被停止", state: "shown", hop: 2 });
    expect(stopped.db.$client.prepare("select count(*) as n from tasks where bot_id = ? and trigger = 'bot_message'").get(stopped.ada)).toEqual({ n: 0 });
    const shown = (chatRepository(stopped.db).listMessages(stopped.scope, primer.conversationId) ?? []).map(messageView).find((message) => message.notice?.kind === "bot_reply");
    expect(shown?.text).toContain("未自动继续处理");
    expect(shown?.taskId).toBeNull();
  });

  it("shows the reply when the next hop would pass 10, and shows an interrupted request without a task", async () => {
    const modelPort = await listen(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("第十跳结论"));
    });
    const hopped = await seeded(modelPort, (db, ada, bea) => {
      const request = queue(db, ada, bea, "到顶了", "2026-01-06T00:00:00.000Z");
      db.$client.prepare("update bot_messages set hop = 10, state = 'dispatched' where id = ?").run(request);
      const conversation = ulid();
      const task = ulid();
      db.$client.prepare("insert into conversations (id, bot_id, title, created_at, updated_at) values (?, ?, 'b', 't', 't')").run(conversation, bea);
      db.$client.prepare("insert into tasks (id, bot_id, conversation_id, state, trigger, bot_message_id) values (?, ?, ?, 'queued', 'bot_message', ?)").run(task, bea, conversation, request);
      const text = "【bot 消息 · 来自Ada】\n到顶了";
      db.$client.prepare("insert into messages (id, conversation_id, role, content_json, task_id, created_at) values (?, ?, 'user', ?, ?, 't')").run(
        ulid(),
        conversation,
        storedContent({ role: "user", content: text, timestamp: 1 }, text, [], { kind: "bot_message", noticeId: request }),
        task,
      );
      return request;
    });
    await hopped.service.idle();
    const reply = hopped.db.$client.prepare("select hop, state, body from bot_messages where reply_to_id is not null").get() as { hop: number; state: string; body: string };
    expect(reply).toMatchObject({ hop: 11, state: "shown", body: "第十跳结论" });
    expect(hopped.db.$client.prepare("select count(*) as n from tasks where trigger = 'bot_message' and bot_id != ?").get(hopped.bea)).toEqual({ n: 0 });

    const interrupted = await seeded(modelPort, (db, ada, bea) => {
      const request = queue(db, ada, bea, "中断", "2026-01-06T00:00:02.000Z");
      db.$client.prepare("update bot_messages set state = 'dispatched' where id = ?").run(request);
      const conversation = ulid();
      const task = ulid();
      db.$client.prepare("insert into conversations (id, bot_id, title, created_at, updated_at) values (?, ?, 'b', 't', 't')").run(conversation, bea);
      db.$client.prepare("insert into tasks (id, bot_id, conversation_id, state, trigger, bot_message_id) values (?, ?, ?, 'running', 'bot_message', ?)").run(task, bea, conversation, request);
      return request;
    });
    const recovered = interrupted.db.$client.prepare("select state from tasks where trigger = 'bot_message'").get() as { state: string };
    expect(recovered.state).toBe("interrupted");
    expect(interrupted.db.$client.prepare("select state, body from bot_messages where reply_to_id is not null").get()).toEqual({ state: "shown", body: "对方任务被停止" });
  });

  it("does not open two active tasks when dispatch races a user send", async () => {
    const peaks: number[] = [];
    const seen: { db?: AppDatabase; botId?: string } = {};
    const modelPort = await listen(async (_req, res) => {
      if (seen.db && seen.botId) peaks.push(activeCount(seen.db, seen.botId));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("同时结束"));
    });
    const run = await pair(modelPort);
    seen.db = run.db;
    seen.botId = run.bea;
    queue(run.db, run.ada, run.bea, "同时", "2026-01-07T00:00:00.000Z");
    await Promise.all([
      run.service.flushBotMessages(run.bea),
      run.service.send({ userId: "user-a", botId: run.bea, text: "用户也发", mode: "queue" }),
    ]);
    await run.service.idle();
    expect(activeCount(run.db, run.bea)).toBe(0);
    expect(peaks.length).toBeGreaterThan(0);
    expect(Math.max(...peaks)).toBe(1);
  });

  it("keeps a re-armed bot task exclusive before its worker starts", async () => {
    const release = Promise.withResolvers<void>();
    const modelPort = await listen(async (_req, res) => {
      await release.promise;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("完成"));
    });
    const started = await seeded(modelPort, (db, ada, bea) => {
      const sourceConversation = ulid();
      const targetConversation = ulid();
      const queued = ulid();
      const waiting = ulid();
      const request = queue(db, ada, bea, "恢复", "2026-01-01T00:00:00.000Z", undefined);
      const conversation = db.$client.prepare("insert into conversations (id,bot_id,title,created_at,updated_at) values (?,?,'','t','t')");
      conversation.run(sourceConversation, ada);
      conversation.run(targetConversation, bea);
      db.$client.prepare("insert into tasks (id,bot_id,conversation_id,state,trigger) values (?,?,?,'queued','user')").run(queued, ada, sourceConversation);
      db.$client.prepare("insert into tasks (id,bot_id,conversation_id,state,trigger,bot_message_id) values (?,?,?,'waiting_takeover','bot_message',?)").run(waiting, bea, targetConversation, request);
      db.$client.prepare("update bot_messages set state='dispatched', task_id=? where id=?").run(waiting, request);
      db.$client.prepare("insert into messages (id,conversation_id,role,content_json,task_id,created_at) values (?,?,'user',?,?,'t')")
        .run(ulid(), sourceConversation, storedContent({ role: "user", content: "先占用名额", timestamp: 1 }, "先占用名额"), queued);
      return waiting;
    }, { VB_MAX_RUNNING_TASKS: "1" });
    try {
      await expect(started.service.send({ userId: started.scope.userId, botId: started.bea, text: "用户消息", mode: "queue" })).rejects.toMatchObject({ statusCode: 409 });
      expect(activeCount(started.db, started.bea)).toBe(1);
    } finally {
      started.service.stop(started.scope, started.planted);
      release.resolve();
      await started.service.idle();
    }
  });

  it("omits the tool for a single bot and lists the peer when another exists", async () => {
    const seen: string[] = [];
    const modelPort = await listen(async (_req, res, body) => {
      seen.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textSse("在"));
    });
    const alone = await pair(modelPort, { second: false });
    await alone.service.send({ userId: "user-a", botId: alone.ada, text: "只有我", mode: "queue" });
    await alone.service.idle();
    expect(seen.some((body) => body.includes("send_to_bot"))).toBe(false);
    seen.length = 0;
    const both = await pair(modelPort);
    await both.service.send({ userId: "user-a", botId: both.ada, text: "有同伴", mode: "queue" });
    await both.service.idle();
    expect(seen.some((body) => body.includes("send_to_bot") && body.includes(both.bea) && body.includes("Bea"))).toBe(true);
  });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

function lastUser(body: string): string {
  const json = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
  const users = (json.messages ?? []).filter((message) => message.role === "user");
  const last = users[users.length - 1]?.content;
  return typeof last === "string" ? last : JSON.stringify(last ?? "");
}

function textSse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
}

function toolSse(name: string, args: unknown): string {
  const encoded = JSON.stringify(args);
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_send", function: { name, arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: encoded } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

interface ToolFixture {
  db: AppDatabase;
  scope: UserScope;
  botId: string;
  taskId: string;
}

function fixture(): ToolFixture {
  const dir = mkdtempSync(join(tmpdir(), "vb-bot-msg-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => {
    db.$client.close();
  });
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  ensureDevUser(db, "user-a");
  ensureDevUser(db, "user-b");
  const scope = userScope("user-a");
  const botId = insertBot({ db }, "user-a", "Ada");
  const conversationId = ulid();
  const taskId = ulid();
  db.$client.prepare("insert into conversations (id, bot_id, title, created_at, updated_at) values (?, ?, '', 't', 't')").run(conversationId, botId);
  db.$client.prepare("insert into tasks (id, bot_id, conversation_id, state, trigger) values (?, ?, ?, 'running', 'user')").run(taskId, botId, conversationId);
  return { db, scope, botId, taskId };
}

function insertBot(fx: { db: AppDatabase }, userId: string, name: string): string {
  const id = ulid();
  fx.db.$client.prepare("insert into bots (id, user_id, name, model, created_at, updated_at) values (?, ?, ?, 'fake', ?, ?)").run(id, userId, name, id, id);
  return id;
}

function interruptedRequest(fx: ToolFixture): { request: string; task: string } {
  const target = insertBot(fx, fx.scope.userId, "Bea");
  const request = queue(fx.db, fx.botId, target, "处理中", "2026-01-01T00:00:00.000Z", fx.taskId);
  const conversation = ulid();
  const task = ulid();
  fx.db.$client.prepare("insert into conversations (id,bot_id,title,created_at,updated_at) values (?,?,'','t','t')").run(conversation, target);
  fx.db.$client.prepare("insert into tasks (id,bot_id,conversation_id,state,trigger,bot_message_id) values (?,?,?,'running','bot_message',?)").run(task, target, conversation, request);
  fx.db.$client.prepare("update bot_messages set state='dispatched', task_id=? where id=?").run(task, request);
  return { request, task };
}

function countMessages(db: AppDatabase): number {
  return db.$client.prepare("select count(*) as n from bot_messages").pluck().get() as number;
}

function onlyMessage(db: AppDatabase): { fromBotId: string; toBotId: string; hop: number; body: string; state: string; originTaskId: string | null; replyToId: string | null } {
  return db.$client.prepare("select from_bot_id as fromBotId, to_bot_id as toBotId, hop, body, state, origin_task_id as originTaskId, reply_to_id as replyToId from bot_messages").get() as {
    fromBotId: string;
    toBotId: string;
    hop: number;
    body: string;
    state: string;
    originTaskId: string | null;
    replyToId: string | null;
  };
}

function queue(db: AppDatabase, fromBotId: string, toBotId: string, body: string, createdAt: string, originTaskId?: string): string {
  const id = ulid();
  insertBotMessage(db, {
    id,
    userId: "user-a",
    fromBotId,
    toBotId,
    ...(originTaskId ? { originTaskId } : {}),
    hop: 1,
    body,
    state: "queued",
    createdAt,
  });
  return id;
}

function activeCount(db: AppDatabase, botId: string): number {
  return db.$client.prepare("select count(*) as n from tasks where bot_id = ? and state in ('queued', 'running', 'waiting_approval', 'waiting_takeover', 'waiting_input')").pluck().get(botId) as number;
}

function tasksOf(db: AppDatabase, botId: string): Array<{ id: string; trigger: string; botMessageId: string | null }> {
  return db.$client.prepare("select id, trigger, bot_message_id as botMessageId from tasks where bot_id = ? order by id").all(botId) as Array<{ id: string; trigger: string; botMessageId: string | null }>;
}

function taskText(db: AppDatabase, scope: UserScope, taskId: string): string {
  const task = chatRepository(db).findTask(scope, taskId);
  const rows = task?.conversationId ? chatRepository(db).listMessages(scope, task.conversationId) ?? [] : [];
  return rows.filter((row) => row.taskId === taskId && row.role === "user").map((row) => messageView(row).text).join("\n");
}

function textsConversation(db: AppDatabase, taskId: string): string {
  return (db.$client.prepare("select conversation_id as id from tasks where id = ?").get(taskId) as { id: string }).id;
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      void Promise.resolve(handler(req, res, Buffer.concat(chunks).toString("utf8"))).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return port;
}

async function opened(env: Record<string, string>): Promise<{ config: ControlConfig; ctx: ControlContext }> {
  const dir = mkdtempSync(join(tmpdir(), "vb-bot-msg-app-"));
  dirs.push(dir);
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_API_KEY: "test-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
    ...env,
  });
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const ctx: ControlContext = { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
  ensureDevUser(db, "user-a");
  closers.push(() => {
    db.$client.close();
  });
  return { config, ctx };
}

async function boot(modelPort: number, prepareEndpoint?: ChatServiceDeps["prepareEndpoint"]) {
  const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1` });
  const app = buildApp(ctx, {
    ensureMachine: async () => {},
    prepareEndpoint: prepareEndpoint ?? (async (_userId, onPhase) => {
      onPhase("ready");
      return { host: "127.0.0.1", port: 9, token: "machine" };
    }),
  });
  closers.push(() => app.close());
  await app.ready();
  const runtime = createRuntime(config, ctx.db);
  return { config, ctx, app, service: chatService(app), runtime, db: ctx.db, scope: userScope("user-a") };
}

async function pair(modelPort: number, options: { second?: boolean; prepareEndpoint?: ChatServiceDeps["prepareEndpoint"] } = {}) {
  const started = await boot(modelPort, options.prepareEndpoint);
  const ada = await createBot(
    { db: started.db, key: started.ctx.key, credentials: started.runtime.credentials, providerId: started.runtime.identity.id },
    started.scope,
    { name: "Ada", model: "gpt-test" },
  );
  const bea = options.second === false
    ? ada
    : await createBot(
      { db: started.db, key: started.ctx.key, credentials: started.runtime.credentials, providerId: started.runtime.identity.id },
      started.scope,
      { name: "Bea", model: "gpt-test" },
    );
  return {
    ...started,
    service: started.service,
    ada: ada.id,
    bea: bea.id,
  };
}

async function seeded(modelPort: number, plant: (db: AppDatabase, ada: string, bea: string) => string, env: Record<string, string> = {}) {
  const { config, ctx } = await opened({ VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, ...env });
  const runtime = createRuntime(config, ctx.db);
  const scope = userScope("user-a");
  const ada = await createBot(
    { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
    scope,
    { name: "Ada", model: "gpt-test" },
  );
  const bea = await createBot(
    { db: ctx.db, key: ctx.key, credentials: runtime.credentials, providerId: runtime.identity.id },
    scope,
    { name: "Bea", model: "gpt-test" },
  );
  const planted = plant(ctx.db, ada.id, bea.id);
  const app = buildApp(ctx, {
    ensureMachine: async () => {},
    prepareEndpoint: async (_userId, onPhase) => {
      onPhase("ready");
      return { host: "127.0.0.1", port: 9, token: "machine" };
    },
  });
  closers.push(() => app.close());
  await app.ready();
  return { db: ctx.db, service: chatService(app), ada: ada.id, bea: bea.id, planted, scope };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
