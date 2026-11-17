import { Agent, type AfterToolCallContext, type AgentEvent, type AgentMessage, type AgentTool, type AgentToolResult, type BeforeToolCallContext, type StreamFn } from "@earendil-works/pi-agent-core";
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
import { approvalTools } from "./approval-tools.js";
import { createApprovalGate } from "../approvals/gate.js";
import { desktopTools } from "./desktop-tools.js";
import { takeoverTool } from "./takeover-tool.js";
import { memoryTools } from "./memory-tools.js";
import type { TakeoverLeases } from "../screen/leases.js";
import { trackExecution, type UserFlights } from "../screen/flight.js";
import { M2_EVENTS, terminalErrorClass } from "../m2/events.js";
import { argsHash, READ_ONLY_TOOLS } from "../m2/risk.js";
import { notifyTaskSettled } from "../notify/index.js";
import { emitOps, opsMinutes } from "../ops/rollup.js";
import { routineService } from "../routines/service.js";
import { routineTools } from "./routine-tools.js";
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
import { appendMcpTools, MachinedMcpClient, mcpFailureCategory } from "./mcp-client.js";
import { describeInstall, installMcpBlock, installMcpTool, scrubInstallPlaintext, searchAppsTool, type InstallMcpBinding } from "./app-tools.js";
import { installsForModelContext, privateSkillStorage, resolveMcpLaunch, type CatalogDeps, type CatalogInstaller } from "../apps/catalog.js";
import { markRemoteUncertain, remoteUncertain } from "./remote-uncertain.js";
import { skillHttpMachine, skillPrompt, skillTools } from "./skill-tools.js";
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
  leases?: TakeoverLeases;
  flights?: UserFlights;
  /** 真正把包装进机器。缺省时 install_mcp 无法安装。 */
  installer?: CatalogInstaller;
}

interface QueuedTask {
  id: string;
  botId: string;
  userId: string;
  conversationId: string;
  /** 重启后要先把未完成的工具调用跑完，再 continue。 */
  resume?: "approval" | "takeover";
}

interface Live extends QueuedTask {
  agent?: Agent;
  stopRequested: boolean;
  loaded: boolean;
  done: Promise<void>;
  waitingInput: boolean;
  preserveWait: boolean;
  failReason?: string;
  resumeAbort?: AbortController;
  remoteUnconfirmed?: boolean;
}

function catalogDeps(deps: ChatServiceDeps): CatalogDeps {
  return {
    db: deps.db,
    key: deps.key,
    dataDir: deps.config.dataDir,
    installer: deps.installer ?? {
      async install() {
        throw new Error("安装只能通过目录接口");
      },
      async uninstall() {
        throw new Error("卸载只能通过目录接口");
      },
    },
  };
}

function scrubToolArgs(name: string, args: unknown, catalog: CatalogDeps, userId: string): unknown {
  if (name === "install_mcp") scrubInstallPlaintext(args, catalog, userId);
  return args;
}

async function installedMcpTools(
  deps: ChatServiceDeps,
  endpoint: MachineEndpoint,
  userId: string,
  taskId: string,
  used: Set<string>,
  onUnconfirmed?: () => void,
  signal?: AbortSignal,
): Promise<{
  tools: AgentTool[];
  close: () => void;
  client: MachinedMcpClient;
  failures: Array<{ name: string; category: "启动失败" | "超时" | "协议错误" }>;
  unavailable: string[];
}> {
  const catalog = catalogDeps(deps);
  const files = new MachinedClient(endpoint, deps.fetch ?? fetch);
  const fetchImpl = deps.fetch;
  const client = new MachinedMcpClient({
    endpoint,
    ...(onUnconfirmed ? { onUnconfirmed: () => { onUnconfirmed(); } } : {}),
    ...(fetchImpl
      ? {
          request: async (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect?: "manual"; signal?: AbortSignal }) => {
            const response = await fetchImpl(url, init);
            return { ok: response.ok, status: response.status, text: () => response.text() };
          },
        }
      : {}),
    resolveLaunch: (appName) => {
      const launch = resolveMcpLaunch(catalog, userId, appName);
      return { env: launch.env, headers: launch.headers };
    },
  });
  let names: string[] = [];
  try {
    names = installsForModelContext(catalog, userId).map((item) => item.name);
  } catch (error) {
    return {
      tools: [],
      close: () => client.close(),
      client,
      failures: [{ name: "已安装应用", category: mcpFailureCategory(error) }],
      unavailable: ["已安装应用"],
    };
  }
  const tools: AgentTool[] = [];
  const failures: Array<{ name: string; category: "启动失败" | "超时" | "协议错误" }> = [];
  const unavailable: string[] = [];
  for (const name of names) {
    if (signal?.aborted) break;
    const loading = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    let added = 0;
    let failed = false;
    try {
      const info = await files.inspectApp(name, loading);
      for (const server of info.mcpServers) {
        try {
          const started = await client.launchApp(name, server, loading, taskId);
          const listed = await client.listTools(started.server, loading);
          const next = appendMcpTools(used, client, started.server, listed.tools);
          tools.push(...next);
          added += next.length;
        } catch (error) {
          failed = true;
          failures.push({ name, category: mcpFailureCategory(error) });
        }
      }
    } catch (error) {
      failed = true;
      failures.push({ name, category: mcpFailureCategory(error) });
    }
    if (failed && added === 0) unavailable.push(name);
  }
  return { tools, close: () => client.close(), client, failures, unavailable };
}

