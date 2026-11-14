import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import type { ControlConfig } from "../config.js";
import { decrypt } from "../crypto.js";
import { botRepository, type BotRecord } from "../db/bots.js";
import { chatRepository, type ConversationRecord, type StepRecord } from "../db/chat.js";
import { credentialRepository } from "../db/credentials.js";
import type { AppDatabase } from "../db/index.js";
import { quotaRepository } from "../db/quotas.js";
import { settingsRepository } from "../db/settings.js";
import { ulid } from "../id.js";
import { MachinedClient } from "../machines/client.js";
import type { MachineEndpoint } from "@viate-bot/protocol";
import { buildSystemPrompt, compactMessages, statusBlock } from "./prompt.js";
import type { ChatHub } from "./events.js";
import { getToolHooks } from "./hooks.js";
import { machineTools } from "./tools.js";
import { assistantText, loadTranscript, messageView, stepView, storedContent, taskView } from "./view.js";
import { buildModel, type GatewayTask } from "../gateway/stream.js";
import { userScope, type UserScope } from "../scope.js";

const INTERRUPTED_TOOL = "执行被中断，结果未知";
const TEXT_LIMIT = 32_000;

export class ChatError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export interface SendInput {
  userId: string;
  botId: string;
  text: string;
  mode: "queue" | "steer";
  conversationId?: string;
}

export interface SendResult {
  conversationId: string;
  taskId: string;
  messageId: string;
}

export interface ChatServiceDeps {
  db: AppDatabase;
  config: ControlConfig;
  key: Buffer;
  hub: ChatHub;
  streamFn: Agent["streamFn"];
  tasks: Map<string, GatewayTask>;
  prepareEndpoint: (userId: string, onPhase: (phase: "starting" | "ready") => void) => Promise<MachineEndpoint>;
  now?: () => Date;
  fetch?: typeof fetch;
}

interface QueuedTask {
  id: string;
  botId: string;
  userId: string;
  conversationId: string;
}

interface Live extends QueuedTask {
  agent?: Agent;
  stopRequested: boolean;
  loaded: boolean;
  done: Promise<void>;
}

export function recoverInterruptedTasks(db: AppDatabase, now = new Date()): number {
  const chat = chatRepository(db);
  let count = 0;
  for (const meta of chat.systemTaskMeta(["running"])) {
    const scope = userScope(meta.userId);
    if (meta.conversationId) {
      const rows = chat.listMessages(scope, meta.conversationId) ?? [];
      const transcript = loadTranscript(rows);
      const answered = new Set(
        transcript.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
      );
      const last = transcript[transcript.length - 1];
      if (last?.role === "assistant") {
        for (const block of last.content) {
          if (block.type !== "toolCall" || answered.has(block.id)) continue;
          const toolResult: ToolResultMessage = {
            role: "toolResult",
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: "text", text: INTERRUPTED_TOOL }],
            isError: true,
            timestamp: now.getTime(),
          };
          chat.insertMessage(scope, {
            id: ulid(),
            conversationId: meta.conversationId,
            role: "toolResult",
            contentJson: storedContent(toolResult, INTERRUPTED_TOOL),
            taskId: meta.id,
          });
        }
      }
      for (const step of chat.listSteps(scope, meta.id) ?? []) {
        if (step.kind === "tool" && step.status === "running") {
          chat.finishStep(scope, step.id, {
            status: "interrupted",
            responseJson: JSON.stringify({ text: INTERRUPTED_TOOL }),
          });
        }
      }
    }
    chat.updateTask(scope, meta.id, { state: "interrupted", endedAt: now.toISOString(), error: null });
    count += 1;
  }
  return count;
}

