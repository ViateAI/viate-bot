import { join } from "node:path";

export type IntegrationName = "none" | "viate";
export type ModelApi = "openai-completions" | "openai-responses";

/** 只在 VB_INTEGRATION=viate 时从环境变量读入。缺项留空，启动时不报错。 */
export interface ServiceCredentials {
  url: string;
  clientId: string;
  clientSecret: string;
}

export interface ControlConfig {
  publicUrl: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  allowSignup: boolean;
  oidcTrustEmail: boolean;
  modelBaseUrl: string;
  modelApiKey: string;
  /** 为空表示不限制。非空时，网关和创建 bot 都只接受列表里的模型。 */
  models: string[];
  modelApi: ModelApi;
  modelMaxTokens: number;
  modelContextTokens: number;
  /** 上下文摘要单次输出上限。摘要请求仍走模型网关。 */
  summaryMaxTokens: number;
  taskTokenBudget: number;
  modelRateUserPerMin: number;
  modelRateBotPerMin: number;
  maxTaskSteps: number;
  maxTaskDurationSec: number;
  defaultMaxBots: number;
  defaultMaxConcurrentTasks: number;
  defaultMaxRoutines: number;
  integration: IntegrationName;
  serviceCredentials?: ServiceCredentials;
  adminEmails: string[];
  dataDir: string;
  machineImage: string;
  idleStopMinutes: number;
  maxRunningTasks: number;
  /** 空字符串表示 /metrics 拒绝所有请求。不要把空 token 当成开放。 */
  metricsToken: string;
  /** 支持把截图当图片读的模型。为空时不注册 browser_screenshot。 */
  visionModels: string[];
  /** request_secret 等待用户的毫秒数。超时后任务失败。 */
  secretWaitMs: number;
  port: number;
  dev: boolean;
  databasePath: string;
  secretKeyPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  const dataDir = env.VB_DATA_DIR?.trim() || "/data";
  const integration = integrationName(env);
  const config: ControlConfig = {
    publicUrl: optional(env, "VB_PUBLIC_URL", "http://127.0.0.1:3000"),
    oidcIssuer: optional(env, "VB_OIDC_ISSUER", ""),
    oidcClientId: optional(env, "VB_OIDC_CLIENT_ID", ""),
    oidcClientSecret: optional(env, "VB_OIDC_CLIENT_SECRET", ""),
    allowSignup: flag(env, "VB_ALLOW_SIGNUP", false),
    oidcTrustEmail: flag(env, "VB_OIDC_TRUST_EMAIL", false),
    modelBaseUrl: optional(env, "VB_MODEL_BASE_URL", ""),
    modelApiKey: optional(env, "VB_MODEL_API_KEY", ""),
    models: list(env, "VB_MODELS"),
    modelApi: modelApiName(env),
    modelMaxTokens: positive(env, "VB_MODEL_MAX_TOKENS", 4096),
    modelContextTokens: positive(env, "VB_MODEL_CONTEXT_TOKENS", 256_000),
    summaryMaxTokens: positive(env, "VB_SUMMARY_MAX_TOKENS", 2_000),
    taskTokenBudget: integer(env, "VB_TASK_TOKEN_BUDGET", 2_000_000),
    modelRateUserPerMin: integer(env, "VB_MODEL_RATE_USER", 120),
    modelRateBotPerMin: integer(env, "VB_MODEL_RATE_BOT", 60),
    maxTaskSteps: positive(env, "VB_MAX_TASK_STEPS", 16),
    maxTaskDurationSec: positive(env, "VB_MAX_TASK_DURATION_SEC", 600),
    defaultMaxBots: positive(env, "VB_DEFAULT_MAX_BOTS", 5),
    defaultMaxConcurrentTasks: positive(env, "VB_DEFAULT_MAX_CONCURRENT_TASKS", 2),
    defaultMaxRoutines: integer(env, "VB_DEFAULT_MAX_ROUTINES", 10),
    integration,
    adminEmails: (env.VB_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
    dataDir,
    machineImage: optional(env, "VB_MACHINE_IMAGE", "viate-bot/machine:dev"),
    idleStopMinutes: integer(env, "VB_IDLE_STOP_MINUTES", 120),
    maxRunningTasks: integer(env, "VB_MAX_RUNNING_TASKS", 20),
    metricsToken: optional(env, "VB_METRICS_TOKEN", ""),
    visionModels: list(env, "VB_VISION_MODELS"),
    secretWaitMs: positive(env, "VB_SECRET_WAIT_MS", 30 * 60 * 1000),
    port: integer(env, "VB_CONTROL_PORT", 3000),
    dev: env.VB_DEV === "1",
    databasePath: join(dataDir, "viate-bot.sqlite"),
    secretKeyPath: join(dataDir, "secret.key"),
  };
  if (integration === "viate") {
    config.serviceCredentials = {
      url: optional(env, "VB_VIATE_URL", ""),
      clientId: optional(env, "VB_VIATE_CLIENT_ID", ""),
      clientSecret: optional(env, "VB_VIATE_CLIENT_SECRET", ""),
    };
  }
  return config;
}

/** 登录流程调用。这一步还没有登录，所以缺变量不会在启动时抛出。 */
export function requireOidc(config: ControlConfig): { issuer: string; clientId: string; clientSecret: string } {
  if (config.oidcIssuer === "" || config.oidcClientId === "" || config.oidcClientSecret === "") {
    throw new Error("登录需要 VB_OIDC_ISSUER、VB_OIDC_CLIENT_ID 和 VB_OIDC_CLIENT_SECRET");
  }
  return {
    issuer: config.oidcIssuer,
    clientId: config.oidcClientId,
    clientSecret: config.oidcClientSecret,
  };
}

/** 模型网关调用。共享 key 还需要 VB_MODEL_API_KEY，由 requireSharedModelKey 单独检查。 */
export function requireModelBaseUrl(config: ControlConfig): string {
  if (config.modelBaseUrl === "") {
    throw new Error("调用模型需要 VB_MODEL_BASE_URL");
  }
  return config.modelBaseUrl;
}

export function requireSharedModelKey(config: ControlConfig): string {
  if (config.modelApiKey === "") {
    throw new Error("共享 key 模式需要 VB_MODEL_API_KEY");
  }
  return config.modelApiKey;
}

/** 服务接口调用。只有 VB_INTEGRATION=viate 才会读到这些变量。 */
export function requireServiceCredentials(config: ControlConfig): ServiceCredentials {
  const credentials = config.serviceCredentials;
  if (credentials === undefined) {
    throw new Error("服务接口只在 VB_INTEGRATION=viate 时读取");
  }
  if (credentials.url === "" || credentials.clientId === "" || credentials.clientSecret === "") {
    throw new Error("需要 VB_VIATE_URL、VB_VIATE_CLIENT_ID 和 VB_VIATE_CLIENT_SECRET");
  }
  return credentials;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim();
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数，收到 "${raw}"`);
  }
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} 必须是 true 或 false，收到 "${raw}"`);
}

function list(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = integer(env, name, fallback);
  if (value < 1) throw new Error(`${name} 必须是正整数，收到 "${value}"`);
  return value;
}

function modelApiName(env: NodeJS.ProcessEnv): ModelApi {
  const raw = env.VB_MODEL_API;
  if (raw === undefined || raw.trim() === "" || raw.trim() === "openai-completions") return "openai-completions";
  if (raw.trim() === "openai-responses") return "openai-responses";
  throw new Error(`VB_MODEL_API 必须是 openai-completions 或 openai-responses，收到 "${raw}"`);
}

function integrationName(env: NodeJS.ProcessEnv): IntegrationName {
  const raw = env.VB_INTEGRATION;
  if (raw === undefined || raw.trim() === "" || raw.trim() === "none") return "none";
  if (raw.trim() === "viate") return "viate";
  throw new Error(`VB_INTEGRATION 必须是 none 或 viate，收到 "${raw}"`);
}
