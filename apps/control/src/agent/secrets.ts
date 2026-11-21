import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { lit, obj, str, union } from "@earendil-works/pi-schema";
import { encrypt, decrypt } from "../crypto.js";
import type { AppDatabase } from "../db/index.js";
import { secretRepository } from "../db/secrets.js";
import { ulid } from "../id.js";
import { userScope, type UserScope } from "../scope.js";
import { maskSecrets } from "./text.js";

const NAME = /^[a-z0-9_]+$/;
const PLACEHOLDER = /\{\{secret:([a-z0-9_]+)\}\}/g;
const PLACEHOLDER_TEST = /\{\{secret:[a-z0-9_]+\}\}/;

export type SecretKind = "password" | "otp" | "text";
export type WaitOutcome = "provided" | "rejected" | "timeout" | "stopped" | "detached";

export interface SecretRequest {
  name: string;
  label: string;
  kind: SecretKind;
  reason: string;
}

export interface SecretSubmission {
  decision: "provide" | "reject";
  name: string;
  value?: string;
  save?: boolean;
}

export class SecretError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "SecretError";
  }
}

export function parseSecretRequest(params: { name?: string; label?: string; kind?: string; reason?: string }): SecretRequest {
  const name = params.name?.trim() ?? "";
  const label = params.label?.trim() ?? "";
  const reason = params.reason?.trim() ?? "";
  if (!NAME.test(name) || name.length > 64) throw new SecretError("密钥名字只能是小写字母、数字和下划线", 400);
  if (label.length === 0 || label.length > 200) throw new SecretError("说明不能为空", 400);
  if (reason.length === 0 || reason.length > 500) throw new SecretError("原因不能为空", 400);
  if (params.kind !== "password" && params.kind !== "otp" && params.kind !== "text") {
    throw new SecretError("kind 只能是 password、otp 或 text", 400);
  }
  return { name, label, kind: params.kind, reason };
}

const secretSchema = obj({
  name: str({ description: "密钥名字，只能是小写字母、数字和下划线" }),
  label: str({ description: "给用户看的说明" }),
  kind: union([lit("password"), lit("otp"), lit("text")], { description: "password、otp 或 text" }),
  reason: str({ description: "为什么需要这个值" }),
});

export function createSecretTool(wait: (request: SecretRequest) => Promise<WaitOutcome>): AgentTool<typeof secretSchema> {
  return {
    name: "request_secret",
    label: "请求密钥",
    description:
      "向用户要密码、验证码或一段文本。结果里只有 {{secret:NAME}} 占位符，没有值。已保存的名字也会重新弹表单并覆盖旧值。otp 不保存。",
    parameters: secretSchema,
    execute: async (_id, params) => {
      const request = parseSecretRequest(params);
      const outcome = await wait(request);
      if (outcome === "detached") {
        return { content: [{ type: "text", text: "仍在等待用户输入" }], details: {}, terminate: true };
      }
      if (outcome === "timeout") {
        return { content: [{ type: "text", text: "等待用户输入超时" }], details: {}, isError: true, terminate: true };
      }
      if (outcome === "stopped") {
        return { content: [{ type: "text", text: "用户停止了任务" }], details: {}, isError: true, terminate: true };
      }
      if (outcome === "rejected") {
        return { content: [{ type: "text", text: "用户拒绝提供" }], details: {}, isError: true };
      }
      return { content: [{ type: "text", text: `已提供，用 {{secret:${request.name}}} 引用` }], details: {} };
    },
  };
}

interface Waiter {
  userId: string;
  request: SecretRequest;
  resolve: (outcome: WaitOutcome) => void;
  timer: NodeJS.Timeout;
}

export interface SecretBrokerDeps {
  db: AppDatabase;
  key: Buffer;
  waitMs: number;
  now: () => Date;
  onWaiting: (userId: string, taskId: string) => void;
  onRunning: (userId: string, taskId: string) => void;
  onResume: (userId: string, taskId: string, text: string, isError: boolean) => void;
  onFail: (userId: string, taskId: string, error: string) => void;
}