export function createChatService(deps: ChatServiceDeps) {
  const chat = chatRepository(deps.db);
  const now = deps.now ?? (() => new Date());
  const queue: QueuedTask[] = [];
  const ring: string[] = [];
  const running = new Map<string, Live>();
  const liveByBot = new Map<string, Live>();
  const tails = new Map<string, Promise<void>>();
  const saved = new WeakSet<object>();
  let lastStarted: string | undefined;
  let pumping = false;
  let pumpAgain = false;

  recoverInterruptedTasks(deps.db, now());
  for (const meta of chat.systemTaskMeta(["queued"])) {
    if (!meta.conversationId) continue;
    queue.push({
      id: meta.id,
      botId: meta.botId,
      userId: meta.userId,
      conversationId: meta.conversationId,
    });
    remember(meta.userId);
  }
  pump();

  return {
    send(input: SendInput): Promise<SendResult> {
      return exclusive(input.botId, () => sendLocked(input));
    },
    stop(scope: UserScope, taskId: string): boolean {
      const task = chat.findTask(scope, taskId);
      if (!task) return false;
      const live = running.get(taskId);
      if (live) {
        live.stopRequested = true;
        live.agent?.abort();
        return true;
      }
      if (task.state !== "queued") return false;
      const index = queue.findIndex((item) => item.id === taskId);
      if (index >= 0) queue.splice(index, 1);
      chat.updateTask(scope, taskId, { state: "cancelled", endedAt: now().toISOString(), error: null });
      forgetIfIdle(task.botId ? scope.userId : scope.userId);
      publishTask(scope.userId, task.conversationId, taskId);
      return true;
    },
    async cancelBot(scope: UserScope, botId: string): Promise<void> {
      const live = liveByBot.get(botId);
      if (live && live.userId === scope.userId) {
        live.stopRequested = true;
        live.agent?.abort();
        await live.done;
      }
      const queued = chat.findActiveByBot(scope, botId, "queued");
      if (queued) this.stop(scope, queued.id);
    },
    /** 等正在跑的任务结束。排队但因名额开不了工的会留下。 */
    async idle(): Promise<void> {
      while (running.size > 0) {
        await Promise.race([...running.values()].map((live) => live.done));
      }
    },
    shutdown(): void {
      for (const live of running.values()) live.agent?.abort();
    },
  };

  async function sendLocked(input: SendInput): Promise<SendResult> {
    const text = input.text.trim();
    if (text.length === 0) throw new ChatError("消息不能为空", 400);
    if (text.length > TEXT_LIMIT) throw new ChatError("消息太长", 400);
    const scope = userScope(input.userId);
    const bot = botRepository(deps.db).findById(scope, input.botId);
    if (!bot) throw new ChatError("找不到 bot", 404);
    const conversation = resolveConversation(scope, bot, input.conversationId, text);
    const live = liveByBot.get(bot.id);
    if (live && live.conversationId !== conversation.id) {
      throw new ChatError("这个 bot 还有未完成的任务", 409);
    }
    const message = userMessage(text, now());
    if (live?.agent?.state.isStreaming) {
      const row = persistUser(scope, conversation.id, message, live.id);
      saved.add(message);
      if (input.mode === "steer") live.agent.steer(message);
      else live.agent.followUp(message);
      return { conversationId: conversation.id, taskId: live.id, messageId: row.id };
    }
    if (live && !live.loaded) {
      const row = persistUser(scope, conversation.id, message, live.id);
      saved.add(message);
      return { conversationId: conversation.id, taskId: live.id, messageId: row.id };
    }
    if (live) await live.done;
    const pending = chat.findActiveByBot(scope, bot.id, "queued");
    if (pending && pending.conversationId && pending.conversationId !== conversation.id) {
      throw new ChatError("这个 bot 还有未完成的任务", 409);
    }
    if (pending) {
      const row = persistUser(scope, conversation.id, message, pending.id);
      saved.add(message);
      return { conversationId: conversation.id, taskId: pending.id, messageId: row.id };
    }
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new ChatError("找不到 bot", 404);
    const row = persistUser(scope, conversation.id, message, task.id);
    saved.add(message);
    queue.push({ id: task.id, botId: bot.id, userId: input.userId, conversationId: conversation.id });
    remember(input.userId);
    publishTask(input.userId, conversation.id, task.id);
    pump();
    return { conversationId: conversation.id, taskId: task.id, messageId: row.id };
  }

  function persistUser(scope: UserScope, conversationId: string, message: UserMessage, taskId: string | null) {
    const row = chat.insertMessage(scope, {
      id: ulid(),
      conversationId,
      role: "user",
      contentJson: storedContent(message, typeof message.content === "string" ? message.content : ""),
      taskId,
    });
    if (!row) throw new ChatError("找不到对话", 404);
    chat.touchConversation(scope, conversationId);
    publishMessage(conversationId, row.id, scope);
    return row;
  }

  function resolveConversation(scope: UserScope, bot: BotRecord, conversationId: string | undefined, text: string): ConversationRecord {
    if (conversationId) {
      const found = chat.findConversation(scope, conversationId);
      if (!found || found.botId !== bot.id) throw new ChatError("找不到对话", 404);
      return found;
    }
    const existing = chat.listConversations(scope, bot.id) ?? [];
    const latest = existing[0];
    if (latest) return latest;
    const created = chat.insertConversation(scope, { id: ulid(), botId: bot.id, title: titleOf(text) });
    if (!created) throw new ChatError("找不到 bot", 404);
    return created;
  }

  function pump(): void {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      while (running.size < deps.config.maxRunningTasks && queue.length > 0 && ring.length > 0) {
        if (!pick()) break;
      }
    } finally {
      pumping = false;
      if (pumpAgain) {
        pumpAgain = false;
        pump();
      }
    }
  }

  function pick(): boolean {
    if (ring.length === 0) return false;
    const previous = lastStarted ? ring.indexOf(lastStarted) : -1;
    const start = previous >= 0 ? (previous + 1) % ring.length : 0;
    for (let offset = 0; offset < ring.length; offset += 1) {
      const index = (start + offset) % ring.length;
      const userId = ring[index];
      if (!userId) continue;
      const used = [...running.values()].filter((live) => live.userId === userId).length;
      if (used >= userLimit(userId)) continue;
      const taskIndex = queue.findIndex((item) => item.userId === userId && !liveByBot.has(item.botId));
      if (taskIndex < 0) continue;
      const [task] = queue.splice(taskIndex, 1);
      if (!task) continue;
      lastStarted = userId;
      begin(task);
      return true;
    }
    return false;
  }

  function begin(task: QueuedTask): void {
    const live: Live = { ...task, stopRequested: false, loaded: false, done: Promise.resolve() };
    running.set(task.id, live);
    liveByBot.set(task.botId, live);
    live.done = execute(live);
  }

  async function execute(live: Live): Promise<void> {
    const scope = userScope(live.userId);
    let seq = 0;
    const openSteps = new Map<string, string>();
    try {
      chat.updateTask(scope, live.id, { state: "running", startedAt: now().toISOString(), error: null });
      publishTask(live.userId, live.conversationId, live.id);
      const endpoint = await deps.prepareEndpoint(live.userId, (phase) => {
        deps.hub.publish(live.conversationId, { type: "machine", conversationId: live.conversationId, phase });
      });
      if (live.stopRequested) {
        finish(scope, live, "cancelled", null, seq);
        return;
      }
      const bot = botRepository(deps.db).findById(scope, live.botId);
      if (!bot) throw new ChatError("找不到 bot", 404);
      const secret = secretFor(bot);
      const gatewayTask: GatewayTask = {
        taskId: live.id,
        botId: live.botId,
        userId: live.userId,
        secret,
        tokensUsed: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelCalls: 0,
        startedAt: now().getTime(),
      };
      deps.tasks.set(live.id, gatewayTask);
      const platform = settingsRepository(deps.db).platformPrompt().text;
      const transcript = loadTranscript(chat.listMessages(scope, live.conversationId) ?? []);
      const agent = new Agent({
        initialState: {
          systemPrompt: buildSystemPrompt(platform, bot.instructions, statusBlock(now(), "运行中")),
          model: buildModel(deps.config, bot.model),
          tools: machineTools(new MachinedClient(endpoint, deps.fetch ?? fetch)),
          messages: transcript,
        },
        streamFn: deps.streamFn,
        transformContext: async (messages) =>
          compactMessages(messages, Math.floor(deps.config.modelContextTokens * 0.6)),
        beforeToolCall: async (context, signal) => getToolHooks().beforeToolCall?.(context, signal),
        afterToolCall: async (context, signal) => getToolHooks().afterToolCall?.(context, signal),
        sessionId: live.id,
        toolExecution: "sequential",
        steeringMode: "all",
        followUpMode: "all",
      });
      seq = chat.maxSeq(scope, live.id);
      agent.subscribe((event) => {
        try {
          seq = onAgentEvent(live, scope, event, seq, openSteps);
        } catch (error) {
          console.error("任务事件写入失败", error instanceof Error ? error.message : "unknown");
        }
      });
      live.agent = agent;
      live.loaded = true;
      const pending = agent.continue();
      await pending;
      const last = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
      const usage = usageJson(gatewayTask);
      if (live.stopRequested || (last && last.stopReason === "aborted")) {
        finish(scope, live, "cancelled", null, seq, usage);
      } else if (last && last.stopReason === "error") {
        finish(scope, live, "failed", last.errorMessage ?? "模型请求失败", seq, usage);
      } else {
        finish(scope, live, "succeeded", null, seq, usage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务失败";
      finish(scope, live, "failed", message, seq);
    } finally {
      deps.tasks.delete(live.id);
      running.delete(live.id);
      if (liveByBot.get(live.botId) === live) liveByBot.delete(live.botId);
      publishTask(live.userId, live.conversationId, live.id);
      forgetIfIdle(live.userId);
      pump();
    }
  }

  function onAgentEvent(live: Live, scope: UserScope, event: AgentEvent, seq: number, openSteps: Map<string, string>): number {
    if (event.type === "message_update" && event.message.role === "assistant") {
      deps.hub.publish(live.conversationId, {
        type: "delta",
        conversationId: live.conversationId,
        taskId: live.id,
        text: assistantText(event.message),
      });
      return seq;
    }
    if (event.type === "message_end") {
      if (saved.has(event.message)) return seq;
      saved.add(event.message);
      const text = textOf(event.message);
      const row = chat.insertMessage(scope, {
        id: ulid(),
        conversationId: live.conversationId,
        role: event.message.role,
        contentJson: storedContent(event.message as UserMessage | AssistantMessage | ToolResultMessage, text),
        taskId: live.id,
      });
      if (row) publishMessage(live.conversationId, row.id, scope);
      if (event.message.role === "assistant") {
        seq += 1;
        const step = chat.insertStep(scope, {
          id: ulid(),
          taskId: live.id,
          seq,
          kind: "model",
          status: event.message.stopReason === "error" ? "failed" : "succeeded",
          requestJson: JSON.stringify({
            text,
            toolCalls: event.message.content.filter((block) => block.type === "toolCall").map((block) => ({
              id: block.id,
              name: block.name,
            })),
          }),
        });
        if (step) {
          const status = step.status;
          chat.finishStep(scope, step.id, { status, responseJson: JSON.stringify({ text }) });
          publishStep(live.conversationId, { ...step, status, responseJson: JSON.stringify({ text }), endedAt: now().toISOString() });
        }
      }
      return seq;
    }
    if (event.type === "tool_execution_start") {
      seq += 1;
      const step = chat.insertStep(scope, {
        id: ulid(),
        taskId: live.id,
        seq,
        kind: "tool",
        status: "running",
        requestJson: JSON.stringify({ name: event.toolName, args: event.args, toolCallId: event.toolCallId }),
      });
      if (step) {
        openSteps.set(event.toolCallId, step.id);
        publishStep(live.conversationId, step);
      }
      return seq;
    }
    if (event.type === "tool_execution_end") {
      const stepId = openSteps.get(event.toolCallId);
      if (!stepId) return seq;
      const text = toolText(event.result);
      const status = event.isError ? "failed" : "succeeded";
      const responseJson = JSON.stringify({ text, isError: event.isError });
      chat.finishStep(scope, stepId, { status, responseJson });
      const current = chat.listSteps(scope, live.id)?.find((step) => step.id === stepId);
      if (current) publishStep(live.conversationId, current);
    }
    return seq;
  }

  function finish(
    scope: UserScope,
    live: Live,
    state: string,
    error: string | null,
    stepCount: number,
    usage?: string,
  ): void {
    chat.updateTask(scope, live.id, {
      state,
      error,
      endedAt: now().toISOString(),
      stepCount,
      ...(usage !== undefined ? { usageJson: usage } : {}),
    });
  }

  function secretFor(bot: BotRecord): string {
    if (!bot.modelCredentialId) throw new ChatError("没有可用的模型凭据", 500);
    const row = credentialRepository(deps.db).takeForGateway(bot.userId, bot.modelCredentialId);
    if (!row) throw new ChatError("没有可用的模型凭据", 500);
    return decrypt(deps.key, row.secretEnc);
  }

  function userLimit(userId: string): number {
    return quotaRepository(deps.db).find(userScope(userId))?.maxConcurrentTasks ?? deps.config.defaultMaxConcurrentTasks;
  }

  function remember(userId: string): void {
    if (!ring.includes(userId)) ring.push(userId);
  }

  function forgetIfIdle(userId: string): void {
    const busy = queue.some((item) => item.userId === userId) || [...running.values()].some((live) => live.userId === userId);
    if (busy) return;
    const index = ring.indexOf(userId);
    if (index < 0) return;
    ring.splice(index, 1);
    if (lastStarted === userId) lastStarted = ring[index - 1] ?? ring[ring.length - 1];
  }

  function publishMessage(conversationId: string, messageId: string, scope: UserScope): void {
    const row = chat.findMessage(scope, messageId);
    if (!row) return;
    deps.hub.publish(conversationId, { type: "message", conversationId, message: messageView(row) });
  }

  function publishTask(userId: string, conversationId: string | null, taskId: string): void {
    if (!conversationId) return;
    const row = chat.findTask(userScope(userId), taskId);
    if (!row) return;
    deps.hub.publish(conversationId, { type: "task", conversationId, task: taskView(row) });
  }

  function publishStep(conversationId: string, step: StepRecord): void {
    deps.hub.publish(conversationId, { type: "step", conversationId, step: stepView(step) });
  }

  function exclusive<T>(botId: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = tails.get(botId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    tails.set(
      botId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

function userMessage(text: string, now: Date): UserMessage {
  return { role: "user", content: text, timestamp: now.getTime() };
}

function titleOf(text: string): string {
  const line = text.trim().replace(/\s+/g, " ");
  if (line.length === 0) return "新对话";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

function textOf(message: AgentMessage): string {
  if (message.role === "assistant") return assistantText(message);
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("");
}

function usageJson(task: GatewayTask): string {
  return JSON.stringify({
    inputTokens: task.inputTokens,
    outputTokens: task.outputTokens,
    cacheReadTokens: task.cacheReadTokens,
    cacheWriteTokens: task.cacheWriteTokens,
    totalTokens: task.tokensUsed,
  });
}

export type ChatService = ReturnType<typeof createChatService>;
