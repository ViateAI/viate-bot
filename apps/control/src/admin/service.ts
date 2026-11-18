import type { AssistantMessage } from "@earendil-works/pi-ai";
import { storedContent } from "../agent/view.js";
import { BotRejected, createBot, deleteBot, type BotServiceDeps } from "../bot-service.js";
import type { ControlConfig } from "../config.js";
import { auditRepository } from "../db/audit.js";
import { adminRepository } from "../db/admin.js";
import { botRepository } from "../db/bots.js";
import { chatRepository } from "../db/chat.js";
import { identityRepository } from "../db/identities.js";
import type { AppDatabase } from "../db/index.js";
import { machineRepository, type MachineAdminRecord } from "../db/machines.js";
import { memoryRepository } from "../db/memories.js";
import { quotaRepository, type QuotaDraft, type QuotaPatch } from "../db/quotas.js";
import { settingsRepository, type BotTemplate } from "../db/settings.js";
import { userRepository, type UserRecord } from "../db/users.js";
import { ulid } from "../id.js";
import { devSpec } from "../runtime.js";
import type { MachineSpec } from "../machines/policy.js";
import type { CredentialProvider, Directory, ModelPolicy } from "../providers.js";
import { adminScope, userScope, type AdminScope } from "../scope.js";
import { normalizeEmail } from "../login.js";

export class AdminRejected extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AdminRejected";
  }
}

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  void settled.finally(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return run;
}

export interface MachineControl {
  start(userId: string): Promise<void>;
  stop(userId: string): Promise<void>;
  restart(userId: string): Promise<void>;
  rebuild(userId: string, spec: MachineSpec): Promise<void>;
  /** 只删容器和网络，保留卷。 */
  remove(userId: string): Promise<void>;
  stats(userId: string): Promise<{ cpuPct: number; memMb: number }>;
}

export interface ProvisionInput {
  userId?: string;
  subject?: string;
  email?: string;
  name?: string;
  templateId: string;
  channelId?: string;
  model?: string;
  spec?: MachineSpec;
  maxBots?: number;
  maxConcurrentTasks?: number;
  maxRoutines?: number;
  /** null 或省略表示不覆盖全局预算。 */
  taskTokenBudget?: number | null;
}

export interface ProvisionDeps {
  db: AppDatabase;
  key: Buffer;
  credentials: CredentialProvider;
  directory: Directory;
  providerId: string;
  config: ControlConfig;
  ensureMachine: (userId: string, spec?: MachineSpec) => Promise<void>;
  waitHealthy: (userId: string) => Promise<void>;
  deleteMachine: (userId: string) => Promise<void>;
  now?: () => Date;
}

export async function provisionUser(deps: ProvisionDeps, scope: AdminScope, input: ProvisionInput) {
  let user: UserRecord;
  try {
    user = resolveUser(deps, input);
  } catch (error) {
    auditRepository(deps.db).write(scope, "user.provision", input.userId || input.subject || "unknown", { ok: false });
    throw error;
  }
  return withLock(user.id, () => provisionLocked(deps, scope, input, user));
}

