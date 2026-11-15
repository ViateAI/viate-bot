import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ControlConfig } from "../config.js";
import { decrypt } from "../crypto.js";
import { botRepository, type BotRecord } from "../db/bots.js";
import { chatRepository, type ConversationRecord, type StepRecord } from "../db/chat.js";
import { credentialRepository } from "../db/credentials.js";
import type { AppDatabase } from "../db/index.js";
import { memoryRepository } from "../db/memories.js";
import { quotaRepository } from "../db/quotas.js";
import { settingsRepository } from "../db/settings.js";
import { ulid } from "../id.js";
import { MachinedClient } from "../machines/client.js";
import type { MachineEndpoint } from "@viate-bot/protocol";
import { BrowserPool } from "./browser-session.js";
import { browserScreenshotTool, browserTools } from "./browser-tools.js";
import { memoryTools } from "./memory-tools.js";
import { applyCompaction, COMPACT_STEP_LABEL, relayWithOverflowRetry } from "./compact.js";
import { buildSystemPrompt, formatMemorySection, latestUserText, statusBlock } from "./prompt.js";
import type { ChatHub } from "./events.js";
import { getToolHooks } from "./hooks.js";
import {
  bindSecrets,
  createSecretBroker,
  createSecretTool,
  maskToolContent,
  parseSecretRequest,
  SecretError,
  type SecretRequest,
  type SecretSubmission,
} from "./secrets.js";
import { maskDeep, maskSecrets } from "./text.js";
import { machineTools } from "./tools.js";
import { assistantText, loadTranscript, loadTranscriptEntries, messageView, stepView, storedContent, taskView, withoutImages } from "./view.js";
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
  streamFn: StreamFn;
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
  waitingInput: boolean;
  preserveWait: boolean;
  failReason?: string;
}

