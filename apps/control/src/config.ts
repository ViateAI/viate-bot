import { join } from "node:path";

export type IntegrationName = "none" | "viate";

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
  integration: IntegrationName;
  serviceCredentials?: ServiceCredentials;
  adminEmails: string[];
  dataDir: string;
  machineImage: string;
  idleStopMinutes: number;
  maxRunningTasks: number;
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
    integration,
    adminEmails: (env.VB_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
    dataDir,
    machineImage: optional(env, "VB_MACHINE_IMAGE", "viate-bot/machine:dev"),
    idleStopMinutes: integer(env, "VB_IDLE_STOP_MINUTES", 120),
    maxRunningTasks: integer(env, "VB_MAX_RUNNING_TASKS", 20),
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

function integrationName(env: NodeJS.ProcessEnv): IntegrationName {
  const raw = env.VB_INTEGRATION;
  if (raw === undefined || raw.trim() === "" || raw.trim() === "none") return "none";
  if (raw.trim() === "viate") return "viate";
  throw new Error(`VB_INTEGRATION 必须是 none 或 viate，收到 "${raw}"`);
}