export function createSecretBroker(deps: SecretBrokerDeps) {
  const waiters = new Map<string, Waiter>();
  const memory = new Map<string, Map<string, string>>();
  const armed = new Map<string, NodeJS.Timeout>();
  const store = secretRepository(deps.db);

  return {
    wait(userId: string, taskId: string, request: SecretRequest): Promise<WaitOutcome> {
      clearArm(taskId);
      deps.onWaiting(userId, taskId);
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(taskId, "timeout"), deps.waitMs);
        timer.unref?.();
        waiters.set(taskId, { userId, request, resolve, timer });
      });
    },
    settle(taskId: string, outcome: WaitOutcome): void {
      finish(taskId, outcome);
    },
    pending(taskId: string): SecretRequest | undefined {
      return waiters.get(taskId)?.request;
    },
    submit(scope: UserScope, taskId: string, request: SecretRequest, body: SecretSubmission): void {
      if (body.name !== request.name) throw new SecretError("密钥名字不匹配", 400);
      if (body.decision === "reject") {
        if (waiters.has(taskId)) finish(taskId, "rejected");
        else {
          clearArm(taskId);
          deps.onResume(scope.userId, taskId, "用户拒绝提供", true);
        }
        return;
      }
      const value = body.value ?? "";
      if (value.length === 0 || value.length > 4096) throw new SecretError("需要填写内容", 400);
      const save = request.kind === "otp" ? false : (body.save ?? request.kind === "password");
      remember(scope, taskId, request, value, save);
      if (waiters.has(taskId)) finish(taskId, "provided");
      else {
        clearArm(taskId);
        deps.onResume(scope.userId, taskId, `已提供，用 {{secret:${request.name}}} 引用`, false);
      }
    },
    lookup(userId: string, taskId: string, name: string): string | undefined {
      const held = memory.get(taskId)?.get(name);
      if (held !== undefined) return held;
      const row = store.find(userScope(userId), name);
      if (!row) return undefined;
      return decrypt(deps.key, row.valueEnc);
    },
    known(userId: string, taskId: string): Array<{ name: string; value: string }> {
      const values = new Map<string, string>();
      for (const row of store.list(userScope(userId))) {
        try {
          values.set(row.name, decrypt(deps.key, row.valueEnc));
        } catch {
          // 坏掉的密文不能参与打码，也不能让任务停下来。
        }
      }
      for (const [name, value] of memory.get(taskId) ?? []) values.set(name, value);
      return [...values].map(([name, value]) => ({ name, value }));
    },
    names(userId: string): string[] {
      return store
        .list(userScope(userId))
        .map((row) => row.name)
        .sort();
    },
    remember(taskId: string, name: string, value: string): void {
      let bag = memory.get(taskId);
      if (!bag) {
        bag = new Map();
        memory.set(taskId, bag);
      }
      bag.set(name, value);
    },
    drop(taskId: string): void {
      memory.delete(taskId);
      clearArm(taskId);
      const waiter = waiters.get(taskId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiters.delete(taskId);
    },
    arm(tasks: Array<{ id: string; userId: string; waitStartedAt: string | null }>): void {
      for (const task of tasks) {
        const started = task.waitStartedAt ? Date.parse(task.waitStartedAt) : deps.now().getTime();
        const remain = deps.waitMs - (deps.now().getTime() - started);
        if (!(remain > 0)) {
          deps.onFail(task.userId, task.id, "等待用户输入超时");
          continue;
        }
        const timer = setTimeout(() => {
          armed.delete(task.id);
          if (waiters.has(task.id)) return;
          deps.onFail(task.userId, task.id, "等待用户输入超时");
        }, remain);
        timer.unref?.();
        armed.set(task.id, timer);
      }
    },
    close(): void {
      for (const timer of armed.values()) clearTimeout(timer);
      armed.clear();
      for (const waiter of waiters.values()) clearTimeout(waiter.timer);
      waiters.clear();
    },
  };

  function finish(taskId: string, outcome: WaitOutcome): void {
    const waiter = waiters.get(taskId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiters.delete(taskId);
    clearArm(taskId);
    if (outcome === "provided" || outcome === "rejected") deps.onRunning(waiter.userId, taskId);
    waiter.resolve(outcome);
  }

  function clearArm(taskId: string): void {
    const timer = armed.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    armed.delete(taskId);
  }

  function remember(scope: UserScope, taskId: string, request: SecretRequest, value: string, save: boolean): void {
    let bag = memory.get(taskId);
    if (!bag) {
      bag = new Map();
      memory.set(taskId, bag);
    }
    bag.set(request.name, value);
    if (!save || request.kind === "otp") return;
    store.upsert(scope, {
      id: ulid(deps.now().getTime()),
      name: request.name,
      valueEnc: encrypt(deps.key, value),
      scope: "browser",
    });
  }
}