async function provisionLocked(deps: ProvisionDeps, scope: AdminScope, input: ProvisionInput, user: UserRecord) {
  const audit = auditRepository(deps.db);
  const quotas = quotaRepository(deps.db);
  let userId = "";
  let botId = "";
  let quotaInserted = false;
  let machineAttempted = false;
  let machineExisted = false;
  try {
    userId = user.id;
    const userScopeFor = userScope(user.id);
    if (quotas.find(userScopeFor)) throw new AdminRejected("已经开通", 409);
    const template = settingsRepository(deps.db)
      .templates()
      .find((item) => item.id === input.templateId);
    if (!template) throw new AdminRejected("找不到模板", 404);
    const model = input.model?.trim() || template.defaultModel.trim() || deps.config.models[0];
    if (!model) throw new AdminRejected("没有可用模型，请管理员在模板里设置默认模型或配置 VB_MODELS", 400);
    if (deps.config.models.length > 0 && !deps.config.models.includes(model)) {
      throw new AdminRejected(`模型不在白名单内: ${model}`, 400);
    }
    const spec = input.spec ?? devSpec;
    assertSpec(spec);
    const taskTokenBudget = readTaskTokenBudget(input.taskTokenBudget);
    const quota: QuotaDraft = {
      maxBots: positive(input.maxBots, deps.config.defaultMaxBots, "maxBots"),
      spec,
      maxConcurrentTasks: positive(input.maxConcurrentTasks, deps.config.defaultMaxConcurrentTasks, "maxConcurrentTasks"),
      maxRoutines: nonNegative(input.maxRoutines, deps.config.defaultMaxRoutines, "maxRoutines"),
      ...(taskTokenBudget === undefined ? {} : { taskTokenBudget }),
    };
    const channelId = await resolveChannel(deps, user.id, input.channelId);
    const machines = machineRepository(deps.db);
    const before = machines.find(userScopeFor);
    machineExisted = Boolean(before && before.state !== "deleted");
    const botDeps: BotServiceDeps = {
      db: deps.db,
      key: deps.key,
      credentials: deps.credentials,
      providerId: deps.providerId,
      allowModel: (candidate) => deps.config.models.length === 0 || deps.config.models.includes(candidate),
      maxBots: () => quota.maxBots,
      ensureMachine: async (id) => {
        machineAttempted = true;
        await deps.ensureMachine(id, spec);
      },
    };
    const bot = await createBot(botDeps, userScopeFor, {
      name: template.name,
      model,
      instructions: template.instructions,
      ...(channelId ? { policyRef: channelId } : {}),
    });
    botId = bot.id;
    const memories = memoryRepository(deps.db);
    for (const content of template.initialMemories) {
      memories.save(userScopeFor, bot.id, { id: ulid(), content, sourceTaskId: null });
    }
    await deps.waitHealthy(user.id);
    writeWelcome(deps.db, user.id, bot.id, template, model, deps.now ?? (() => new Date()));
    if (!quotas.insert(scope, user.id, quota)) throw new AdminRejected("已经开通", 409);
    quotaInserted = true;
    audit.write(scope, "user.provision", user.id, { botId: bot.id, templateId: template.id, ok: true });
    return {
      userId: user.id,
      botId: bot.id,
      email: user.email,
      model,
      quota: {
        maxBots: quota.maxBots,
        maxConcurrentTasks: quota.maxConcurrentTasks,
        maxRoutines: quota.maxRoutines,
        taskTokenBudget: quota.taskTokenBudget ?? null,
      },
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (botId) {
      try {
        await deleteBot(
          { db: deps.db, key: deps.key, credentials: deps.credentials, providerId: deps.providerId },
          userScope(userId),
          botId,
        );
      } catch {
        rollbackErrors.push("凭据吊销失败");
        botRepository(deps.db).softDelete(userScope(userId), botId);
      }
    }
    if (machineAttempted && !machineExisted) {
      try {
        await deps.deleteMachine(userId);
      } catch {
        rollbackErrors.push("机器删除失败");
      }
    }
    if (quotaInserted) quotas.remove(scope, userId);
    const original = error instanceof Error ? error.message : "开通失败";
    const message = rollbackErrors.length > 0 ? `${original}；回滚未完成：${rollbackErrors.join("、")}` : original;
    const target = userId || input.userId || input.subject || "unknown";
    audit.write(scope, "user.provision", target, { ok: false, error: message.slice(0, 200) });
    if (rollbackErrors.length === 0 && (error instanceof AdminRejected || error instanceof BotRejected)) throw error;
    throw new AdminRejected(message, 503);
  }
}

function resolveUser(deps: ProvisionDeps, input: ProvisionInput): UserRecord {
  const users = userRepository(deps.db);
  const identities = identityRepository(deps.db);
  if (input.userId) {
    const user = users.findById(input.userId);
    if (!user) throw new AdminRejected("找不到用户", 404);
    if (input.subject) {
      const existing = identities.find(deps.providerId, input.subject);
      if (!existing || existing.userId !== user.id) throw new AdminRejected("不能为已有用户绑定新的外部身份", 409);
    }
    return user;
  }
  if (!input.subject) {
    if (deps.config.integration === "viate") throw new AdminRejected("需要本地用户或目录 subject", 400);
    const email = normalizeEmail(input.email ?? "");
    if (!email) throw new AdminRejected("需要本地用户或邮箱", 400);
    const matches = users.findByEmail(email);
    if (matches.length > 1) throw new AdminRejected("邮箱对应多个用户，请明确选择用户", 409);
    const existing = matches[0];
    if (existing) return existing;
    return users.insert({ id: ulid(), email, name: input.name?.trim() || email, status: "active", isAdmin: false });
  }
  const existing = identities.find(deps.providerId, input.subject);
  if (existing) {
    const user = users.findById(existing.userId);
    if (!user) throw new AdminRejected("找不到用户", 404);
    return user;
  }
  const email = normalizeEmail(input.email ?? "");
  const name = input.name?.trim() ?? "";
  if (!email || !name) throw new AdminRejected("开通目录用户需要邮箱和名字", 400);
  const created = users.insert({
    id: ulid(),
    email,
    name,
    status: "active",
    isAdmin: false,
  });
  identities.insert({
    provider: deps.providerId,
    subject: input.subject,
    userId: created.id,
    email,
    emailVerified: false,
  });
  return created;
}

async function resolveChannel(deps: ProvisionDeps, userId: string, requested: string | undefined): Promise<string | undefined> {
  const settings = settingsRepository(deps.db);
  const chosen = requested?.trim() || settings.defaultChannel() || undefined;
  if (!deps.credentials.listPolicies) return chosen;
  const subject = identityRepository(deps.db).findByUser(userId, deps.providerId)?.subject ?? null;
  let policies: ModelPolicy[];
  try {
    policies = await deps.credentials.listPolicies({ subject });
  } catch (error) {
    const message = error instanceof Error ? error.message : "查询渠道失败";
    throw new AdminRejected(message, 503);
  }
  if (policies.length === 0) return chosen;
  if (chosen && policies.some((item) => item.id === chosen)) return chosen;
  if (!requested && !settings.defaultChannel()) return policies[0]?.id;
  throw new AdminRejected("渠道不在该用户已授权范围内", 400);
}

function writeWelcome(db: AppDatabase, userId: string, botId: string, template: BotTemplate, model: string, now: () => Date): void {
  const chat = chatRepository(db);
  const scope = userScope(userId);
  const welcome = template.welcome.trim() || `你好，我是${template.name}。`;
  const conversation = chat.insertConversation(scope, { id: ulid(), botId, title: "欢迎" });
  if (!conversation) throw new AdminRejected("找不到 bot", 404);
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: welcome }],
    api: "openai-completions",
    provider: "viate-bot",
    model,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: now().getTime(),
  };
  const row = chat.insertMessage(scope, {
    id: ulid(),
    conversationId: conversation.id,
    role: "assistant",
    contentJson: storedContent(message, welcome),
    taskId: null,
  });
  if (!row) throw new AdminRejected("欢迎消息没有写上", 500);
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export interface AdminUserRow {
  id: string | null;
  email: string;
  name: string;
  status: string;
  provisioned: boolean;
  machineState: string | null;
  botCount: number;
  tasks7d: number;
  subject: string | null;
  maxBots: number | null;
  maxConcurrentTasks: number | null;
  maxRoutines: number | null;
  taskTokenBudget: number | null;
  showProcess: boolean;
}

