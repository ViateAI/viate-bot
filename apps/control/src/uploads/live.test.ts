import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { ensureDevUser } from "../db/users.js";
import { createSession } from "../session.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("live attachment evidence", () => {
  it("B2 accepts a blank message when an attachment is present", async () => {
    const machine = await createMachine();
    const harness = await boot(machine, "openai-completions");
    const botId = await createBot(harness.app, harness.alice);
    const upload = await uploadFile(harness.app, harness.alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(harness.app, harness.alice, botId, "   ", [upload.id], "queue");
    expect(sent.statusCode).toBe(202);
    harness.release();
    const taskId = (sent.json() as { taskId: string }).taskId;
    expect((await finished(harness, taskId)).state).toBe("succeeded");
    expect(harness.bodies.some((body) => body.includes("/notes.txt") && body.includes("secret-bytes") === false)).toBe(true);
    expect(machine.uploads.map((item) => item.body.toString("utf8"))).toEqual(["secret-bytes"]);
    const empty = await send(harness.app, harness.alice, botId, "   ", [], "queue");
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("消息不能为空");
  });

  it("keeps the control-plane copy when delivery fails", async () => {
    const machine = await createMachine({ failUpload: true });
    const harness = await boot(machine, "openai-completions");
    const botId = await createBot(harness.app, harness.alice);
    const upload = await uploadFile(harness.app, harness.alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(harness.app, harness.alice, botId, "look", [upload.id], "queue");
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as { taskId: string; messageId: string };
    harness.release();
    const task = await finished(harness, body.taskId);
    expect(task.state).toBe("failed");
    expect(task.error).toMatch(/notes\.txt|上传|500|失败/);
    const file = join(harness.dir, "uploads", "user-a", upload.id);
    expect(readFileSync(file)).toEqual(Buffer.from("secret-bytes"));
    expect(harness.db.$client.prepare("select delivered_at as deliveredAt, message_id as messageId from uploads where id=?").get(upload.id)).toEqual({
      deliveredAt: null,
      messageId: body.messageId,
    });
    const stored = harness.db.$client.prepare("select content_json as contentJson from messages where id=?").get(body.messageId) as { contentJson: string };
    expect(stored.contentJson).toContain(upload.id);
    expect(stored.contentJson).not.toContain("secret-bytes");
    expect(machine.uploads).toEqual([]);
  });

  it.each(["openai-completions", "openai-responses"] as const)(
    "B3 delivers queued and steered files before the next %s call and drops the image after three later user turns",
    async (api) => {
      const machine = await createMachine();
      const harness = await boot(machine, api);
      const botId = await createBot(harness.app, harness.alice);
      const sent = await send(harness.app, harness.alice, botId, "look", [], "queue");
      expect(sent.statusCode).toBe(202);
      const taskId = (sent.json() as { taskId: string }).taskId;
      await waitFor(() => harness.bodies.length === 1);
      const notes = await uploadFile(harness.app, harness.alice, "notes.txt", Buffer.from("queued-bytes"));
      const image = await uploadFile(harness.app, harness.alice, "dot.png", PNG);
      const queued = await send(harness.app, harness.alice, botId, "read this", [notes.id], "queue");
      const steered = await send(harness.app, harness.alice, botId, "see this", [image.id], "steer");
      expect(queued.statusCode).toBe(202);
      expect(steered.statusCode).toBe(202);
      const queuedId = (queued.json() as { messageId: string }).messageId;
      const steeredId = (steered.json() as { messageId: string }).messageId;
      await waitFor(() => machine.uploads.length === 2);
      expect(harness.bodies).toHaveLength(1);
      const delivered = machine.uploads
        .map((item) => ({ path: item.path, body: item.body.toString("base64") }))
        .sort((a, b) => a.path.localeCompare(b.path));
      expect(delivered).toEqual([
        { path: remotePath(harness.db, queuedId, "notes.txt"), body: Buffer.from("queued-bytes").toString("base64") },
        { path: remotePath(harness.db, steeredId, "dot.png"), body: PNG.toString("base64") },
      ].sort((a, b) => a.path.localeCompare(b.path)));
      harness.releaseNext();
      await waitFor(() => harness.bodies.length === 2);
      expect(harness.bodies[1]).toContain(PNG.toString("base64"));
      expect(harness.bodies[1]).toContain(remotePath(harness.db, steeredId, "dot.png"));
      for (const text of ["later-1", "later-2", "later-3"]) {
        const extra = await send(harness.app, harness.alice, botId, text, [], "queue");
        expect(extra.statusCode).toBe(202);
      }
      harness.releaseNext();
      await waitFor(() => harness.bodies.length === 3);
      const third = harness.bodies[2];
      if (third === undefined) throw new Error("第三轮没有请求");
      expect(third).not.toContain(PNG.toString("base64"));
      expect(third).toContain(remotePath(harness.db, steeredId, "dot.png"));
      expect(third).toContain(remotePath(harness.db, queuedId, "notes.txt"));
      expect(api === "openai-responses" ? third.includes("input_image") : third.includes("image_url")).toBe(false);
      harness.release();
      expect((await finished(harness, taskId)).state).toBe("succeeded");
      expect(machine.uploads).toHaveLength(2);
    },
  );

  it("defaults a running send to steer for text and attachments, and keeps an explicit queue behind the current turn", async () => {
    const machine = await createMachine();
    const harness = await boot(machine, "openai-completions");
    const botId = await createBot(harness.app, harness.alice);
    const opened = await send(harness.app, harness.alice, botId, "look", [], "queue");
    expect(opened.statusCode).toBe(202);
    const taskId = (opened.json() as { taskId: string }).taskId;
    await waitFor(() => harness.bodies.length === 1);
    const notes = await uploadFile(harness.app, harness.alice, "notes.txt", Buffer.from("attach-bytes"));
    const plain = await postMessage(harness.app, harness.alice, botId, "plain-default");
    const attached = await postMessage(harness.app, harness.alice, botId, "attach-default", { uploadIds: [notes.id] });
    const queued = await postMessage(harness.app, harness.alice, botId, "explicit-queue", { mode: "queue" });
    expect(plain.statusCode).toBe(202);
    expect(attached.statusCode).toBe(202);
    expect(queued.statusCode).toBe(202);
    const attachedBody = attached.json() as { taskId: string; messageId: string };
    expect((plain.json() as { taskId: string }).taskId).toBe(taskId);
    expect(attachedBody.taskId).toBe(taskId);
    expect((queued.json() as { taskId: string }).taskId).toBe(taskId);
    expect(harness.db.$client.prepare("select count(*) as n from tasks").get()).toEqual({ n: 1 });
    expect(textCell(harness.db.$client.prepare("select state from tasks where id=?").get(taskId), "state")).toBe("running");
    expect(harness.bodies).toHaveLength(1);
    expect(machine.uploads.map((item) => item.body.toString("utf8"))).toEqual(["attach-bytes"]);
    harness.releaseNext();
    await waitFor(() => harness.bodies.length === 2);
    expect(harness.bodies[1]).toContain("plain-default");
    expect(harness.bodies[1]).toContain("attach-default");
    expect(harness.bodies[1]).toContain(remotePath(harness.db, attachedBody.messageId, "notes.txt"));
    expect(harness.bodies[1]).not.toContain("explicit-queue");
    expect(textCell(harness.db.$client.prepare("select state from tasks where id=?").get(taskId), "state")).toBe("running");
    harness.releaseNext();
    await waitFor(() => harness.bodies.length === 3);
    expect(harness.bodies[2]).toContain("explicit-queue");
    expect(harness.bodies[2]).toContain("plain-default");
    harness.release();
    expect((await finished(harness, taskId)).state).toBe("succeeded");
  });

  it("B3 does not return the finished task when delivery outlives that agent", async () => {
    let releaseUpload: () => void = () => {};
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let arrived = false;
    const machine = await createMachine({
      hold: () => {
        arrived = true;
        return uploadGate;
      },
    });
    const harness = await boot(machine, "openai-completions");
    const botId = await createBot(harness.app, harness.alice);
    const opened = await send(harness.app, harness.alice, botId, "look", [], "queue");
    expect(opened.statusCode).toBe(202);
    const originalId = (opened.json() as { taskId: string }).taskId;
    await waitFor(() => harness.bodies.length === 1);
    const notes = await uploadFile(harness.app, harness.alice, "notes.txt", Buffer.from("queued-bytes"));
    const followed = send(harness.app, harness.alice, botId, "read this", [notes.id], "queue");
    try {
      await waitFor(() => arrived);
      harness.releaseNext();
      await waitFor(() => textCell(harness.db.$client.prepare("select state from tasks where id=?").get(originalId), "state") === "succeeded");
      releaseUpload();
      const sent = await followed;
      expect(sent.statusCode).toBe(202);
      const body = sent.json() as { taskId: string; messageId: string };
      expect(harness.db.$client.prepare("select task_id as taskId from messages where id=?").get(body.messageId)).toEqual({
        taskId: body.taskId,
      });
      const state = textCell(harness.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state");
      expect(state).not.toBe("succeeded");
      expect(state).not.toBe("failed");
      expect(state).not.toBe("cancelled");
      expect(state).not.toBe("interrupted");
      await waitFor(() => harness.bodies.some((entry) => entry.includes(remotePath(harness.db, body.messageId, "notes.txt"))));
      expect(machine.uploads).toEqual([
        { path: remotePath(harness.db, body.messageId, "notes.txt"), body: Buffer.from("queued-bytes") },
      ]);
      expect(textCell(harness.db.$client.prepare("select state from tasks where id=?").get(originalId), "state")).toBe("succeeded");
      harness.release();
      expect((await finished(harness, body.taskId)).state).toBe("succeeded");
      expect(harness.bodies.filter((entry) => entry.includes(remotePath(harness.db, body.messageId, "notes.txt")))).toHaveLength(1);
    } finally {
      releaseUpload();
      await followed.catch(() => undefined);
    }
  });

  it("B3 delivers both files to the resent message after the second upload fails", async () => {
    const machine = await createMachine({ rejectAttempt: (attempt) => attempt === 2, keepExisting: true });
    const harness = await boot(machine, "openai-completions");
    const botId = await createBot(harness.app, harness.alice);
    const opened = await send(harness.app, harness.alice, botId, "look", [], "queue");
    expect(opened.statusCode).toBe(202);
    await waitFor(() => harness.bodies.length === 1);
    const alpha = await uploadFile(harness.app, harness.alice, "alpha.txt", Buffer.from("alpha-bytes"));
    const beta = await uploadFile(harness.app, harness.alice, "beta.txt", Buffer.from("beta-bytes"));
    const failed = await send(harness.app, harness.alice, botId, "send-both", [alpha.id, beta.id], "queue");
    expect(failed.statusCode).toBe(502);
    expect(String((failed.json() as { error?: string }).error ?? "")).toContain("beta.txt");
    expect(harness.db.$client.prepare("select count(*) as n from messages where content_json like '%send-both%'").get()).toEqual({ n: 0 });
    expect(harness.db.$client.prepare("select message_id as messageId, delivered_at as deliveredAt from uploads where id=?").get(alpha.id)).toEqual({
      messageId: null,
      deliveredAt: null,
    });
    expect(harness.db.$client.prepare("select message_id as messageId, delivered_at as deliveredAt from uploads where id=?").get(beta.id)).toEqual({
      messageId: null,
      deliveredAt: null,
    });
    const placed = machine.uploads.find((item) => item.path.endsWith("/alpha.txt"));
    if (!placed) throw new Error("alpha was not stored");
    placed.body = Buffer.from("alpha-edited");
    const resent = await send(harness.app, harness.alice, botId, "send-both", [alpha.id, beta.id], "queue");
    expect(resent.statusCode).toBe(202);
    const body = resent.json() as { taskId: string; messageId: string };
    expect(harness.db.$client.prepare("select task_id as taskId from messages where id=?").get(body.messageId)).toEqual({
      taskId: body.taskId,
    });
    harness.releaseNext();
    await waitFor(() => harness.bodies.some((entry) => entry.includes(remotePath(harness.db, body.messageId, "alpha.txt"))));
    const seen = harness.bodies.find((entry) => entry.includes(remotePath(harness.db, body.messageId, "alpha.txt")));
    expect(seen).toContain(remotePath(harness.db, body.messageId, "beta.txt"));
    expect(machine.uploads.filter((item) => item.path === placed.path).map((item) => item.body.toString("utf8"))).toEqual(["alpha-edited"]);
    expect(machine.uploads.filter((item) => item.path === remotePath(harness.db, body.messageId, "alpha.txt")).map((item) => item.body.toString("utf8"))).toEqual([
      body.messageId === placed.path.split("/")[4] ? "alpha-edited" : "alpha-bytes",
    ]);
    expect(machine.uploads.filter((item) => item.path === remotePath(harness.db, body.messageId, "beta.txt")).map((item) => item.body.toString("utf8"))).toEqual([
      "beta-bytes",
    ]);
    expect(machine.uploads.filter((item) => item.path.endsWith("/beta.txt"))).toHaveLength(1);
    harness.release();
    expect((await finished(harness, body.taskId)).state).toBe("succeeded");
  });
  it("keeps a slow follow-up in the next model context after the summary anchor advances", async () => {
    const held = await holdFollowUp("anchor-follow-up");
    try {
      const assistantId = textCell(
        held.harness.db.$client.prepare("select id from messages where conversation_id=? and role='assistant'").get(held.conversationId),
        "id",
      );
      if (!assistantId) throw new Error("原回复还没有入库");
      held.harness.db.$client
        .prepare("update conversations set summary_text=?, summary_until_message_id=? where id=?")
        .run("summary-covers-early", assistantId, held.conversationId);
      held.releaseUpload();
      const sent = await held.followed;
      expect(sent.statusCode).toBe(202);
      const body = sent.json() as { taskId: string; messageId: string };
      await waitFor(() => held.harness.bodies.some((entry) => entry.includes("anchor-follow-up")));
      held.harness.releaseNext();
      expect((await finished(held.harness, body.taskId)).state).toBe("succeeded");
      const later = await send(held.harness.app, held.harness.alice, held.botId, "after-anchor", [], "queue");
      expect(later.statusCode).toBe(202);
      const next = later.json() as { taskId: string };
      await waitFor(() => held.harness.bodies.some((entry) => entry.includes("after-anchor")));
      held.harness.release();
      expect((await finished(held.harness, next.taskId)).state).toBe("succeeded");
      const request = held.harness.bodies.find((entry) => entry.includes("after-anchor"));
      if (!request) throw new Error("下一轮没有把后续消息送给模型");
      const texts = modelTexts(request);
      expect(texts.filter((item) => item.includes("anchor-follow-up"))).toHaveLength(1);
      expect(request).toContain("summary-covers-early");
      const listed = await history(held.harness, held.conversationId);
      expect(listed.filter((item) => item.text.includes("anchor-follow-up"))).toHaveLength(1);
      const apiAssistant = listed.findIndex((item) => item.id === assistantId);
      const apiFollow = listed.findIndex((item) => item.id === body.messageId);
      const apiLater = listed.findIndex((item) => item.text.includes("after-anchor"));
      expect(apiFollow).toBeGreaterThan(apiAssistant);
      expect(apiLater).toBeGreaterThan(apiFollow);
      const modelFollow = texts.findIndex((item) => item.includes("anchor-follow-up"));
      const modelLater = texts.findIndex((item) => item.includes("after-anchor"));
      expect(modelLater).toBeGreaterThan(modelFollow);
    } finally {
      held.releaseUpload();
      await held.followed.catch(() => undefined);
    }
  });

  it("keeps API history and the next model context aligned when a follow-up shares the reply millisecond", async () => {
    const held = await holdFollowUp("same-ms-follow-up");
    try {
      held.releaseUpload();
      const sent = await held.followed;
      expect(sent.statusCode).toBe(202);
      const body = sent.json() as { taskId: string; messageId: string };
      await waitFor(() => held.harness.bodies.some((entry) => entry.includes("same-ms-follow-up")));
      held.harness.releaseNext();
      expect((await finished(held.harness, body.taskId)).state).toBe("succeeded");
      const stamp = "2026-01-01T00:00:00.000Z";
      const tiedIds = new Set((await history(held.harness, held.conversationId)).map((item) => item.id));
      held.harness.db.$client.prepare("update messages set created_at=? where conversation_id=?").run(stamp, held.conversationId);
      const later = await send(held.harness.app, held.harness.alice, held.botId, "after-tie", [], "queue");
      expect(later.statusCode).toBe(202);
      const next = later.json() as { taskId: string };
      await waitFor(() => held.harness.bodies.some((entry) => entry.includes("after-tie")));
      held.harness.release();
      expect((await finished(held.harness, next.taskId)).state).toBe("succeeded");
      const request = held.harness.bodies.find((entry) => entry.includes("after-tie"));
      if (!request) throw new Error("下一轮没有把后续消息送给模型");
      const texts = modelTexts(request);
      const replyAt = texts.findIndex((item) => item === "ok");
      const followAt = texts.findIndex((item) => item.includes("same-ms-follow-up"));
      expect(replyAt).toBeGreaterThanOrEqual(0);
      expect(followAt).toBeGreaterThan(replyAt);
      expect(texts.filter((item) => item.includes("same-ms-follow-up"))).toHaveLength(1);
      const listed = await history(held.harness, held.conversationId);
      expect(listed.filter((item) => tiedIds.has(item.id)).every((item) => item.createdAt === stamp)).toBe(true);
      const apiReply = listed.findIndex((item) => item.text === "ok");
      const apiFollow = listed.findIndex((item) => item.text.includes("same-ms-follow-up"));
      expect(apiFollow).toBeGreaterThan(apiReply);
      expect(replyAt < followAt).toBe(apiReply < apiFollow);
    } finally {
      held.releaseUpload();
      await held.followed.catch(() => undefined);
    }
  });

  it("shows one follow-up in history and the next model context when the summary moves during delivery at the same millisecond", async () => {
    const held = await holdFollowUp("order-follow-up");
    try {
      const assistantId = textCell(
        held.harness.db.$client.prepare("select id from messages where conversation_id=? and role='assistant'").get(held.conversationId),
        "id",
      );
      if (!assistantId) throw new Error("原回复还没有入库");
      expect(held.harness.db.$client.prepare("select count(*) as n from messages where content_json like '%order-follow-up%'").get()).toEqual({ n: 0 });
      held.harness.db.$client
        .prepare("update conversations set summary_text=?, summary_until_message_id=? where id=?")
        .run("summary-covers-early", assistantId, held.conversationId);
      held.releaseUpload();
      const sent = await held.followed;
      expect(sent.statusCode).toBe(202);
      const body = sent.json() as { taskId: string; messageId: string };
      const stored = held.harness.db.$client.prepare("select content_json as contentJson from messages where id=?").get(body.messageId) as { contentJson: string };
      const place = (JSON.parse(stored.contentJson) as { attachments?: Array<{ place?: string }> }).attachments?.[0]?.place;
      if (!place) throw new Error("消息没有记下投递路径");
      expect(place).not.toBe(body.messageId);
      const stamp = "2026-01-01T00:00:00.000Z";
      held.harness.db.$client.prepare("update messages set created_at=? where id in (?, ?)").run(stamp, assistantId, body.messageId);
      await waitFor(() => held.harness.bodies.some((entry) => entry.includes("order-follow-up")));
      held.harness.releaseNext();
      expect((await finished(held.harness, body.taskId)).state).toBe("succeeded");
      const later = await send(held.harness.app, held.harness.alice, held.botId, "after-order", [], "queue");
      expect(later.statusCode).toBe(202);
      const next = later.json() as { taskId: string };
      await waitFor(() => held.harness.bodies.some((entry) => entry.includes("after-order")));
      held.harness.release();
      expect((await finished(held.harness, next.taskId)).state).toBe("succeeded");
      const request = held.harness.bodies.find((entry) => entry.includes("after-order"));
      if (!request) throw new Error("下一轮没有把后续消息送给模型");
      const texts = modelTexts(request);
      expect(texts.filter((item) => item.includes("order-follow-up"))).toHaveLength(1);
      expect(request).toContain("summary-covers-early");
      expect(request).toContain(`/home/bot/uploads/${place}/notes.txt`);
      const listed = await history(held.harness, held.conversationId);
      expect(listed.filter((item) => item.text.includes("order-follow-up"))).toHaveLength(1);
      const apiAssistant = listed.findIndex((item) => item.id === assistantId);
      const apiFollow = listed.findIndex((item) => item.id === body.messageId);
      const apiLater = listed.findIndex((item) => item.text.includes("after-order"));
      const modelFollow = texts.findIndex((item) => item.includes("order-follow-up"));
      const modelLater = texts.findIndex((item) => item.includes("after-order"));
      const summaryAt = texts.findIndex((item) => item.includes("summary-covers-early"));
      expect(place < assistantId).toBe(true);
      expect(body.messageId > assistantId).toBe(true);
      expect(apiFollow).toBeGreaterThan(apiAssistant);
      expect(apiLater).toBeGreaterThan(apiFollow);
      expect(summaryAt).toBeGreaterThanOrEqual(0);
      expect(modelFollow).toBeGreaterThan(summaryAt);
      expect(modelLater).toBeGreaterThan(modelFollow);
      expect(apiFollow < apiLater).toBe(modelFollow < modelLater);
      expect(listed.filter((item) => item.id === assistantId || item.id === body.messageId).every((item) => item.createdAt === stamp)).toBe(true);
    } finally {
      held.releaseUpload();
      await held.followed.catch(() => undefined);
    }
  });


  it("I1 keeps the tool result and a single delivery after a real approval and a control restart", async () => {
    const execs: string[] = [];
    const machine = await createMachine({ execs });
    let calls = 0;
    const first = await boot(machine, "openai-completions", {
      reply: () => {
        calls += 1;
        return calls === 1 ? toolSse("shell_exec", JSON.stringify({ cmd: "echo remote-edit" })) : chatStop("approved");
      },
    });
    const botId = await createBot(first.app, first.alice);
    const upload = await uploadFile(first.app, first.alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(first.app, first.alice, botId, "look", [upload.id], "queue");
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as { taskId: string; conversationId: string; messageId: string };
    await waitFor(() => {
      const approval = first.db.$client.prepare("select state from approvals where task_id=?").get(body.taskId) as { state: string } | undefined;
      const task = first.db.$client.prepare("select state from tasks where id=?").get(body.taskId) as { state: string } | undefined;
      return approval?.state === "pending" && task?.state === "waiting_approval";
    });
    expect(execs).toEqual([]);
    expect(machine.uploads).toHaveLength(1);
    const approval = first.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(body.taskId) as { id: string };
    const decided = await first.app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      headers: { cookie: cookie(first.alice.token), "x-vb-csrf": first.alice.csrf, "content-type": "application/json" },
      payload: { decision: "allow" },
    });
    expect(decided.statusCode).toBe(200);
    expect((await finished(first, body.taskId)).state).toBe("succeeded");
    expect(execs).toEqual(["echo remote-edit"]);
    const before = first.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId) as Array<{ role: string; contentJson: string }>;
    expect(before.some((message) => message.role === "toolResult" && message.contentJson.includes("remote-edit"))).toBe(true);
    expect(before.some((message) => message.contentJson.includes("shell_exec"))).toBe(true);
    await first.close();
    const second = await boot(machine, "openai-completions", { dir: first.dir, reply: () => chatStop("restarted") });
    await chatService(second.app).idle();
    expect(second.db.$client.prepare("select state from tasks where id=?").get(body.taskId)).toEqual({ state: "succeeded" });
    expect(execs).toEqual(["echo remote-edit"]);
    expect(machine.uploads).toHaveLength(1);
    expect(machine.uploads[0]?.body.equals(Buffer.from("secret-bytes"))).toBe(true);
    const after = second.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId);
    expect(after).toEqual(before);
  });

  it("I1 keeps the tool result and a single delivery after a real takeover release and a control restart", async () => {
    const machine = await createMachine();
    let calls = 0;
    const first = await boot(machine, "openai-completions", {
      reply: () => {
        calls += 1;
        return calls === 1 ? toolSse("request_takeover", "{}") : chatStop("returned");
      },
    });
    const botId = await createBot(first.app, first.alice);
    const upload = await uploadFile(first.app, first.alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(first.app, first.alice, botId, "look", [upload.id], "queue");
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as { taskId: string; conversationId: string };
    await waitFor(() => textCell(first.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state") === "waiting_approval");
    const approvalId = textCell(
      first.db.$client.prepare("select id, state from approvals where task_id=? and state='pending'").get(body.taskId),
      "id",
    );
    expect(approvalId).toBeTruthy();
    expect(textCell(first.db.$client.prepare("select state from takeover_leases where task_id=?").get(body.taskId), "state")).toBeUndefined();
    const decided = await first.app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decide`,
      headers: { cookie: cookie(first.alice.token), "x-vb-csrf": first.alice.csrf, "content-type": "application/json" },
      payload: { decision: "allow" },
    });
    expect(decided.statusCode).toBe(200);
    await waitFor(() => {
      const task = textCell(first.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state");
      const lease = textCell(first.db.$client.prepare("select state from takeover_leases where task_id=?").get(body.taskId), "state");
      return task === "waiting_takeover" && lease === "requested";
    });
    expect(machine.uploads).toHaveLength(1);
    const headers = {
      cookie: cookie(first.alice.token),
      "x-vb-csrf": first.alice.csrf,
      "content-type": "application/json",
      origin: "http://127.0.0.1:4418",
    };
    const socketId = "abcdefghijklmnop";
    const viewer = await first.app.injectWS(`/api/bots/${botId}/screen/vnc?socket=${socketId}`, {
      headers: { cookie: headers.cookie, origin: headers.origin },
    });
    const leaseId = textCell(
      first.db.$client.prepare("select id from takeover_leases where task_id=? and state='requested'").get(body.taskId),
      "id",
    );
    expect(leaseId).toBeTruthy();
    const granted = await first.app.inject({
      method: "POST",
      url: `/api/bots/${botId}/screen/grant`,
      headers,
      payload: { leaseId, socketId },
    });
    expect(granted.statusCode).toBe(200);
    const released = await first.app.inject({
      method: "POST",
      url: `/api/bots/${botId}/screen/release`,
      headers,
      payload: { leaseId },
    });
    expect(released.statusCode).toBe(200);
    expect((await finished(first, body.taskId)).state).toBe("succeeded");
    const before = first.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId);
    expect(JSON.stringify(before)).toContain("用户已交还屏幕");
    viewer.close();
    await first.close();
    const second = await boot(machine, "openai-completions", { dir: first.dir, reply: () => chatStop("restarted") });
    await chatService(second.app).idle();
    expect(second.db.$client.prepare("select state from tasks where id=?").get(body.taskId)).toEqual({ state: "succeeded" });
    expect(machine.uploads).toHaveLength(1);
    expect(machine.uploads[0]?.body.equals(Buffer.from("secret-bytes"))).toBe(true);
    expect(second.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId)).toEqual(before);
  });

  it("I1 resumes a real waiting approval after the control plane restarts", async () => {
    const execs: string[] = [];
    const machine = await createMachine({ execs });
    let calls = 0;
    const first = await boot(machine, "openai-completions", {
      reply: () => {
        calls += 1;
        return calls === 1 ? toolSse("shell_exec", JSON.stringify({ cmd: "echo remote-edit" })) : chatStop("approved");
      },
    });
    const botId = await createBot(first.app, first.alice);
    const upload = await uploadFile(first.app, first.alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(first.app, first.alice, botId, "look", [upload.id], "queue");
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as { taskId: string; conversationId: string };
    await waitFor(() => {
      const approval = textCell(first.db.$client.prepare("select state from approvals where task_id=?").get(body.taskId), "state");
      const task = textCell(first.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state");
      return approval === "pending" && task === "waiting_approval";
    });
    expect(execs).toEqual([]);
    expect(machine.uploads).toHaveLength(1);
    const approvalId = textCell(first.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(body.taskId), "id");
    const before = first.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId);
    expect(JSON.stringify(before)).toContain("shell_exec");
    const dir = first.dir;
    const alice = first.alice;
    await halt(first);
    const second = await boot(machine, "openai-completions", { dir, reply: () => chatStop("approved") });
    await waitFor(() => {
      const state = textCell(second.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state");
      return state === "waiting_approval" || state === "succeeded" || state === "failed" || state === "cancelled" || state === "interrupted";
    });
    expect(textCell(second.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state")).toBe("waiting_approval");
    expect(second.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId)).toEqual(before);
    expect(execs).toEqual([]);
    const decided = await second.app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decide`,
      headers: { cookie: cookie(alice.token), "x-vb-csrf": alice.csrf, "content-type": "application/json" },
      payload: { decision: "allow" },
    });
    expect(decided.statusCode).toBe(200);
    expect((await finished(second, body.taskId)).state).toBe("succeeded");
    expect(execs).toEqual(["echo remote-edit"]);
    expect(machine.uploads).toHaveLength(1);
    expect(machine.uploads[0]?.body.equals(Buffer.from("secret-bytes"))).toBe(true);
    const after = second.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId) as Array<{ role: string; contentJson: string }>;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.some((message) => message.role === "toolResult" && message.contentJson.includes("remote-edit"))).toBe(true);
  });

  it("I1 resumes a real waiting takeover after the control plane restarts", async () => {
    const machine = await createMachine();
    let calls = 0;
    const first = await boot(machine, "openai-completions", {
      reply: () => {
        calls += 1;
        return calls === 1 ? toolSse("request_takeover", "{}") : chatStop("returned");
      },
    });
    const botId = await createBot(first.app, first.alice);
    const upload = await uploadFile(first.app, first.alice, "notes.txt", Buffer.from("secret-bytes"));
    const sent = await send(first.app, first.alice, botId, "look", [upload.id], "queue");
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as { taskId: string; conversationId: string };
    await waitFor(() => textCell(first.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state") === "waiting_approval");
    const approvalId = textCell(first.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(body.taskId), "id");
    expect(approvalId).toBeTruthy();
    const headers = {
      cookie: cookie(first.alice.token),
      "x-vb-csrf": first.alice.csrf,
      "content-type": "application/json",
      origin: "http://127.0.0.1:4418",
    };
    const decided = await first.app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decide`,
      headers,
      payload: { decision: "allow" },
    });
    expect(decided.statusCode).toBe(200);
    await waitFor(() => {
      const task = textCell(first.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state");
      const lease = textCell(first.db.$client.prepare("select state from takeover_leases where task_id=?").get(body.taskId), "state");
      return task === "waiting_takeover" && lease === "requested";
    });
    const before = first.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId);
    expect(JSON.stringify(before)).toContain("request_takeover");
    expect(machine.uploads).toHaveLength(1);
    const dir = first.dir;
    await halt(first);
    const second = await boot(machine, "openai-completions", { dir, reply: () => chatStop("returned") });
    await waitFor(() => {
      const task = textCell(second.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state");
      const lease = textCell(second.db.$client.prepare("select state from takeover_leases where task_id=? and state='requested'").get(body.taskId), "state");
      return (task === "waiting_takeover" && lease === "requested") || task === "succeeded" || task === "failed" || task === "cancelled" || task === "interrupted";
    });
    expect(textCell(second.db.$client.prepare("select state from tasks where id=?").get(body.taskId), "state")).toBe("waiting_takeover");
    expect(second.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId)).toEqual(before);
    const socketId = "abcdefghijklmnop";
    const viewer = await second.app.injectWS(`/api/bots/${botId}/screen/vnc?socket=${socketId}`, {
      headers: { cookie: headers.cookie, origin: headers.origin },
    });
    const leaseId = textCell(
      second.db.$client.prepare("select id from takeover_leases where task_id=? and state='requested'").get(body.taskId),
      "id",
    );
    expect(leaseId).toBeTruthy();
    let granted = 0;
    await waitFor(async () => {
      const response = await second.app.inject({
        method: "POST",
        url: `/api/bots/${botId}/screen/grant`,
        headers,
        payload: { leaseId, socketId },
      });
      granted = response.statusCode;
      return granted === 200;
    });
    expect(granted).toBe(200);
    const released = await second.app.inject({
      method: "POST",
      url: `/api/bots/${botId}/screen/release`,
      headers,
      payload: { leaseId },
    });
    expect(released.statusCode).toBe(200);
    expect((await finished(second, body.taskId)).state).toBe("succeeded");
    const after = second.db.$client.prepare("select role, content_json as contentJson from messages where conversation_id=? order by id").all(body.conversationId) as Array<{ contentJson: string }>;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(after)).toContain("用户已交还屏幕");
    expect(machine.uploads).toHaveLength(1);
    expect(machine.uploads[0]?.body.equals(Buffer.from("secret-bytes"))).toBe(true);
    viewer.close();
  });
});

interface UploadRecord {
  path: string;
  body: Buffer;
}

async function createMachine(options?: {
  failUpload?: boolean;
  execs?: string[];
  hold?: (attempt: number) => Promise<void> | void;
  rejectAttempt?: (attempt: number) => boolean;
  keepExisting?: boolean;
}): Promise<{ port: number; uploads: UploadRecord[] }> {
  const uploads: UploadRecord[] = [];
  let attempt = 0;
  const receipts = new Map<string, string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/skills") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ skills: [] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/exec") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { cmd?: string };
        options?.execs?.push(body.cmd ?? "");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ type: "stdout", data: "remote-edit\n" })}\n\ndata: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`,
        );
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/fs/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          const body = Buffer.concat(chunks);
          const path = url.searchParams.get("path") ?? "";
          const delivery = url.searchParams.get("delivery") ?? "";
          attempt += 1;
          if (options?.hold) await options.hold(attempt);
          if (options?.failUpload || options?.rejectAttempt?.(attempt)) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "disk full" }));
            return;
          }
          const prior = delivery.length > 0 ? receipts.get(delivery) : undefined;
          if (prior && prior !== path) {
            res.writeHead(409, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "投递标识已经用于其他路径" }));
            return;
          }
          if (!prior && !(options?.keepExisting && uploads.some((item) => item.path === path))) uploads.push({ path, body });
          if (delivery.length > 0) receipts.set(delivery, path);
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        })();
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const port = await listen(server);
  return { port, uploads };
}