export type SecretBroker = ReturnType<typeof createSecretBroker>;

interface PreparedArgs {
  params: unknown;
  missing?: string;
  skipped: string[];
}

/** 只替换允许的字段。其他字段里的占位符原样留下。 */
export function substituteArgs(tool: string, params: unknown, lookup: (name: string) => string | undefined): PreparedArgs {
  const skipped: string[] = [];
  let missing: string | undefined;
  const paramsCopy = clone(params);
  const replaced = walk(tool, paramsCopy, "", (name) => lookup(name), skipped, (name) => {
    missing ??= name;
  });
  return { params: replaced, skipped, ...(missing !== undefined ? { missing } : {}) };
}

export function bindSecrets(tools: AgentTool[], lookup: (name: string) => string | undefined): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // install_mcp 自己解析占位符。这里替换会让步骤里的原文变成明文。
      if (tool.name === "install_mcp") return tool.execute(toolCallId, params, signal, onUpdate);
      const prepared = substituteArgs(tool.name, params, lookup);
      if (prepared.missing) {
        return {
          content: [{ type: "text", text: `密钥 ${prepared.missing} 不存在` }],
          details: {},
          isError: true,
        };
      }
      let result: AgentToolResult;
      try {
        result = await tool.execute(toolCallId, prepared.params as never, signal, onUpdate);
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : "工具失败";
        result = { content: [{ type: "text", text: message }], details: {}, isError: true };
      }
      if (prepared.skipped.length === 0) return result;
      const note = `字段 ${prepared.skipped.join("、")} 不支持密钥占位符，已原样保留`;
      const content = result.content.map((block, index) =>
        index === 0 && block.type === "text" ? { ...block, text: `${block.text}\n${note}` } : block,
      );
      if (!content.some((block) => block.type === "text")) content.unshift({ type: "text", text: note });
      return { ...result, content };
    },
  }));
}

export function maskToolContent(content: AgentToolResult["content"], secrets: Array<{ name: string; value: string }>) {
  return content.map((block) => (block.type === "text" ? { ...block, text: maskSecrets(block.text, secrets) } : block));
}

function walk(
  tool: string,
  value: unknown,
  path: string,
  lookup: (name: string) => string | undefined,
  skipped: string[],
  miss: (name: string) => void,
): unknown {
  if (typeof value === "string") return replaceString(tool, path, value, lookup, skipped, miss);
  if (Array.isArray(value)) return value.map((item, index) => walk(tool, item, `${path}[${index}]`, lookup, skipped, miss));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const child = path.length === 0 ? key : `${path}.${key}`;
    if (tool === "shell_exec" && path === "env" && PLACEHOLDER_TEST.test(key)) skipped.push(child);
    output[key] = walk(tool, item, child, lookup, skipped, miss);
  }
  return output;
}

function replaceString(
  tool: string,
  path: string,
  value: string,
  lookup: (name: string) => string | undefined,
  skipped: string[],
  miss: (name: string) => void,
): string {
  if (!value.includes("{{secret:")) return value;
  if (!allowed(tool, path)) {
    skipped.push(path);
    return value;
  }
  PLACEHOLDER.lastIndex = 0;
  return value.replace(PLACEHOLDER, (full, name: string) => {
    const found = lookup(name);
    if (found === undefined) {
      miss(name);
      return full;
    }
    return found;
  });
}

function allowed(tool: string, path: string): boolean {
  if (tool === "browser_type" && path === "text") return true;
  if (tool === "fs_write" && path === "content") return true;
  if (tool === "shell_exec" && path.startsWith("env.")) return true;
  return false;
}

function clone(value: unknown): unknown {
  if (value === undefined) return undefined;
  return structuredClone(value);
}
