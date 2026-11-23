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
import type { BoundBrowser } from "./browser-session.js";
import { browserApprovalUrl } from "./browser-session.js";
import { holdTaskClock, pauseTaskClock, taskUsageJson } from "../gateway/stream.js";
import { durationLimitText, elapsedActiveMs, resolveTaskMaxDurationSec, restoreActive, watchActiveLimit } from "../task-limits.js";
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
import { LENGTH_CONTINUE_TEXT, LENGTH_FAIL, TRUNCATED_TOOL_TEXT, lengthAction, terminalOutcome } from "./length.js";
import { redactMessage, redactMessages, redactStep, userShowsProcess } from "./process-detail.js";
import { profileSummary, updateBotProfileTool } from "./profile-tool.js";
import { proposalSummary, proposeApprovalRuleTool } from "../approvals/propose-tool.js";
import { budgetFailure, resolveTaskTokenBudget } from "../task-budget.js";
import { AVATAR_MAX_BYTES } from "./avatar.js";
import { readModelLimits, resolveModelLimit } from "../model-limits.js";
import { buildSystemPrompt, formatMemorySection, installedAppsBlock, latestUserText, statusBlock } from "./prompt.js";
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
import { MachinedMcpClient } from "./mcp-client.js";
import { createTaskMcp, summarizeMcpCall } from "./mcp-tools.js";
import { describeInstall, installMcpBlock, installMcpTool, scrubInstallPlaintext, searchAppsTool, type InstallMcpBinding } from "./app-tools.js";
import { linkAppCredentialTool, saveSecretFromMachineTool } from "./shared-credentials.js";
import { installsForModelContext, privateSkillStorage, resolveMcpLaunch, type CatalogDeps, type CatalogInstaller } from "../apps/catalog.js";
import { packageAppTool } from "../apps/package-app.js";
import { describePublish, requestAppPublishTool } from "../apps/publish-request.js";
import { markRemoteUncertain, remoteUncertain } from "./remote-uncertain.js";
import { skillHttpMachine, skillPrompt, skillTools } from "./skill-tools.js";
import { machineTools } from "./tools.js";
import { createSendFileTool } from "./file-send-tool.js";
import { assistantText, loadTranscript, loadTranscriptEntries, messageView, stepView, storedContent, taskView, withoutImages } from "./view.js";
import { foldNoticeEntries } from "./notices.js";
import { buildModel, type GatewayTask } from "../gateway/stream.js";
import { userScope, type UserScope } from "../scope.js";
import { deliverAttachments } from "../uploads/deliver.js";
import { cropUserImages, presentForModel } from "../uploads/present.js";
import type { UploadStorage } from "../uploads/storage.js";
import { claimUploads, clearUnclaimedDeliveries, deliveredUploadIds, findOwnedUpload, markUploadDelivered, readAttachments, UploadRejected, type AttachmentRef } from "../uploads/store.js";
import { uploadPredatesStorage } from "../uploads/switch.js";

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
  uploadIds?: string[];
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
  uploads: UploadStorage;
  uploadStorageSince: string;
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
  lengthContinuations: number;
  truncateNextTools: boolean;
  browser?: BoundBrowser;
  files?: MachinedClient;
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
  function uploadUnavailable(userId: string, id: string): boolean {
    const row = findOwnedUpload(deps.db, userId, id);
    return row !== undefined && uploadPredatesStorage(row.createdAt, deps.uploadStorageSince);
  }
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
      for (const install of installsForModelContext(catalogDeps(deps), owner.userId, botId)) {
        for (const tool of install.riskyTools) names.add(`${install.name}:${tool}`);
      }
      return names;
    },
    onWaiting(taskId) {
      holdRun(taskId, true);
      const live = running.get(taskId);
      if (!live) return;
      const task = chat.findTask(userScope(live.userId), taskId);
      if (!task?.conversationId) return;
      publishTask(live.userId, task.conversationId, taskId);
      if (task.trigger === "routine") notifyTaskSettled(deps.db, { userId: live.userId, botId: live.botId, taskId, outcome: "needs_user" });
    },
    onHold(taskId) {
      holdRun(taskId, true);
    },
    onRelease(taskId) {
      holdRun(taskId, false);
    },
    summarize(taskId, tool, args) {
      if (tool === "mcp_call") return summarizeMcpCall(args);
      if (tool === "propose_approval_rule") return proposalSummary(args);
      if (tool === "update_bot_profile") {
        const current = deps.db.$client.prepare(
          "select b.id as botId, b.user_id as userId, b.name, b.bio, b.instructions, b.model from tasks t join bots b on b.id=t.bot_id where t.id=?",
        ).get(taskId) as { botId: string; userId: string; name: string; bio: string; instructions: string; model: string } | undefined;
        if (!current) return tool;
        return profileSummary({ ...current, enabledAppIds: installsForModelContext(catalogDeps(deps), current.userId, current.botId).map((app) => app.installId) }, args);
      }
      if (tool !== "install_mcp" && tool !== "request_app_publish") return tool;
      const owner = deps.db.$client.prepare(
        "select b.user_id as userId from tasks t join bots b on b.id=t.bot_id where t.id=?",
      ).get(taskId) as { userId: string } | undefined;
      if (!owner) return tool;
      if (tool === "request_app_publish") {
        const published = describePublish(catalogDeps(deps), owner.userId, args);
        return published ? JSON.stringify(published) : tool;
      }
      const card = describeInstall(catalogDeps(deps), owner.userId, args);
      return card ? JSON.stringify(card) : tool;
    },
    async browserUrl(taskId, tool, args) {
      if (tool === "browser_open") {
        const url = args && typeof args === "object" ? (args as { url?: unknown }).url : undefined;
        return typeof url === "string" ? url : undefined;
      }
      const live = running.get(taskId);
      if (!live?.browser) return undefined;
      return browserApprovalUrl(live.browser, tool, args);
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
    const scope = userScope(input.userId);
    const attachments = input.uploadIds && input.uploadIds.length > 0 ? await attachmentsFor(scope.userId, input.uploadIds) : [];
    if (text.length === 0 && attachments.length === 0) throw new ChatError("消息不能为空", 400);
    if (text.length > TEXT_LIMIT) throw new ChatError("消息太长", 400);
    const bot = botRepository(deps.db).findById(scope, input.botId);
    if (!bot) throw new ChatError("找不到 bot", 404);
    if (!quotaRepository(deps.db).find(scope)) throw new ChatError("尚未开通，请联系管理员", 403);
    const conversation = resolveConversation(scope, bot, input.conversationId, text || attachments[0]?.name || "附件");
    const live = liveByBot.get(bot.id);
    if (live && live.conversationId !== conversation.id) {
      throw new ChatError("这个 bot 还有未完成的任务", 409);
    }
    const message = userMessage(text, now());
    if (live?.agent?.state.isStreaming) {
      // 投递目录先定下来。消息 id 要等入库时再分配，避免占住会话顺序。
      const place = attachments.length > 0 ? ulid() : undefined;
      const stamped = place === undefined ? attachments : attachments.map((item) => ({ ...item, place }));
      if (place) {
        try {
          await deliverMessageFiles(live, place, stamped);
        } catch (error) {
          clearUnclaimedDeliveries(deps.db, scope.userId, attachments.map((item) => item.id));
          if (error instanceof ChatError) throw error;
          throw new ChatError(error instanceof Error ? error.message : "上传失败", 502);
        }
      }
      // followUp 只入队。原任务已经结束时队列不会再被执行，必须另开任务。
      if (!running.has(live.id) || live.agent?.state.isStreaming !== true) {
        const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
        if (!task) throw new ChatError("找不到 bot", 404);
        const row = persistUser(scope, conversation.id, message, task.id, stamped);
        saved.add(message);
        queue.push({ id: task.id, botId: bot.id, userId: input.userId, conversationId: conversation.id });
        remember(input.userId);
        publishTask(input.userId, conversation.id, task.id);
        pump();
        return { conversationId: conversation.id, taskId: task.id, messageId: row.id };
      }
      const row = persistUser(scope, conversation.id, message, live.id, stamped);
      saved.add(message);
      if (attachments.length > 0) await showAttachments(message, row.id, stamped, deps.config.visionModels.includes(bot.model), live.userId);
      if (input.mode === "steer") live.agent.steer(message);
      else live.agent.followUp(message);
      return { conversationId: conversation.id, taskId: live.id, messageId: row.id };
    }
    if (live && !live.loaded) {
      const row = persistUser(scope, conversation.id, message, live.id, attachments);
      saved.add(message);
      return { conversationId: conversation.id, taskId: live.id, messageId: row.id };
    }
    if (live) await live.done;
    const pending = chat.findActiveByBot(scope, bot.id, "queued");
    if (pending && pending.conversationId && pending.conversationId !== conversation.id) {
      throw new ChatError("这个 bot 还有未完成的任务", 409);
    }
    if (pending) {
      const row = persistUser(scope, conversation.id, message, pending.id, attachments);
      saved.add(message);
      return { conversationId: conversation.id, taskId: pending.id, messageId: row.id };
    }
    const waiting = chat.findActiveByBot(scope, bot.id, "waiting_input");
    if (waiting) throw new ChatError("正在等待输入", 409);
    const task = chat.insertTask(scope, { id: ulid(), botId: bot.id, conversationId: conversation.id });
    if (!task) throw new ChatError("找不到 bot", 404);
    const row = persistUser(scope, conversation.id, message, task.id, attachments);
    saved.add(message);
    queue.push({ id: task.id, botId: bot.id, userId: input.userId, conversationId: conversation.id });
    remember(input.userId);
    publishTask(input.userId, conversation.id, task.id);
    pump();
    return { conversationId: conversation.id, taskId: task.id, messageId: row.id };
  }

  function persistUser(
    scope: UserScope,
    conversationId: string,
    message: UserMessage,
    taskId: string | null,
    attachments: AttachmentRef[] = [],
  ) {
    const write = () => {
      const id = ulid();
      const row = chat.insertMessage(scope, {
        id,
        conversationId,
        role: "user",
        contentJson: storedContent(message, typeof message.content === "string" ? message.content : "", attachments),
        taskId,
      });
      if (!row) throw new ChatError("找不到对话", 404);
      if (attachments.length > 0) claimUploads(deps.db, scope.userId, row.id, attachments.map((item) => item.id));
      return row;
    };
    try {
      const row = attachments.length > 0 ? deps.db.$client.transaction(write)() : write();
      messageIds.set(message, row.id);
      chat.touchConversation(scope, conversationId);
      publishMessage(conversationId, row.id, scope);
      return row;
    } catch (error) {
      if (error instanceof UploadRejected) throw new ChatError(error.message, error.statusCode);
      throw error;
    }
  }

  async function showAttachments(message: UserMessage, messageId: string, attachments: AttachmentRef[], vision: boolean, userId: string): Promise<void> {
    const [shown] = await presentForModel([{ id: messageId, message, attachments }], {
      vision,
      storage: deps.uploads,
      userId,
      unavailable: (id) => uploadUnavailable(userId, id),
    });
    if (shown?.message.role === "user") message.content = shown.message.content;
  }

  function deliveryTarget(item: AttachmentRef, messageId: string): { messageId: string; id: string; name: string; place?: string } {
    const target: { messageId: string; id: string; name: string; place?: string } = {
      messageId: item.place ?? messageId,
      id: item.id,
      name: item.name,
    };
    if (item.place !== undefined) target.place = item.place;
    return target;
  }

  async function deliverMessageFiles(live: Live, messageId: string, attachments: AttachmentRef[]): Promise<void> {
    const client = live.files;
    if (!client) throw new ChatError("机器还没准备好接收附件", 503);
    const delivered = deliveredUploadIds(deps.db, live.userId, attachments.map((item) => item.id));
    await deliverAttachments(
      deps.uploads,
      live.userId,
      attachments.map((item) => deliveryTarget(item, messageId)),
      (path, body, deliveryId) => client.upload(path, body, deliveryId, live.resumeAbort?.signal),
      delivered,
      (id) => markUploadDelivered(deps.db, live.userId, id, now().toISOString()),
      (id) => uploadUnavailable(live.userId, id),
    );
  }

  async function takeParkedMessages(scope: UserScope, live: Live, transcript: AgentMessage[], vision: boolean, known: Set<string>): Promise<void> {
    const skipped = new Set<string>();
    for (;;) {
      const missed = (chat.listMessages(scope, live.conversationId) ?? []).filter(
        (row) => row.role === "user" && row.taskId === live.id && !known.has(row.id) && !skipped.has(row.id),
      );
      if (missed.length === 0) return;
      for (const row of missed) {
        const [entry] = loadTranscriptEntries([row]);
        if (!entry || entry.message.role !== "user") {
          skipped.add(row.id);
          continue;
        }
        if (entry.attachments.length > 0) await deliverMessageFiles(live, row.id, entry.attachments);
        const [shown] = await presentForModel([entry], {
          vision,
          storage: deps.uploads,
          userId: live.userId,
          unavailable: (id) => uploadUnavailable(live.userId, id),
        });
        const message = shown?.message.role === "user" ? shown.message : entry.message;
        saved.add(message);
        messageIds.set(message, row.id);
        known.add(row.id);
        transcript.push(message);
      }
    }
  }

  async function attachmentsFor(userId: string, uploadIds: string[]): Promise<AttachmentRef[]> {
    try {
      return await readAttachments(deps.db, userId, uploadIds, deps.uploads, deps.uploadStorageSince);
    } catch (error) {
      if (error instanceof UploadRejected) throw new ChatError(error.message, error.statusCode);
      throw error;
    }
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
      lengthContinuations: 0,
      truncateNextTools: false,
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
      const previous = chat.findTask(scope, live.id);
      let usage: Partial<GatewayTask> & { totalTokens?: number } = {};
      try { usage = JSON.parse(previous?.usageJson ?? "{}") ?? {}; } catch { /* Older tasks may have no snapshot. */ }
      live.lengthContinuations = usage.lengthContinuations ?? 0;
      const tokenBudget = usage.tokenBudget ?? resolveTaskTokenBudget(deps.db, live.userId, deps.config.taskTokenBudget);
      const restored = restoreActive(typeof usage.activeMs === "number" && Number.isFinite(usage.activeMs) ? usage.activeMs : 0, now().getTime());
      chat.updateTask(scope, live.id, { state: "running", startedAt: previous?.startedAt ?? now().toISOString(), error: null });
      // 等机器期间到达的系统通知只留给下一次运行。用户发给当前任务的消息由 takeParkedMessages 补入。
      const contextRows = chat.listContextMessages(scope, live.conversationId) ?? [];
      const untilMessageId = chat.readSummary(scope, live.conversationId)?.untilMessageId;
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
        tokensUsed: usage.totalTokens ?? 0,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        modelCalls: usage.modelCalls ?? 0,
        lengthContinuations: live.lengthContinuations,
        startedAt: now().getTime(),
        activeMs: restored.activeMs,
        segmentStartedAt: restored.segmentStartedAt,
        tokenBudget,
      };
      chat.updateTask(scope, live.id, { usageJson: taskUsageJson(gatewayTask) });
      deps.tasks.set(live.id, gatewayTask);
      const platform = settingsRepository(deps.db).platformPrompt().text;
      const contextEntries = loadTranscriptEntries(contextRows);
      const anchorIndex = untilMessageId ? contextEntries.findIndex((entry) => entry.id === untilMessageId) : -1;
      // 锚点行必须留在列表里，openTail 才按原始 id 切开。只折叠锚点之后的条目，新通知不会把代表 id 改成组内最大 id，也不会把锚点并进新组。
      const tail = foldNoticeEntries(anchorIndex >= 0 ? contextEntries.slice(anchorIndex + 1) : contextEntries);
      const loaded = {
        entries: anchorIndex >= 0 ? [...contextEntries.slice(0, anchorIndex + 1), ...tail.entries] : tail.entries,
        groups: tail.groups,
      };
      const presented = await presentForModel(loaded.entries, {
        vision: deps.config.visionModels.includes(bot.model),
        storage: deps.uploads,
        userId: live.userId,
        unavailable: (id) => uploadUnavailable(live.userId, id),
      });
      for (const entry of presented) messageIds.set(entry.message, entry.id);
      const transcript = presented.map((entry) => entry.message);
      const memoryStore = memoryRepository(deps.db);
      const query = latestUserText(transcript);
      const recent = memoryStore.recent(scope, bot.id, 10) ?? [];
      const matched = query ? (memoryStore.search(scope, bot.id, query, 5) ?? []) : [];
      const bound = browsers.bind(live.userId, live.botId, endpoint);
      live.browser = bound;
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
      live.files = files;
      const attached = (chat.listMessages(scope, live.conversationId) ?? []).flatMap((row) => {
        if (row.taskId !== live.id || row.role !== "user") return [];
        return (messageView(row).attachments ?? []).map((item) => deliveryTarget(item, row.id));
      });
      const delivered = deliveredUploadIds(deps.db, live.userId, attached.map((item) => item.id));
      await deliverAttachments(
        deps.uploads,
        live.userId,
        attached,
        (path, body, deliveryId) => files.upload(path, body, deliveryId, live.resumeAbort?.signal),
        delivered,
        (id) => markUploadDelivered(deps.db, live.userId, id, now().toISOString()),
        (id) => uploadUnavailable(live.userId, id),
      );
      const catalog = catalogDeps(deps);
      const skillMachine = skillHttpMachine(endpoint);
      let skillText = "";
      try {
        skillText = await skillPrompt({ machine: skillMachine, knownSecrets: () => broker.known(live.userId, live.id) });
      } catch {
        skillText = "";
      }
      const fetchImpl = deps.fetch;
      const taskMcp = createTaskMcp({
        client: new MachinedMcpClient({
          endpoint,
          onUnconfirmed: () => {
            live.remoteUnconfirmed = true;
            chat.updateTask(scope, live.id, { error: "remote_unconfirmed" });
            markRemoteUncertain(deps.db, { userId: live.userId, botId: live.botId, taskId: live.id });
            publishTask(live.userId, live.conversationId, live.id);
          },
          ...(fetchImpl
            ? {
                request: async (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect?: "manual"; signal?: AbortSignal }) => {
                  const response = await fetchImpl(url, init);
                  return { ok: response.ok, status: response.status, text: () => response.text() };
                },
              }
            : {}),
          resolveLaunch: (appName) => {
            const launch = resolveMcpLaunch(catalog, live.userId, appName);
            return { env: launch.env, headers: launch.headers };
          },
        }),
        files,
        catalog,
        userId: live.userId,
        botId: live.botId,
        taskId: live.id,
      });
      closeMcp = () => taskMcp.close();
      if (live.stopRequested) {
        finish(scope, live, "cancelled", null, seq);
        return;
      }
      const durationCap = () => resolveTaskMaxDurationSec(deps.db, live.userId, deps.config.maxTaskDurationSec);
      const confineTool = (signal: AbortSignal | undefined): { signal: AbortSignal | undefined; settle: () => string | undefined } => {
        const maxSec = durationCap();
        if (maxSec <= 0) return { signal, settle: () => undefined };
        const controller = new AbortController();
        const stop = watchActiveLimit(
          () => ({ activeMs: gatewayTask.activeMs, segmentStartedAt: gatewayTask.segmentStartedAt }),
          () => now().getTime(),
          maxSec,
          () => controller.abort(),
        );
        let settled = false;
        return {
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          settle: () => {
            if (settled) return undefined;
            settled = true;
            stop();
            if (signal?.aborted || live.stopRequested) return undefined;
            const elapsed = elapsedActiveMs(
              { activeMs: gatewayTask.activeMs, segmentStartedAt: gatewayTask.segmentStartedAt },
              now().getTime(),
            );
            if (elapsed >= maxSec * 1000) return durationLimitText(elapsed);
            return undefined;
          },
        };
      };
      const durationToolResult = (text: string): AgentToolResult => {
        live.failReason = text;
        return { content: [{ type: "text", text }], details: {}, isError: true, terminate: true };
      };
      const runLimitedTool = async (
        signal: AbortSignal | undefined,
        run: (signal: AbortSignal | undefined) => Promise<AgentToolResult>,
      ): Promise<AgentToolResult> => {
        const limited = confineTool(signal);
        try {
          const result = await run(limited.signal);
          const expired = limited.settle();
          if (expired) return durationToolResult(expired);
          return result;
        } catch (error) {
          const expired = limited.settle();
          if (error instanceof Error && error.message === "remote_unconfirmed" && !live.remoteUnconfirmed) {
            live.remoteUnconfirmed = true;
            chat.updateTask(scope, live.id, { error: "remote_unconfirmed" });
            markRemoteUncertain(deps.db, { userId: live.userId, botId: live.botId, taskId: live.id });
            publishTask(live.userId, live.conversationId, live.id);
          }
          if (expired) return durationToolResult(expired);
          throw error;
        }
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
            const file = await files.read(path, 128, undefined, undefined, true);
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
        launch: async () => [],
      };
      const rawTools = [
        ...machineTools(files, {
          confined: settingsRepository(deps.db).fsConfine(),
          confineNow: () => settingsRepository(deps.db).fsConfine(),
          confinePolicyNow: () => {
            const config = settingsRepository(deps.db).fsConfineConfig();
            return { allow: config.allow, deny: config.deny };
          },
        }),
        createSendFileTool({
          db: deps.db,
          dataDir: deps.config.dataDir,
          storage: deps.uploads,
          userId: live.userId,
          scope,
          taskId: live.id,
          conversationId: live.conversationId,
          confined: settingsRepository(deps.db).fsConfine(),
          confineNow: () => settingsRepository(deps.db).fsConfine(),
          confinePolicyNow: () => {
            const config = settingsRepository(deps.db).fsConfineConfig();
            return { allow: config.allow, deny: config.deny };
          },
          knownSecrets: () => broker.known(live.userId, live.id),
          now,
          files,
          publish: (messageId) => publishMessage(live.conversationId, messageId, scope),
        }),
        ...approvalTools({
          delete: (path, signal) => {
            const config = settingsRepository(deps.db).fsConfineConfig();
            return files.removeFile(path, signal, config.enabled, config.enabled ? { allow: config.allow, deny: config.deny } : undefined);
          },
        }),
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
        saveSecretFromMachineTool({
          userId: live.userId,
          taskId: live.id,
          catalog,
          files,
          confineNow: () => settingsRepository(deps.db).fsConfine(),
          remember: (name, value) => broker.remember(live.id, name, value),
          stopApp: (name) => taskMcp.stopApp(name),
        }),
        linkAppCredentialTool({
          userId: live.userId,
          botId: live.botId,
          catalog,
          stopApp: (name) => taskMcp.stopApp(name),
        }),
        searchAppsTool(catalog, live.userId),
        packageAppTool({
          userId: live.userId,
          catalog,
          client: files,
          secrets: () => broker.known(live.userId, live.id).map((item) => item.value),
          confined: settingsRepository(deps.db).fsConfine(),
          confineNow: () => settingsRepository(deps.db).fsConfine(),
        }),
        installMcpTool(installBinding),
        requestAppPublishTool({
          userId: live.userId,
          botId: bot.id,
          taskId: live.id,
          catalog,
        }),
        ...skillTools({
          ownerUserId: live.userId,
          machine: skillMachine,
          knownSecrets: () => broker.known(live.userId, live.id),
          apps: privateSkillStorage(catalog, live.userId),
        }),
        taskMcp.inspectTool,
        taskMcp.callTool,
        ...memoryTools({
          knownSecrets: () => broker.known(live.userId, live.id),
          save: (content) => memoryStore.save(scope, bot.id, { id: ulid(), content, sourceTaskId: live.id }),
          search: (text) => memoryStore.search(scope, bot.id, text, 5) ?? [],
          remove: (id) => memoryStore.remove(scope, bot.id, id) ?? false,
        }),
        updateBotProfileTool({
          db: deps.db,
          dataDir: deps.config.dataDir,
          userId: live.userId,
          botId: bot.id,
          taskId: live.id,
          allowModel: (candidate) => deps.config.models.length === 0 || deps.config.models.includes(candidate),
          confineNow: () => settingsRepository(deps.db).fsConfine(),
          confinePolicyNow: () => {
            const config = settingsRepository(deps.db).fsConfineConfig();
            return { allow: config.allow, deny: config.deny };
          },
          readFile: async (path) => {
            const config = settingsRepository(deps.db).fsConfineConfig();
            const file = await files.read(
              path,
              AVATAR_MAX_BYTES,
              undefined,
              "base64",
              config.enabled,
              config.enabled ? { allow: config.allow, deny: config.deny } : undefined,
            );
            return { bytes: Buffer.from(file.content, "base64"), truncated: file.truncated };
          },
        }),
        proposeApprovalRuleTool({ db: deps.db, userId: live.userId, botId: bot.id }),
      ];
      seq = chat.maxSeq(scope, live.id);
      const guardedTools = rawTools.map((tool) => {
        const execute = tool.execute.bind(tool);
        tool.execute = async (toolCallId, params, signal, onUpdate) => {
          // Approval can wait while another task loses confirmation of its remote execution.
          if (tool.name !== "request_takeover" && !READ_ONLY_TOOLS[tool.name] && remoteUncertain(deps.db, live.userId)) {
            throw new Error("远端可能仍在执行。需要单独确认后才能继续写操作。");
          }
          return runLimitedTool(signal, (limited) => execute(toolCallId, params, limited, onUpdate));
        };
        return tool;
      });
      const model = buildModel(deps.config, bot.model);
      const limits = resolveModelLimit(readModelLimits(deps.db), bot.model, {
        contextTokens: deps.config.modelContextTokens,
        maxTokens: deps.config.modelMaxTokens,
      });
      model.contextWindow = limits.contextTokens;
      model.maxTokens = limits.maxTokens;
      const compactLive = (next: AgentMessage[], force: boolean, signal?: AbortSignal) => {
        const cropped = cropUserImages(next, { vision: deps.config.visionModels.includes(bot.model) });
        // 裁图副本仍代表同一条入库消息，否则摘要不能覆盖这条消息及之后的通知。
        for (const [index, message] of cropped.entries()) {
          const original = next[index]!;
          if (message === original) continue;
          const id = messageIds.get(original);
          if (id) messageIds.set(message, id);
        }
        return applyCompaction(
          cropped,
          {
            contextTokens: limits.contextTokens,
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
            canSummarize: (ids, untilId) => {
              const expanded = ids.flatMap((id) => loaded.groups.get(id) ?? [id]);
              return chat.canSummarize(scope, live.conversationId, expanded, untilId);
            },
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
      };
      const executable = bindSecrets(
        deps.flights ? guardedTools.map((tool) => trackExecution(live.userId, tool, deps.flights!)) : guardedTools,
        (name) => broker.lookup(live.userId, live.id, name),
      );
      const guard = async (context: BeforeToolCallContext, signal?: AbortSignal) => {
        const overBudget = budgetFailure(gatewayTask);
        if (overBudget) {
          live.failReason = overBudget;
          return { block: true, reason: overBudget, terminate: true };
        }
        const boundName = context.toolCall.name === "install_mcp" || context.toolCall.name === "propose_approval_rule" ? context.toolCall.name : undefined;
        const installHash = boundName ? argsHash(boundName, context.args) : undefined;
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
        if (installHash && boundName && argsHash(context.toolCall.name, context.args) !== installHash) {
          return { block: true, reason: boundName === "install_mcp" ? "批准后的安装参数已改变，请重新申请审批" : "批准后的规则参数已改变，不能复用这次审批" };
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
      await takeParkedMessages(scope, live, transcript, deps.config.visionModels.includes(bot.model), new Set(presented.map((entry) => entry.id)));
      const appsText = installedAppsBlock(installsForModelContext(catalog, live.userId, live.botId).map((app) => ({
        name: app.name,
        version: app.version,
        config: app.config,
      })));
      const agentHolder: { agent?: Agent } = {};
      const agent = new Agent({
        initialState: {
          systemPrompt: [buildSystemPrompt(
            platform,
            bot.instructions,
            formatMemorySection(recent, matched),
            statusBlock(now(), "运行中", broker.names(live.userId)),
          ), appsText, skillText].filter((part) => part.length > 0).join("\n\n"),
          model,
          tools: executable,
          messages: transcript,
        },
        streamFn: relayWithOverflowRetry(deps.streamFn, limits.contextTokens, (next, overflowSignal) =>
          compactLive(next, true, overflowSignal),
        ),
        finishTurn: (event) => {
          if (!live.stopRequested) {
            const maxSec = durationCap();
            const elapsed = elapsedActiveMs(
              { activeMs: gatewayTask.activeMs, segmentStartedAt: gatewayTask.segmentStartedAt },
              now().getTime(),
            );
            if (maxSec > 0 && elapsed >= maxSec * 1000) {
              live.failReason = durationLimitText(elapsed);
              return { action: "end" as const };
            }
          }
          const overBudget = budgetFailure(gatewayTask);
          if (overBudget) {
            live.failReason = overBudget;
            return { action: "end" as const };
          }
          const toolCalls = event.message.content.filter((block) => block.type === "toolCall").length;
          const action = lengthAction(live.lengthContinuations, { stopReason: event.message.stopReason, toolCalls });
          live.lengthContinuations = action.continuations;
          gatewayTask.lengthContinuations = action.continuations;
          chat.updateTask(scope, live.id, { usageJson: taskUsageJson(gatewayTask) });
          if (action.action === "fail") {
            live.failReason = LENGTH_FAIL;
            return { action: "end" as const };
          }
          if (action.action === "continue_text") {
            agentHolder.agent?.followUp({ role: "user", content: LENGTH_CONTINUE_TEXT, timestamp: now().getTime() });
          }
          live.truncateNextTools = false;
          return undefined;
        },
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
      agentHolder.agent = agent;
      live.agent = agent;
      live.loaded = true;
      const pending = agent.continue();
      await pending;
      const last = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
      const finalUsage = taskUsageJson(gatewayTask);
      const overBudget = live.stopRequested ? undefined : budgetFailure(gatewayTask);
      const outcome = terminalOutcome({
        failReason: live.failReason ?? overBudget,
        stopRequested: live.stopRequested,
        stopReason: last?.stopReason,
        errorMessage: overBudget ?? last?.errorMessage,
      });
      const error = outcome.state === "cancelled" && live.remoteUnconfirmed ? "remote_unconfirmed" : outcome.error;
      finish(scope, live, outcome.state, error, seq, finalUsage);
    } catch (error) {
      const current = deps.tasks.get(live.id);
      const overBudget = current && !live.stopRequested ? budgetFailure(current) : undefined;
      const message = overBudget ?? (error instanceof Error ? error.message : "任务失败");
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
      if (!userShowsProcess(deps.db, userScope(live.userId))) return seq;
      deps.hub.publish(live.conversationId, {
        type: "delta",
        conversationId: live.conversationId,
        taskId: live.id,
        text: veil(assistantText(event.message)),
      });
      return seq;
    }
    if (event.type === "tool_execution_end" && live.truncateNextTools) {
      event.result.content = [{ type: "text", text: TRUNCATED_TOOL_TEXT }];
      event.result.isError = true;
    }
    if (event.type === "message_end") {
      // 系统消息是当次运行的提示词和工具声明，下次启动会按 bot 重新生成，不写入对话。
      if (event.message.role === "system") return seq;
      if (event.message.role === "assistant") {
        live.truncateNextTools = event.message.stopReason === "length" && event.message.content.some((block) => block.type === "toolCall");
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
    const gateway = deps.tasks.get(live.id);
    if (gateway) {
      pauseTaskClock(gateway, now().getTime());
      usage = taskUsageJson(gateway);
    }
    const shown = live.remoteUnconfirmed ? "remote_unconfirmed" : error;
    chat.updateTask(scope, live.id, {
      state,
      error: shown,
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
    holdRun(taskId, true);
    chat.updateTask(userScope(userId), taskId, { state: "waiting_input", error: null });
    const task = chat.findTask(userScope(userId), taskId);
    if (task?.conversationId) publishTask(userId, task.conversationId, taskId);
  }

  function markRunning(userId: string, taskId: string): void {
    holdRun(taskId, false);
    chat.updateTask(userScope(userId), taskId, { state: "running", error: null });
    const task = chat.findTask(userScope(userId), taskId);
    if (task?.conversationId) publishTask(userId, task.conversationId, taskId);
  }

  function holdRun(taskId: string, waiting: boolean): void {
    const task = deps.tasks.get(taskId);
    if (!task || !holdTaskClock(task, waiting, now().getTime())) return;
    chat.updateTask(userScope(task.userId), taskId, { usageJson: taskUsageJson(task) });
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
    const view = messageView(row);
    if (!userShowsProcess(deps.db, scope)) {
      const tasks = (chat.listTasks(scope, conversationId) ?? []).map(taskView);
      const messages = (chat.listMessages(scope, conversationId) ?? []).map(messageView);
      const redacted = redactMessage(view, messages, tasks, false);
      if (!redacted) return;
      deps.hub.publish(conversationId, { type: "message", conversationId, message: redacted });
      return;
    }
    deps.hub.publish(conversationId, { type: "message", conversationId, message: view });
  }

  function publishTask(userId: string, conversationId: string | null, taskId: string): void {
    if (!conversationId) return;
    const row = chat.findTask(userScope(userId), taskId);
    if (!row) return;
    deps.hub.publish(conversationId, { type: "task", conversationId, task: taskView(row) });
  }

  function publishStep(conversationId: string, step: StepRecord): void {
    const owner = deps.db.$client.prepare("select b.user_id as userId from conversations c join bots b on b.id=c.bot_id where c.id=?").get(conversationId) as { userId: string } | undefined;
    const detail = owner ? userShowsProcess(deps.db, userScope(owner.userId)) : false;
    deps.hub.publish(conversationId, { type: "step", conversationId, step: redactStep(stepView(step), detail) });
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

export type ChatService = ReturnType<typeof createChatService>;