function parseStepRequest(json: string): { toolCallId?: string } {
  try {
    const value = JSON.parse(json) as { toolCallId?: unknown };
    return typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {};
  } catch {
    return {};
  }
}

/** 持久化的等待停在助手的工具调用上。先把这次调用跑完并写入结果，continue 才接得上。 */
async function recoverOutstandingTools(input: {
  transcript: AgentMessage[];
  tools: AgentTool[];
  resume: "approval" | "takeover";
  signal?: AbortSignal;
  guard: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>;
  settle: (
    context: BeforeToolCallContext,
    result: AgentToolResult,
    isError: boolean,
    signal?: AbortSignal,
  ) => Promise<{ content: ToolResultMessage["content"]; details: unknown; isError: boolean }>;
  persist: (message: ToolResultMessage, text: string, isError: boolean) => void;
  now: () => number;
}): Promise<void> {
  const answered = new Set(
    input.transcript.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
  );
  const groups = new Map<number, Array<{ id: string; name: string; arguments: Record<string, unknown> }>>();
  input.transcript.forEach((message, index) => {
    if (message.role !== "assistant") return;
    for (const block of message.content) {
      if (block.type !== "toolCall" || answered.has(block.id)) continue;
      const args = block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
        ? block.arguments as Record<string, unknown>
        : {};
      const list = groups.get(index) ?? [];
      list.push({ id: block.id, name: block.name, arguments: args });
      groups.set(index, list);
    }
  });
  let shift = 0;
  for (const [index, calls] of [...groups.entries()].sort((left, right) => left[0] - right[0])) {
    const assistant = input.transcript[index + shift];
    if (!assistant || assistant.role !== "assistant") continue;
    let cursor = index + shift + 1;
    for (const call of calls) {
      const tool = input.tools.find((item) => item.name === call.name);
      const hookContext = {
        assistantMessage: assistant,
        toolCall: { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments },
        args: call.arguments,
        context: { messages: input.transcript, tools: input.tools },
      } as BeforeToolCallContext;
      const directTakeover = input.resume === "takeover" && call.name === "request_takeover";
      let blocked: string | undefined;
      if (!directTakeover) {
        const decision = await input.guard(hookContext, input.signal);
        if (decision?.block) blocked = decision.reason || "已拒绝";
      }
      let result: AgentToolResult;
      let isError = false;
      if (blocked) {
        result = { content: [{ type: "text", text: blocked }], details: {} };
        isError = true;
      } else if (!tool) {
        result = { content: [{ type: "text", text: `找不到工具 ${call.name}` }], details: {} };
        isError = true;
      } else {
        try {
          result = await tool.execute(call.id, call.arguments as never, input.signal, undefined);
          isError = result.isError === true;
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : "工具失败" }], details: {} };
          isError = true;
        }
      }
      const settled = await input.settle(hookContext, result, isError, input.signal);
      const text = settled.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: settled.content,
        isError: settled.isError,
        timestamp: input.now(),
      };
      input.persist(toolResult, text, settled.isError);
      input.transcript.splice(cursor, 0, toolResult);
      cursor += 1;
      shift += 1;
    }
  }
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
      const unconfirmed = chat.findTask(scope, meta.id)?.error === "remote_unconfirmed";
      const text = unconfirmed ? "远端是否已停止未确认" : INTERRUPTED_TOOL;
      if (last?.role === "assistant") {
        for (const block of last.content) {
          if (block.type !== "toolCall" || answered.has(block.id)) continue;
          const toolResult: ToolResultMessage = {
            role: "toolResult",
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: "text", text }],
            isError: true,
            timestamp: now.getTime(),
          };
          chat.insertMessage(scope, {
            id: ulid(),
            conversationId: meta.conversationId,
            role: "toolResult",
            contentJson: storedContent(toolResult, text),
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
    const unconfirmed = chat.findTask(scope, meta.id)?.error === "remote_unconfirmed";
    chat.updateTask(scope, meta.id, { state: "interrupted", endedAt: now.toISOString(), error: unconfirmed ? "remote_unconfirmed" : null });
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
  const approvalGate = createApprovalGate({
    db: deps.db,
    waitMs: deps.config.secretWaitMs,
    riskyToolNames(botId: string) {
      const owner = deps.db.$client.prepare("select user_id as userId from bots where id=? and deleted_at is null").get(botId) as { userId: string } | undefined;
      const names = new Set<string>();
      if (!owner) return names;
      for (const install of installsForModelContext(catalogDeps(deps), owner.userId)) {
        for (const tool of install.riskyTools) names.add(tool);
      }
      return names;
    },
    onWaiting(taskId) {
      const live = running.get(taskId);
      if (!live) return;
      const task = chat.findTask(userScope(live.userId), taskId);
      if (!task?.conversationId) return;
      publishTask(live.userId, task.conversationId, taskId);
      if (task.trigger === "routine") notifyTaskSettled(deps.db, { userId: live.userId, botId: live.botId, taskId, outcome: "needs_user" });
    },
    summarize(taskId, tool, args) {
      if (tool !== "install_mcp") return tool;
      const owner = deps.db.$client.prepare(
        "select b.user_id as userId from tasks t join bots b on b.id=t.bot_id where t.id=?",
      ).get(taskId) as { userId: string } | undefined;
      if (!owner) return tool;
      const card = describeInstall(catalogDeps(deps), owner.userId, args);
      return card ? JSON.stringify(card) : tool;
    },
    onRearm(taskId) {
      const meta = chat.systemTaskMeta(["waiting_approval"]).find((item) => item.id === taskId);
      if (!meta?.conversationId) return;
      queue.push({ id: taskId, botId: meta.botId, userId: meta.userId, conversationId: meta.conversationId, resume: "approval" });
      remember(meta.userId);
      publishTask(meta.userId, meta.conversationId, taskId);
    },
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
  approvalGate.arm();
  deps.leases?.arm();
  for (const meta of chat.systemTaskMeta(["waiting_takeover"])) {
    if (!meta.conversationId) continue;
    queue.push({ id: meta.id, botId: meta.botId, userId: meta.userId, conversationId: meta.conversationId, resume: "takeover" });
    remember(meta.userId);
    publishTask(meta.userId, meta.conversationId, meta.id);
  }
  pump();

  return {
    approvalGate,
    enqueueRoutine(input: { userId: string; botId: string; prompt: string; routineRunId: string }): string {
      if (chat.systemBotBusy(input.botId)) throw new ChatError("这个 bot 还有未完成的任务", 409);
      const scope = userScope(input.userId);
      const bot = botRepository(deps.db).findById(scope, input.botId);
      if (!bot) throw new ChatError("找不到 bot", 404);
      const conversation = resolveConversation(scope, bot, undefined, input.prompt);
      const task = chat.insertTask(scope, {
        id: ulid(),
        botId: bot.id,
        conversationId: conversation.id,
        trigger: "routine",
        routineRunId: input.routineRunId,
      });
      if (!task) throw new ChatError("找不到 bot", 404);
      persistUser(scope, conversation.id, userMessage(input.prompt, now()), task.id);
      queue.push({ id: task.id, botId: bot.id, userId: input.userId, conversationId: conversation.id });
      remember(input.userId);
      publishTask(input.userId, conversation.id, task.id);
      pump();
      return task.id;
    },
    send(input: SendInput): Promise<SendResult> {
      return exclusive(input.botId, () => sendLocked(input));
    },
    stop(scope: UserScope, taskId: string): boolean {
      const task = chat.findTask(scope, taskId);
      if (!task) return false;
      const live = running.get(taskId);
      if (live) {
        live.stopRequested = true;
        live.resumeAbort?.abort();
        if (live.waitingInput) broker.settle(taskId, "stopped");
        else live.agent?.abort();
        deps.leases?.stop(live.botId);
        return true;
      }
      if (task.state === "waiting_takeover") {
        deps.leases?.stop(task.botId);
        chat.updateTask(scope, taskId, { state: "cancelled", endedAt: now().toISOString(), error: null });
        if (task.conversationId) publishTask(scope.userId, task.conversationId, taskId);
        return true;
      }
      if (task.state === "waiting_input") {
        cancelWaiting(scope, task);
        return true;
      }
      if (task.state === "waiting_approval") {
        chat.updateTask(scope, taskId, { state: "cancelled", endedAt: now().toISOString(), error: null });
        deps.db.$client
          .prepare("update approvals set state='stopped', decided_at=? where task_id=? and state='pending'")
          .run(now().toISOString(), taskId);
        if (task.conversationId) publishTask(scope.userId, task.conversationId, taskId);
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
      const approving = chat.findActiveByBot(scope, botId, "waiting_approval");
      if (approving) this.stop(scope, approving.id);
      const takeover = chat.findActiveByBot(scope, botId, "waiting_takeover");
      if (takeover) this.stop(scope, takeover.id);
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
        const task = chat.findTask(userScope(live.userId), live.id);
        if (live.waitingInput || task?.state === "waiting_approval" || task?.state === "waiting_takeover") {
          live.preserveWait = true;
          if (live.waitingInput) broker.settle(live.id, "detached");
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
    let closeMcp = () => {};
    live.resumeAbort = new AbortController();
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
      const inputLock = browsers.lock(live.userId);
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
      const files = new MachinedClient(endpoint, deps.fetch ?? fetch);
      const catalog = catalogDeps(deps);
      const skillMachine = skillHttpMachine(endpoint);
      let skillText = "";
      try {
        skillText = await skillPrompt({ machine: skillMachine, knownSecrets: () => broker.known(live.userId, live.id) });
      } catch {
        skillText = "";
      }
      const usedToolNames = new Set<string>();
      const pendingMcp: AgentTool[] = [];
      const installedMcp = await installedMcpTools(deps, endpoint, live.userId, live.id, usedToolNames, () => {
        live.remoteUnconfirmed = true;
        chat.updateTask(scope, live.id, { error: "remote_unconfirmed" });
        markRemoteUncertain(deps.db, { userId: live.userId, botId: live.botId, taskId: live.id });
        publishTask(live.userId, live.conversationId, live.id);
      }, live.resumeAbort?.signal);
      closeMcp = installedMcp.close;
      if (live.stopRequested) {
        finish(scope, live, "cancelled", null, seq);
        return;
      }
      const mcpTools = installedMcp.tools;
      const dress = (incoming: AgentTool[]): AgentTool[] => {
        const guarded = incoming.map((tool) => {
          const execute = tool.execute.bind(tool);
          tool.execute = async (toolCallId, params, signal, onUpdate) => {
            if (tool.name !== "request_takeover" && !READ_ONLY_TOOLS[tool.name] && remoteUncertain(deps.db, live.userId)) {
              throw new Error("远端可能仍在执行。需要单独确认后才能继续写操作。");
            }
            try {
              return await execute(toolCallId, params, signal, onUpdate);
            } catch (error) {
              if (tool.name === "shell_exec" && error instanceof Error && error.message === "remote_unconfirmed") {
                live.remoteUnconfirmed = true;
                chat.updateTask(scope, live.id, { error: "remote_unconfirmed" });
                markRemoteUncertain(deps.db, { userId: live.userId, botId: live.botId, taskId: live.id });
                publishTask(live.userId, live.conversationId, live.id);
              }
              throw error;
            }
          };
          return tool;
        });
        const tracked = deps.flights ? guarded.map((item) => trackExecution(live.userId, item, deps.flights!)) : guarded;
        return bindSecrets(tracked, (name) => broker.lookup(live.userId, live.id, name));
      };
      const installBinding: InstallMcpBinding = {
        userId: live.userId,
        botId: bot.id,
        botName: bot.name,
        taskId: live.id,
        catalog: catalog,
        lookup: (name) => broker.lookup(live.userId, live.id, name),
        readFile: async (path) => {
          try {
            const file = await files.read(path, 128);
            return file.content;
          } catch {
            return undefined;
          }
        },
        onUnconfirmed: () => {
          live.remoteUnconfirmed = true;
          chat.updateTask(scope, live.id, { error: "remote_unconfirmed" });
          markRemoteUncertain(deps.db, { userId: live.userId, botId: live.botId, taskId: live.id });
        },
        launch: async (appName, signal) => {
          const loading = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
          const info = await files.inspectApp(appName, loading);
          const added: AgentTool[] = [];
          for (const server of info.mcpServers) {
            const started = await installedMcp.client.launchApp(appName, server, loading, live.id);
            const listed = await installedMcp.client.listTools(started.server, loading);
            added.push(...appendMcpTools(usedToolNames, installedMcp.client, started.server, listed.tools));
          }
          pendingMcp.push(...dress(added));
          return added.map((tool) => tool.name);
        },
      };
      const rawTools = [
        ...machineTools(files),
        ...approvalTools({ delete: (path, signal) => files.removeFile(path, signal) }),
        ...routineTools({
          propose: (input) => routineService(deps.db).propose(live.userId, live.botId, input, now()),
        }),
        ...(deps.leases
          ? desktopTools({
              isActive: () => deps.leases?.isActive(live.botId) ?? false,
              input: async (input, signal) => {
                await inputLock.run(async () => {
                  await files.ensureDisplay(1, signal);
                  await files.displayInput(1, input, signal);
                });
              },
              screenshot: async (signal) => {
                return inputLock.run(async () => {
                  await files.ensureDisplay(1, signal);
                  return files.displayShot(1, signal);
                });
              },
            })
          : []),
        ...(deps.leases
          ? [
              takeoverTool({
                request: (signal) =>
                  deps.leases!.request({
                    botId: live.botId,
                    userId: live.userId,
                    taskId: live.id,
                    ...(signal ? { signal } : {}),
                  }),
              }),
            ]
          : []),
        ...browserTools(bound),
        ...(deps.config.visionModels.includes(bot.model) ? [browserScreenshotTool(bound)] : []),
        secretTool,
        searchAppsTool(catalog, live.userId),
        installMcpTool(installBinding),
        ...skillTools({
          ownerUserId: live.userId,
          machine: skillMachine,
          knownSecrets: () => broker.known(live.userId, live.id),
          apps: privateSkillStorage(catalog, live.userId),
        }),
        ...mcpTools,
        ...memoryTools({
          knownSecrets: () => broker.known(live.userId, live.id),
          save: (content) => memoryStore.save(scope, bot.id, { id: ulid(), content, sourceTaskId: live.id }),
          search: (text) => memoryStore.search(scope, bot.id, text, 5) ?? [],
          remove: (id) => memoryStore.remove(scope, bot.id, id) ?? false,
        }),
      ];
      seq = chat.maxSeq(scope, live.id);
      for (const failure of installedMcp.failures) {
        seq += 1;
        const notice = `应用 ${failure.name} 的工具当前不可用（${failure.category}）`;
        const step = chat.insertStep(scope, {
          id: ulid(),
          taskId: live.id,
          seq,
          kind: "mcp",
          status: "failed",
          requestJson: JSON.stringify({ name: "mcp_load", app: failure.name, category: failure.category }),
        });
        if (!step) continue;
        chat.finishStep(scope, step.id, {
          status: "failed",
          responseJson: JSON.stringify({ text: notice }),
        });
        const current = chat.listSteps(scope, live.id)?.find((item) => item.id === step.id);
        if (current) publishStep(live.conversationId, current);
      }
      const guardedTools = rawTools.map((tool) => {
        const execute = tool.execute.bind(tool);
        tool.execute = async (toolCallId, params, signal, onUpdate) => {
          // Approval can wait while another task loses confirmation of its remote execution.
          if (tool.name !== "request_takeover" && !READ_ONLY_TOOLS[tool.name] && remoteUncertain(deps.db, live.userId)) {
            throw new Error("远端可能仍在执行。需要单独确认后才能继续写操作。");
          }
          try {
            return await execute(toolCallId, params, signal, onUpdate);
          } catch (error) {
            if (tool.name === "shell_exec" && error instanceof Error && error.message === "remote_unconfirmed") {
              live.remoteUnconfirmed = true;
              chat.updateTask(scope, live.id, { error: "remote_unconfirmed" });
              markRemoteUncertain(deps.db, { userId: live.userId, botId: live.botId, taskId: live.id });
              publishTask(live.userId, live.conversationId, live.id);
            }
            throw error;
          }
        };
        return tool;
      });
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
      const executable = bindSecrets(
        deps.flights ? guardedTools.map((tool) => trackExecution(live.userId, tool, deps.flights!)) : guardedTools,
        (name) => broker.lookup(live.userId, live.id, name),
      );
      for (const tool of executable) usedToolNames.add(tool.name);
      const guard = async (context: BeforeToolCallContext, signal?: AbortSignal) => {
        const installHash = context.toolCall.name === "install_mcp" ? argsHash("install_mcp", context.args) : undefined;
        if (context.toolCall.name === "install_mcp") {
          const problem = installMcpBlock(catalog, live.userId, context.args);
          if (problem) return { block: true, reason: problem };
        }
        if (
          context.toolCall.name !== "request_takeover" &&
          !READ_ONLY_TOOLS[context.toolCall.name] &&
          remoteUncertain(deps.db, live.userId)
        ) {
          return { block: true, reason: "远端可能仍在执行。停止只结束了本地等待，需要单独确认后才能继续写操作。" };
        }
        if (
          context.toolCall.name !== "request_takeover" &&
          !READ_ONLY_TOOLS[context.toolCall.name] &&
          deps.flights?.paused(live.userId)
        ) {
          return { block: true, reason: "用户正在接管，已拒绝执行" };
        }
        const decision = await approvalGate.bind(live.id).beforeToolCall?.(context, signal);
        if (decision) return decision;
        const hooked = await getToolHooks().beforeToolCall?.(context, signal);
        if (installHash && (context.toolCall.name !== "install_mcp" || argsHash("install_mcp", context.args) !== installHash)) {
          return { block: true, reason: "批准后的安装参数已改变，请重新申请审批" };
        }
        return hooked;
      };
      if (live.resume) {
        await recoverOutstandingTools({
          transcript,
          tools: executable,
          resume: live.resume,
          signal: live.resumeAbort?.signal,
          guard,
          settle: async (context, result, isError, signal) => {
            const hooked = await getToolHooks().afterToolCall?.({ ...context, result, isError } as AfterToolCallContext, signal);
            const content = hooked?.content ?? result.content;
            const details = hooked?.details !== undefined ? hooked.details : result.details;
            const secrets = broker.known(live.userId, live.id);
            return {
              content: maskToolContent(content, secrets),
              details: maskDetails(details, secrets),
              isError: hooked?.isError ?? isError,
            };
          },
          persist: (message, text, isError) => {
            const row = chat.insertMessage(scope, {
              id: ulid(),
              conversationId: live.conversationId,
              role: "toolResult",
              contentJson: storedContent(message, text),
              taskId: live.id,
            });
            if (row) {
              messageIds.set(message, row.id);
              publishMessage(live.conversationId, row.id, scope);
            }
            for (const step of chat.listSteps(scope, live.id) ?? []) {
              if (step.kind !== "tool" || step.status !== "running") continue;
              const request = parseStepRequest(step.requestJson);
              if (request.toolCallId !== message.toolCallId) continue;
              const responseJson = JSON.stringify({ text, isError });
              chat.finishStep(scope, step.id, { status: isError ? "failed" : "succeeded", responseJson });
              const current = chat.listSteps(scope, live.id)?.find((item) => item.id === step.id);
              if (current) publishStep(live.conversationId, current);
            }
          },
          now: () => now().getTime(),
        });
        if (live.preserveWait) return;
        if (live.stopRequested) {
          finish(scope, live, "cancelled", null, seq);
          return;
        }
      }
      const unavailableNotice = installedMcp.unavailable
        .map((name) => `应用 ${name} 的工具当前不可用`)
        .join("\n");
      const agent = new Agent({
        initialState: {
          systemPrompt: [buildSystemPrompt(
            platform,
            bot.instructions,
            formatMemorySection(recent, matched),
            statusBlock(now(), "运行中", broker.names(live.userId)),
          ), skillText, unavailableNotice].filter((part) => part.length > 0).join("\n\n"),
          model,
          tools: executable,
          messages: transcript,
        },
        prepareNextTurnWithContext: (turn) => {
          if (pendingMcp.length === 0) return undefined;
          const tools = [...(turn.context.tools ?? []), ...pendingMcp.splice(0)];
          return { context: { ...turn.context, tools } };
        },
        streamFn: relayWithOverflowRetry(deps.streamFn, deps.config.modelContextTokens, (next, overflowSignal) =>
          compactLive(next, true, overflowSignal),
        ),
        transformContext: (next, signal) => compactLive(next, false, signal),
        beforeToolCall: guard,
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
        finish(scope, live, "cancelled", live.remoteUnconfirmed ? "remote_unconfirmed" : null, seq, usage);
      } else if (last && last.stopReason === "error") {
        finish(scope, live, "failed", last.errorMessage ?? "模型请求失败", seq, usage);
      } else {
        finish(scope, live, "succeeded", null, seq, usage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务失败";
      finish(scope, live, "failed", live.failReason ?? message, seq);
    } finally {
      closeMcp();
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
      if (event.message.role === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "toolCall" && block.name === "install_mcp") scrubInstallPlaintext(block.arguments, catalogDeps(deps), live.userId);
        }
      }
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
        requestJson: json({
          name: event.toolName,
          args: scrubToolArgs(event.toolName, event.args, catalogDeps(deps), live.userId),
          toolCallId: event.toolCallId,
        }),
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
      error: live.remoteUnconfirmed ? "remote_unconfirmed" : error,
      endedAt: now().toISOString(),
      stepCount,
      ...(usage !== undefined ? { usageJson: usage } : {}),
    });
    const settled = chat.findTask(scope, live.id);
    const errorClass = terminalErrorClass(error);
    const ts = now().toISOString();
    if (state === "failed") {
      emitOps(deps.db, opsMinutes, {
        id: ulid(),
        ts,
        userId: live.userId,
        botId: live.botId,
        type: M2_EVENTS.taskFailed,
        attrs: { errorClass, taskId: live.id },
      });
    } else if (state === "succeeded") {
      emitOps(deps.db, opsMinutes, {
        id: ulid(),
        ts,
        userId: live.userId,
        botId: live.botId,
        type: M2_EVENTS.taskFinished,
        attrs: { taskId: live.id },
      });
    } else if (state === "cancelled" || state === "interrupted") {
      emitOps(deps.db, opsMinutes, {
        id: ulid(),
        ts,
        userId: live.userId,
        botId: live.botId,
        type: M2_EVENTS.taskCancelled,
        attrs: { taskId: live.id },
      });
    }
    if (settled?.trigger === "routine" && (state === "succeeded" || state === "failed" || state === "cancelled" || state === "interrupted")) {
      deps.db.$client.prepare("update routine_runs set state=? where task_id=? and state='claimed'").run(state === "succeeded" ? "succeeded" : "failed", live.id);
      const routine = deps.db.$client
        .prepare(
          `select routine_id as routineId from routine_runs
           where task_id=? or id=(select routine_run_id from tasks where id=?)
           limit 1`,
        )
        .get(live.id, live.id) as { routineId: string } | undefined;
      if (state === "failed" && routine?.routineId) {
        emitOps(deps.db, opsMinutes, {
          id: ulid(),
          ts,
          userId: live.userId,
          botId: live.botId,
          type: M2_EVENTS.routineFailed,
          attrs: { errorClass, routineId: routine.routineId, taskId: live.id },
        });
      }
      notifyTaskSettled(deps.db, {
        userId: live.userId,
        botId: live.botId,
        taskId: live.id,
        outcome: state === "succeeded" || state === "cancelled" || state === "interrupted" ? state : "failed",
      });
    }
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