export async function listAdminUsers(
  deps: Pick<ProvisionDeps, "db" | "directory" | "providerId">,
  scope: AdminScope,
  limit: number,
): Promise<{ users: AdminUserRow[]; truncated: boolean }> {
  const admin = adminRepository(deps.db);
  const identities = identityRepository(deps.db);
  const quotas = quotaRepository(deps.db);
  const machines = machineRepository(deps.db);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = new Map<string, AdminUserRow>();
  for (const user of admin.listUsers(scope)) {
    const identity = identities.findByUser(user.id, deps.providerId);
    const machine = machines.find(userScope(user.id));
    const quota = quotas.find(userScope(user.id));
    rows.set(user.id, {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      provisioned: quota !== undefined,
      machineState: machine && machine.state !== "deleted" ? machine.state : null,
      botCount: admin.countBots(scope, user.id),
      tasks7d: admin.countTasksSince(scope, user.id, since),
      subject: identity?.subject ?? null,
      maxBots: quota?.maxBots ?? null,
      maxConcurrentTasks: quota?.maxConcurrentTasks ?? null,
      maxRoutines: quota?.maxRoutines ?? null,
      taskTokenBudget: quota?.taskTokenBudget ?? null,
      showProcess: user.showProcess,
    });
  }
  if (deps.directory.listUsers) {
    const remote = await collectDirectory(deps.directory);
    for (const item of remote) {
      const identity = identities.find(deps.providerId, item.subject);
      if (identity && rows.has(identity.userId)) {
        const row = rows.get(identity.userId);
        if (row && !row.subject) row.subject = item.subject;
        continue;
      }
      rows.set(`dir:${item.subject}`, {
        id: null,
        email: item.email,
        name: item.name,
        status: item.status,
        provisioned: false,
        machineState: null,
        botCount: 0,
        tasks7d: 0,
        subject: item.subject,
        maxBots: null,
        maxConcurrentTasks: null,
        maxRoutines: null,
        taskTokenBudget: null,
        showProcess: false,
      });
    }
  }
  const all = [...rows.values()].sort((left, right) => left.email.localeCompare(right.email));
  return { users: all.slice(0, limit), truncated: all.length > limit };
}