async function halt(harness: { app: FastifyInstance; db: ControlContext["db"]; close: () => Promise<void> }): Promise<void> {
  const index = closers.indexOf(harness.close);
  if (index >= 0) closers.splice(index, 1);
  await harness.app.close();
  harness.db.$client.close();
  const active = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  for (const handle of active) {
    if (typeof handle !== "object" || handle === null || handle.constructor?.name !== "Timeout") continue;
    if ("unref" in handle && typeof handle.unref === "function") handle.unref();
  }
}

async function boot(
  machine: { port: number },
  api: "openai-completions" | "openai-responses",
  options?: { dir?: string; reply?: (body: string) => string },
) {
  const dir = options?.dir ?? mkdtempSync(join(tmpdir(), "vb-live-"));
  if (!options?.dir) dirs.push(dir);
  const bodies: string[] = [];
  const pending: Array<(payload: string) => void> = [];
  let opened = true;
  const stop = api === "openai-responses" ? responsesStop("ok") : chatStop("ok");
  const model = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const text = Buffer.concat(chunks).toString("utf8");
        bodies.push(text);
        if (options?.reply) {
          if (!res.destroyed) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(options.reply(text));
          }
          return;
        }
        const payload = await new Promise<string>((resolve) => {
          if (!opened) resolve(stop);
          else pending.push(resolve);
        });
        if (!res.destroyed) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(payload);
        }
      })();
    });
  });
  const modelPort = await listen(model);
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
    VB_MODEL_API_KEY: "test-key",
    VB_MODEL_API: api,
    VB_VISION_MODELS: "gpt-test",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
  });
  const ctx = contextFor(config);
  ensureDevUser(ctx.db, "user-a");
  const app = buildApp(ctx, {
    ensureMachine: async () => {},
    prepareEndpoint: async (_userId, onPhase) => {
      onPhase("ready");
      return { host: "127.0.0.1", port: machine.port, token: "t" };
    },
  });
  await app.ready();
  const release = () => {
    opened = false;
    for (const resolve of pending.splice(0)) resolve(stop);
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    release();
    await chatService(app).idle();
    await app.close();
    ctx.db.$client.close();
  };
  closers.push(close);
  return {
    close,
    app,
    dir,
    db: ctx.db,
    alice: createSession(ctx.db, ctx.key, "user-a", "refresh-a", new Date()),
    bodies,
    release,
    releaseNext(text = "ok") {
      const resolve = pending.shift();
      if (!resolve) throw new Error("no model call is waiting");
      resolve(api === "openai-responses" ? responsesStop(text) : chatStop(text));
    },
  };
}

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  closers.push(() => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  return listening.promise.then(() => (server.address() as AddressInfo).port);
}