export function recoverInterruptedTasks(db: AppDatabase, now = new Date()): number {
  const chat = chatRepository(db);
  let count = 0;
  for (const meta of chat.systemTaskMeta(["running"])) {
    const scope = userScope(meta.userId);
    if (meta.conversationId) {
      const rows = chat.listContextMessages(scope, meta.conversationId) ?? [];
      const transcript = loadTranscript(rows.filter((row) => row.taskId === meta.id));
      const answered = new Set(
        transcript.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
      );
      const last = transcript.findLast((message) => message.role === "assistant");
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
  const messageIds = new WeakMap<object, string>();
  const browsers = new BrowserPool();
  const broker = createSecretBroker({
    db: deps.db,
    key: deps.key,
    waitMs: deps.config.secretWaitMs,
    now,
    onWaiting: markWaiting,
    onRunning: markRunning,
    onResume: resumeWaiting,
    onFail: failWaiting,
  });
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
  broker.arm(chat.systemWaiting());
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
        if (live.waitingInput) broker.settle(taskId, "stopped");
        else live.agent?.abort();
        return true;
      }
      if (task.state === "waiting_input") {
        cancelWaiting(scope, task);
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
        this.stop(scope, live.id);
        await live.done;
      }
      const queued = chat.findActiveByBot(scope, botId, "queued");
      if (queued) this.stop(scope, queued.id);
      const waiting = chat.findActiveByBot(scope, botId, "waiting_input");
      if (waiting) this.stop(scope, waiting.id);
    },
    /** 等正在跑的任务结束。排队但因名额开不了工的会留下。 */
    async idle(): Promise<void> {
      while (running.size > 0) {
        await Promise.race([...running.values()].map((live) => live.done));
      }
    },
    submitSecret(scope: UserScope, taskId: string, body: SecretSubmission): void {
      const task = chat.findTask(scope, taskId);
      if (!task || task.state !== "waiting_input") throw new ChatError("找不到任务", 404);
      const request = pendingRequest(scope, taskId);
      if (!request) throw new ChatError("找不到任务", 404);
      try {
        broker.submit(scope, taskId, request, body);
      } catch (error) {
        if (error instanceof SecretError) throw new ChatError(error.message, error.statusCode);
        throw error;
      }
    },
    shutdown(): void {
      for (const live of running.values()) {
        if (live.waitingInput) {
          live.preserveWait = true;
          broker.settle(live.id, "detached");
        } else {
          live.agent?.abort();
        }
      }
      broker.close();
      void browsers.close();
    },
  };

  async function sendLocked(input: SendInput): Promise<SendResult> {
    const text = input.text.trim();
    if (text.length === 0) throw new ChatError("消息不能为空", 400);
    if (text.length > TEXT_LIMIT) throw new ChatError("消息太长", 400);
    const scope = userScope(input.userId);
    const bot = botRepository(deps.db).findById(scope, input.botId);
    if (!bot) throw new ChatError("找不到 bot", 404);
    if (!quotaRepository(deps.db).find(scope)) throw new ChatError("尚未开通，请联系管理员", 403);
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
    const waiting = chat.findActiveByBot(scope, bot.id, "waiting_input");
    if (waiting) throw new ChatError("正在等待输入", 409);
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
    messageIds.set(message, row.id);
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
    const live: Live = {
      ...task,
      stopRequested: false,
      loaded: false,
      done: Promise.resolve(),
      waitingInput: false,
      preserveWait: false,
    };
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
      const loaded = loadTranscriptEntries(chat.listContextMessages(scope, live.conversationId) ?? []);
      for (const entry of loaded) messageIds.set(entry.message, entry.id);
      const transcript = loaded.map((entry) => entry.message);
      const memoryStore = memoryRepository(deps.db);
      const query = latestUserText(transcript);
      const recent = memoryStore.recent(scope, bot.id, 10) ?? [];
      const matched = query ? (memoryStore.search(scope, bot.id, query, 5) ?? []) : [];
      const bound = browsers.bind(live.userId, live.botId, endpoint);
      const secretTool = createSecretTool(async (request) => {
        live.waitingInput = true;
        try {
          const outcome = await broker.wait(live.userId, live.id, request);
          if (outcome === "timeout") live.failReason = "等待用户输入超时";
          return outcome;
        } finally {
          live.waitingInput = false;
        }
      });
      const rawTools = [
        ...machineTools(new MachinedClient(endpoint, deps.fetch ?? fetch)),
        ...browserTools(bound),
        ...(deps.config.visionModels.includes(bot.model) ? [browserScreenshotTool(bound)] : []),
        secretTool,
        ...memoryTools({
          knownSecrets: () => broker.known(live.userId, live.id),
          save: (content) => memoryStore.save(scope, bot.id, { id: ulid(), content, sourceTaskId: live.id }),
          search: (text) => memoryStore.search(scope, bot.id, text, 5) ?? [],
          remove: (id) => memoryStore.remove(scope, bot.id, id) ?? false,
        }),
      ];
      seq = chat.maxSeq(scope, live.id);
      const model = buildModel(deps.config, bot.model);
      const compactLive = (next: AgentMessage[], force: boolean, signal?: AbortSignal) =>
        applyCompaction(
          next,
          {
            contextTokens: deps.config.modelContextTokens,
            summaryMaxTokens: deps.config.summaryMaxTokens,
            sessionId: live.id,
            model,
            stream: deps.streamFn,
            secrets: () => broker.known(live.userId, live.id),
            readSummary: () => chat.readSummary(scope, live.conversationId),
            saveSummary: (text, untilMessageId) => {
              chat.saveSummary(scope, live.conversationId, text, untilMessageId);
            },
            idOf: (message) => messageIds.get(message),
            canSummarize: (ids, untilId) => chat.canSummarize(scope, live.conversationId, ids, untilId),
            onCompacted: () => {
              seq += 1;
              const step = chat.insertStep(scope, {
                id: ulid(),
                taskId: live.id,
                seq,
                kind: "compact",
                status: "succeeded",
                requestJson: JSON.stringify({ text: COMPACT_STEP_LABEL }),
              });
              if (!step) return;
              chat.finishStep(scope, step.id, {
                status: "succeeded",
                responseJson: JSON.stringify({ text: COMPACT_STEP_LABEL }),
              });
              const current = chat.listSteps(scope, live.id)?.find((item) => item.id === step.id);
              if (current) publishStep(live.conversationId, current);
            },
            beginSummary: () => {
              gatewayTask.skipStep = true;
            },
            endSummary: () => {
              gatewayTask.skipStep = false;
            },
          },
          { force, ...(signal ? { signal } : {}) },
        );
      const agent = new Agent({
        initialState: {
          systemPrompt: buildSystemPrompt(
            platform,
            bot.instructions,
            formatMemorySection(recent, matched),
            statusBlock(now(), "运行中", broker.names(live.userId)),
          ),
          model,
          tools: bindSecrets(rawTools, (name) => broker.lookup(live.userId, live.id, name)),
          messages: transcript,
        },
        streamFn: relayWithOverflowRetry(deps.streamFn, deps.config.modelContextTokens, (next, overflowSignal) =>
          compactLive(next, true, overflowSignal),
        ),
        transformContext: (next, signal) => compactLive(next, false, signal),
        beforeToolCall: async (context, signal) => getToolHooks().beforeToolCall?.(context, signal),
        afterToolCall: async (context, signal) => {
          const hooked = await getToolHooks().afterToolCall?.(context, signal);
          const content = hooked?.content ?? context.result.content;
          const details = hooked?.details !== undefined ? hooked.details : context.result.details;
          const secrets = broker.known(live.userId, live.id);
          return {
            content: maskToolContent(content, secrets),
            details: maskDetails(details, secrets),
            ...(hooked?.isError !== undefined ? { isError: hooked.isError } : {}),
            ...(hooked?.terminate !== undefined ? { terminate: hooked.terminate } : context.result.terminate ? { terminate: true } : {}),
          };
        },
        sessionId: live.id,
        toolExecution: "sequential",
        steeringMode: "all",
        followUpMode: "all",
      });
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
      if (live.failReason) {
        finish(scope, live, "failed", live.failReason, seq, usage);
      } else if (live.stopRequested || (last && last.stopReason === "aborted")) {
        finish(scope, live, "cancelled", null, seq, usage);
      } else if (last && last.stopReason === "error") {
        finish(scope, live, "failed", last.errorMessage ?? "模型请求失败", seq, usage);
      } else {
        finish(scope, live, "succeeded", null, seq, usage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务失败";
      finish(scope, live, "failed", live.failReason ?? message, seq);
    } finally {
      deps.tasks.delete(live.id);
      running.delete(live.id);
      if (liveByBot.get(live.botId) === live) liveByBot.delete(live.botId);
      if (!live.preserveWait) broker.drop(live.id);
      publishTask(live.userId, live.conversationId, live.id);
      forgetIfIdle(live.userId);
      pump();
    }
  }

  function onAgentEvent(live: Live, scope: UserScope, event: AgentEvent, seq: number, openSteps: Map<string, string>): number {
    if (live.preserveWait) return seq;
    const veil = (text: string) => maskSecrets(text, broker.known(live.userId, live.id));
    const json = (value: unknown) => JSON.stringify(maskDeep(value, broker.known(live.userId, live.id)));
    if (event.type === "message_update" && event.message.role === "assistant") {
      deps.hub.publish(live.conversationId, {
        type: "delta",
        conversationId: live.conversationId,
        taskId: live.id,
        text: veil(assistantText(event.message)),
      });
      return seq;
    }
    if (event.type === "message_end") {
      // 系统消息是当次运行的提示词和工具声明，下次启动会按 bot 重新生成，不写入对话。
      if (event.message.role === "system") return seq;
      if (saved.has(event.message)) return seq;
      saved.add(event.message);
      const source = event.message.role === "toolResult" ? withoutImages(event.message) : event.message;
      const text = veil(textOf(source));
      const row = chat.insertMessage(scope, {
        id: ulid(),
        conversationId: live.conversationId,
        role: source.role,
        contentJson: storedContent(maskDeep(source, broker.known(live.userId, live.id)), text),
        taskId: live.id,
      });
      if (row) {
        messageIds.set(event.message, row.id);
        if (source !== event.message) messageIds.set(source, row.id);
        publishMessage(live.conversationId, row.id, scope);
      }
      if (event.message.role === "assistant") {
        seq += 1;
        const step = chat.insertStep(scope, {
          id: ulid(),
          taskId: live.id,
          seq,
          kind: "model",
          status: event.message.stopReason === "error" ? "failed" : "succeeded",
          requestJson: json({
            text,
            toolCalls: event.message.content.filter((block) => block.type === "toolCall").map((block) => ({
              id: block.id,
              name: block.name,
            })),
          }),
        });
        if (step) {
          const status = step.status;
          const responseJson = json({ text });
          chat.finishStep(scope, step.id, { status, responseJson });
          publishStep(live.conversationId, { ...step, status, responseJson, endedAt: now().toISOString() });
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
        requestJson: json({ name: event.toolName, args: event.args, toolCallId: event.toolCallId }),
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
      const text = veil(toolText(event.result));
      const status = event.isError ? "failed" : "succeeded";
      const responseJson = json({ text, isError: event.isError });
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
    if (live.preserveWait) return;
    chat.updateTask(scope, live.id, {
      state,
      error,
      endedAt: now().toISOString(),
      stepCount,
      ...(usage !== undefined ? { usageJson: usage } : {}),
    });
  }

  function markWaiting(userId: string, taskId: string): void {
    chat.updateTask(userScope(userId), taskId, { state: "waiting_input", error: null });
    const task = chat.findTask(userScope(userId), taskId);
    if (task?.conversationId) publishTask(userId, task.conversationId, taskId);
  }

  function markRunning(userId: string, taskId: string): void {
    chat.updateTask(userScope(userId), taskId, { state: "running", error: null });
    const task = chat.findTask(userScope(userId), taskId);
    if (task?.conversationId) publishTask(userId, task.conversationId, taskId);
  }

  function resumeWaiting(userId: string, taskId: string, text: string, isError: boolean): void {
    const scope = userScope(userId);
    const task = chat.findTask(scope, taskId);
    if (!task || task.state !== "waiting_input" || !task.conversationId) return;
    appendSecretResult(scope, task.conversationId, taskId, text, isError);
    chat.updateTask(scope, taskId, { state: "queued", error: null, endedAt: null });
    queue.push({ id: taskId, botId: task.botId, userId, conversationId: task.conversationId });
    remember(userId);
    publishTask(userId, task.conversationId, taskId);
    pump();
  }

  function failWaiting(userId: string, taskId: string, error: string): void {
    const scope = userScope(userId);
    const task = chat.findTask(scope, taskId);
    if (!task || task.state !== "waiting_input" || !task.conversationId) return;
    appendSecretResult(scope, task.conversationId, taskId, error, true);
    chat.updateTask(scope, taskId, { state: "failed", error, endedAt: now().toISOString() });
    publishTask(userId, task.conversationId, taskId);
  }

  function cancelWaiting(scope: UserScope, task: { id: string; conversationId: string | null }): void {
    if (task.conversationId) appendSecretResult(scope, task.conversationId, task.id, "用户停止了任务", true);
    chat.updateTask(scope, task.id, { state: "cancelled", error: null, endedAt: now().toISOString() });
    if (task.conversationId) publishTask(scope.userId, task.conversationId, task.id);
  }

  function appendSecretResult(scope: UserScope, conversationId: string, taskId: string, text: string, isError: boolean): void {
    const steps = chat.listSteps(scope, taskId) ?? [];
    const step = [...steps].reverse().find((item) => item.kind === "tool" && item.status === "running");
    const request = step ? parseJson(step.requestJson) : undefined;
    const toolCallId = request?.toolCallId ?? "call_secret";
    const veiled = maskSecrets(text, broker.known(scope.userId, taskId));
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId,
      toolName: "request_secret",
      content: [{ type: "text", text: veiled }],
      isError,
      timestamp: now().getTime(),
    };
    chat.insertMessage(scope, {
      id: ulid(),
      conversationId,
      role: "toolResult",
      contentJson: storedContent(toolResult, veiled),
      taskId,
    });
    if (step) {
      chat.finishStep(scope, step.id, {
        status: isError ? "failed" : "succeeded",
        responseJson: JSON.stringify({ text: veiled, isError }),
      });
    }
    publishTask(scope.userId, conversationId, taskId);
  }

  function pendingRequest(scope: UserScope, taskId: string): SecretRequest | undefined {
    const live = broker.pending(taskId);
    if (live && running.get(taskId)?.userId === scope.userId) return live;
    const steps = chat.listSteps(scope, taskId) ?? [];
    const step = [...steps].reverse().find((item) => item.kind === "tool" && item.status === "running");
    const request = step ? parseJson(step.requestJson) : undefined;
    if (!request || request.name !== "request_secret" || !request.args) return undefined;
    try {
      return parseSecretRequest(request.args);
    } catch {
      return undefined;
    }
  }

  function secretFor(bot: BotRecord): string {
    if (!bot.modelCredentialId) throw new ChatError("没有可用的模型凭据", 500);
    const row = credentialRepository(deps.db).takeForGateway(bot.userId, bot.modelCredentialId);
    if (!row) throw new ChatError("没有可用的模型凭据", 500);
    return decrypt(deps.key, row.secretEnc);
  }

  function userLimit(userId: string): number {
    return quotaRepository(deps.db).find(userScope(userId))?.maxConcurrentTasks ?? 0;
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

function parseJson(json: string): { name?: string; toolCallId?: string; args?: { name?: string; label?: string; kind?: string; reason?: string } } | undefined {
  try {
    const value = JSON.parse(json) as { name?: string; toolCallId?: string; args?: { name?: string; label?: string; kind?: string; reason?: string } };
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function maskDetails(details: unknown, secrets: Array<{ name: string; value: string }>): unknown {
  return maskDeep(details, secrets);
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