async function collectDirectory(directory: Directory) {
  if (!directory.listUsers) return [];
  const users = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page += 1) {
    const result = await directory.listUsers(cursor);
    users.push(...result.users);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return users;
}

export function updateQuota(db: AppDatabase, scope: AdminScope, userId: string, patch: QuotaPatch): void {
  const admin = adminRepository(db);
  if (!admin.findUser(scope, userId)) throw new AdminRejected("找不到用户", 404);
  if (patch.spec) assertSpec(patch.spec);
  if (patch.maxBots !== undefined) positive(patch.maxBots, patch.maxBots, "maxBots");
  if (patch.maxConcurrentTasks !== undefined) positive(patch.maxConcurrentTasks, patch.maxConcurrentTasks, "maxConcurrentTasks");
  if (patch.maxRoutines !== undefined) nonNegative(patch.maxRoutines, patch.maxRoutines, "maxRoutines");
  if ("taskTokenBudget" in patch) {
    const value = patch.taskTokenBudget;
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
      throw new AdminRejected("token 预算必须是非负整数", 400);
    }
  }
  const quotas = quotaRepository(db);
  if (!quotas.find(userScope(userId))) throw new AdminRejected("用户尚未开通", 404);
  if (!quotas.update(scope, userId, patch)) throw new AdminRejected("找不到配额", 404);
  auditRepository(db).write(scope, "quota.update", userId, {
    ...(patch.maxBots !== undefined ? { maxBots: patch.maxBots } : {}),
    ...(patch.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: patch.maxConcurrentTasks } : {}),
    ...(patch.maxRoutines !== undefined ? { maxRoutines: patch.maxRoutines } : {}),
    ...("taskTokenBudget" in patch ? { taskTokenBudget: patch.taskTokenBudget ?? null } : {}),
    ...(patch.spec ? { spec: patch.spec } : {}),
  });
}

export interface TemplateInput {
  name?: string;
  description?: string;
  instructions?: string;
  defaultModel?: string;
  initialMemories?: string[];
  welcome?: string;
}

export function createTemplate(db: AppDatabase, scope: AdminScope, input: TemplateInput): BotTemplate {
  const template = normalizeTemplate(ulid(), input, true);
  const settings = settingsRepository(db);
  const next = [...settings.templates(), template];
  settings.saveTemplates(next);
  auditRepository(db).write(scope, "template.create", template.id, { name: template.name });
  return template;
}