function cookie(token: string): string {
  return `vb_session=${token}`;
}

async function createBot(app: FastifyInstance, session: { token: string; csrf: string }): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/bots",
    headers: { cookie: cookie(session.token), "x-vb-csrf": session.csrf, "content-type": "application/json" },
    payload: { name: "Ada", model: "gpt-test", instructions: "" },
  });
  expect(created.statusCode).toBe(201);
  return created.json().bot.id as string;
}

async function uploadFile(app: FastifyInstance, session: { token: string; csrf: string }, filename: string, content: Buffer): Promise<{ id: string }> {
  const boundary = "vblive";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: {
      cookie: cookie(session.token),
      "x-vb-csrf": session.csrf,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  expect(created.statusCode).toBe(201);
  return created.json().upload as { id: string };
}

function send(
  app: FastifyInstance,
  session: { token: string; csrf: string },
  botId: string,
  text: string,
  uploadIds: string[],
  mode: "queue" | "steer",
) {
  return app.inject({
    method: "POST",
    url: `/api/bots/${botId}/messages`,
    headers: { cookie: cookie(session.token), "x-vb-csrf": session.csrf, "content-type": "application/json" },
    payload: { text, uploadIds, mode },
  });
}

function postMessage(
  app: FastifyInstance,
  session: { token: string; csrf: string },
  botId: string,
  text: string,
  options?: { uploadIds?: string[]; mode?: "queue" | "steer" },
) {
  return app.inject({
    method: "POST",
    url: `/api/bots/${botId}/messages`,
    headers: { cookie: cookie(session.token), "x-vb-csrf": session.csrf, "content-type": "application/json" },
    payload: {
      text,
      ...(options?.uploadIds && options.uploadIds.length > 0 ? { uploadIds: options.uploadIds } : {}),
      ...(options?.mode ? { mode: options.mode } : {}),
    },
  });
}

async function holdFollowUp(text: string): Promise<{
  harness: Awaited<ReturnType<typeof boot>>;
  botId: string;
  conversationId: string;
  followed: ReturnType<typeof send>;
  releaseUpload: () => void;
}> {
  let releaseUpload: () => void = () => {};
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let arrived = false;
  const machine = await createMachine({
    hold: () => {
      arrived = true;
      return uploadGate;
    },
  });
  const harness = await boot(machine, "openai-completions");
  const botId = await createBot(harness.app, harness.alice);
  const opened = await send(harness.app, harness.alice, botId, "look", [], "queue");
  expect(opened.statusCode).toBe(202);
  const openedBody = opened.json() as { taskId: string; conversationId: string };
  await waitFor(() => harness.bodies.length === 1);
  const notes = await uploadFile(harness.app, harness.alice, "notes.txt", Buffer.from("queued-bytes"));
  const followed = send(harness.app, harness.alice, botId, text, [notes.id], "queue");
  await waitFor(() => arrived);
  harness.releaseNext();
  await waitFor(() => textCell(harness.db.$client.prepare("select state from tasks where id=?").get(openedBody.taskId), "state") === "succeeded");
  return { harness, botId, conversationId: openedBody.conversationId, followed, releaseUpload };
}

function remotePath(db: { $client: { prepare: (sql: string) => { get: (id: string) => unknown } } }, messageId: string, name: string): string {
  const row = db.$client.prepare("select content_json as contentJson from messages where id=?").get(messageId);
  let directory = messageId;
  if (typeof row === "object" && row !== null && "contentJson" in row && typeof row.contentJson === "string") {
    const parsed = JSON.parse(row.contentJson) as { attachments?: Array<{ name?: string; place?: string }> };
    const place = parsed.attachments?.find((item) => item.name === name)?.place;
    if (place) directory = place;
  }
  return `/home/bot/uploads/${directory}/${name}`;
}

function modelTexts(body: string): string[] {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("messages" in parsed) || !Array.isArray(parsed.messages)) return [];
  return parsed.messages.map((message: unknown) => {
    if (typeof message !== "object" || message === null || !("content" in message)) return "";
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((block: unknown) => {
      if (typeof block !== "object" || block === null || !("text" in block) || typeof block.text !== "string") return "";
      return block.text;
    }).join("");
  });
}

async function history(
  harness: { app: FastifyInstance; alice: { token: string } },
  conversationId: string,
): Promise<Array<{ id: string; text: string; createdAt: string }>> {
  const listed = await harness.app.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/messages`,
    headers: { cookie: cookie(harness.alice.token) },
  });
  expect(listed.statusCode).toBe(200);
  return listed.json().messages as Array<{ id: string; text: string; createdAt: string }>;
}

async function finished(harness: { app: FastifyInstance; alice: { token: string } }, taskId: string): Promise<{ state: string; error: string | null }> {
  await chatService(harness.app).idle();
  const response = await harness.app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}`,
    headers: { cookie: cookie(harness.alice.token) },
  });
  return response.json().task as { state: string; error: string | null };
}

function textCell(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

async function waitFor(ready: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function toolSse(name: string, args: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function chatStop(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
}

function responsesStop(text: string): string {
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
}