export function updateTemplate(db: AppDatabase, scope: AdminScope, id: string, input: TemplateInput): BotTemplate {
  const settings = settingsRepository(db);
  const current = settings.templates();
  const index = current.findIndex((item) => item.id === id);
  const existing = current[index];
  if (!existing) throw new AdminRejected("找不到模板", 404);
  const template = normalizeTemplate(id, { ...existing, ...input }, true);
  const next = current.slice();
  next[index] = template;
  settings.saveTemplates(next);
  auditRepository(db).write(scope, "template.update", id, { name: template.name });
  return template;
}

export function deleteTemplate(db: AppDatabase, scope: AdminScope, id: string): void {
  const settings = settingsRepository(db);
  const current = settings.templates();
  if (!current.some((item) => item.id === id)) throw new AdminRejected("找不到模板", 404);
  settings.saveTemplates(current.filter((item) => item.id !== id));
  auditRepository(db).write(scope, "template.delete", id, {});
}

function normalizeTemplate(id: string, input: TemplateInput, requireName: boolean): BotTemplate {
  const name = input.name?.trim() ?? "";
  if (requireName && !name) throw new AdminRejected("模板需要名字", 400);
  const memories = input.initialMemories ?? [];
  if (!Array.isArray(memories) || memories.some((item) => typeof item !== "string")) {
    throw new AdminRejected("初始记忆必须是字符串列表", 400);
  }
  if (memories.length > 50) throw new AdminRejected("初始记忆最多 50 条", 400);
  if (memories.some((item) => [...item].length > 2000)) throw new AdminRejected("单条初始记忆最长 2000 字符", 400);
  return {
    id,
    name,
    description: input.description?.trim() ?? "",
    instructions: input.instructions ?? "",
    defaultModel: input.defaultModel?.trim() ?? "",
    initialMemories: memories,
    welcome: input.welcome?.trim() || `你好，我是${name}。`,
  };
}

export function updateSettings(
  db: AppDatabase,
  scope: AdminScope,
  patch: { defaultChannel?: string | null; platformPrompt?: string },
): { defaultChannel: string | null; platformPrompt: { version: number; text: string } } {
  const settings = settingsRepository(db);
  if (patch.defaultChannel !== undefined) {
    const value = patch.defaultChannel === null ? null : patch.defaultChannel.trim();
    settings.setDefaultChannel(value && value.length > 0 ? value : null);
  }
  let prompt = settings.platformPrompt();
  if (patch.platformPrompt !== undefined) {
    const text = patch.platformPrompt.trim();
    if (!text) throw new AdminRejected("平台提示词不能为空", 400);
    prompt = settings.setPlatformPrompt(text);
  }
  auditRepository(db).write(scope, "settings.update", "settings", {
    ...(patch.defaultChannel !== undefined ? { defaultChannel: settings.defaultChannel() } : {}),
    ...(patch.platformPrompt !== undefined ? { platformPromptVersion: prompt.version } : {}),
  });
  return { defaultChannel: settings.defaultChannel(), platformPrompt: prompt };
}

export async function listMachines(db: AppDatabase, scope: AdminScope) {
  const admin = adminRepository(db);
  const machines = machineRepository(db).listAdmin(scope);
  return machines.map((machine) => ({
    ...publicMachine(machine),
    email: admin.findUser(scope, machine.userId)?.email ?? "",
  }));
}

export async function machineStats(control: MachineControl, db: AppDatabase, scope: AdminScope, id: string) {
  const machine = requireMachine(db, scope, id);
  try {
    return await control.stats(machine.userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取占用失败";
    throw new AdminRejected(message, 503);
  }
}

export async function startMachine(control: MachineControl, db: AppDatabase, scope: AdminScope, id: string) {
  const machine = requireMachine(db, scope, id);
  await control.start(machine.userId);
  auditRepository(db).write(scope, "machine.start", machine.id, { userId: machine.userId });
}

export async function stopMachine(control: MachineControl, db: AppDatabase, scope: AdminScope, id: string) {
  const machine = requireMachine(db, scope, id);
  await control.stop(machine.userId);
  auditRepository(db).write(scope, "machine.stop", machine.id, { userId: machine.userId });
}

export async function restartMachine(control: MachineControl, db: AppDatabase, scope: AdminScope, id: string) {
  const machine = requireMachine(db, scope, id);
  await control.restart(machine.userId);
  auditRepository(db).write(scope, "machine.restart", machine.id, { userId: machine.userId });
}

export async function rebuildMachine(control: MachineControl, db: AppDatabase, scope: AdminScope, id: string) {
  const machine = requireMachine(db, scope, id);
  if (adminRepository(db).countActiveTasks(scope, machine.userId) > 0) {
    auditRepository(db).write(scope, "machine.rebuild.rejected", machine.id, { userId: machine.userId, reason: "task" });
    throw new AdminRejected("有任务正在运行，不能重建机器", 409);
  }
  const quota = quotaRepository(db).find(userScope(machine.userId));
  const spec = quota?.spec ?? machine.spec;
  await control.rebuild(machine.userId, spec);
  const rebuilt = requireMachine(db, scope, id);
  auditRepository(db).write(scope, "machine.rebuild", machine.id, { userId: machine.userId, image: rebuilt.imageVersion });
}

export async function deleteMachine(control: MachineControl, db: AppDatabase, scope: AdminScope, id: string, email: string) {
  const machine = requireMachine(db, scope, id);
  const user = adminRepository(db).findUser(scope, machine.userId);
  const expected = user?.email ?? "";
  if (normalizeEmail(email) === null || normalizeEmail(email) !== normalizeEmail(expected)) {
    auditRepository(db).write(scope, "machine.delete.rejected", machine.id, { userId: machine.userId, reason: "email" });
    throw new AdminRejected("需要输入该用户的邮箱以确认删除", 400);
  }
  const active = adminRepository(db).countActiveTasks(scope, machine.userId);
  if (active > 0) {
    auditRepository(db).write(scope, "machine.delete.rejected", machine.id, { userId: machine.userId, reason: "task" });
    throw new AdminRejected("有任务正在运行，不能删除机器", 409);
  }
  await control.remove(machine.userId);
  auditRepository(db).write(scope, "machine.delete", machine.id, { userId: machine.userId });
}

function requireMachine(db: AppDatabase, scope: AdminScope, id: string): MachineAdminRecord {
  const machine = machineRepository(db).findAdmin(scope, id);
  if (!machine || machine.state === "deleted") throw new AdminRejected("找不到机器", 404);
  return machine;
}

function publicMachine(machine: MachineAdminRecord) {
  return {
    id: machine.id,
    userId: machine.userId,
    state: machine.state,
    spec: machine.spec,
    image: machine.imageVersion,
    createdAt: machine.createdAt,
    lastHeartbeatAt: machine.lastHeartbeatAt,
    statusDetail: machine.statusDetail,
  };
}

function assertSpec(spec: MachineSpec): void {
  if (!Number.isFinite(spec.cpu) || spec.cpu <= 0) throw new AdminRejected("cpu 必须是正数", 400);
  if (!Number.isFinite(spec.memMb) || spec.memMb <= 0) throw new AdminRejected("memMb 必须是正数", 400);
  if (!Number.isFinite(spec.diskGb) || spec.diskGb <= 0) throw new AdminRejected("diskGb 必须是正数", 400);
}

function readTaskTokenBudget(value: number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new AdminRejected("taskTokenBudget 必须是非负整数", 400);
  return value;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new AdminRejected(`${label} 必须是正整数`, 400);
  return resolved;
}

function nonNegative(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) throw new AdminRejected(`${label} 必须是非负整数`, 400);
  return resolved;
}

export function actorScope(actorUserId: string): AdminScope {
  return adminScope(actorUserId);
}
