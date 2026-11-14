const SERVICE_SCOPE = "users:read channels:read keys:write usage:read";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const KEY_BATCH = 200;

export interface ViateClientOptions {
  url: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ViateBot {
  id: string;
  name: string;
  userId: string;
  subject: string | null;
}

export interface ViateIssued {
  provider: string;
  externalId: string | null;
  secret: string;
  policyRef: string | null;
  shared: boolean;
}

export interface ViateCredentialRef {
  provider: string;
  externalId: string | null;
  shared: boolean;
}

export interface ViatePolicy {
  id: string;
  name: string;
}

export interface ViateDirectoryUser {
  subject: string;
  email: string;
  name: string;
  status: "active" | "disabled";
}

export interface ViateUsageCredential {
  externalId: string;
  botId: string;
  userId: string;
}

export interface ViateUsageBucket {
  botId: string;
  userId: string;
  model: string;
  hour: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: string | null;
  costSource: string;
}

export interface ViateIntegration {
  credentials: {
    issue(bot: ViateBot, policyRef?: string): Promise<ViateIssued>;
    revoke(credential: ViateCredentialRef): Promise<void>;
    listPolicies(user: { subject: string | null }): Promise<ViatePolicy[]>;
  };
  directory: {
    listUsers(cursor?: string): Promise<{ users: ViateDirectoryUser[]; nextCursor: string | null }>;
    userStatus(identity: { subject: string }): Promise<"active" | "disabled" | "unknown">;
    usage(credentials: ViateUsageCredential[], from: string, to: string): Promise<ViateUsageBucket[]>;
  };
  pullUsage(credentials: ViateUsageCredential[], from: string, to: string): Promise<ViateUsageBucket[]>;
  reconcile(isActive: (botId: string) => boolean): Promise<string[]>;
}

export function createViateIntegration(options: ViateClientOptions): ViateIntegration {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.url.replace(/\/$/, "");
  let cached: { token: string; refreshAt: number } | undefined;

  async function accessToken(): Promise<string> {
    const current = now();
    if (cached && current < cached.refreshAt) return cached.token;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      scope: SERVICE_SCOPE,
    });
    const response = await fetchImpl(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`服务令牌获取失败：${await errorText(response)}`);
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("服务令牌响应缺少 access_token");
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    cached = { token: json.access_token, refreshAt: current + expiresIn * 1000 - REFRESH_SKEW_MS };
    return json.access_token;
  }

  async function service(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await accessToken();
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return response;
  }

  async function pullUsage(credentials: ViateUsageCredential[], from: string, to: string): Promise<ViateUsageBucket[]> {
    const byKey = new Map(credentials.map((item) => [item.externalId, item]));
    const ids = [...byKey.keys()];
    const buckets: ViateUsageBucket[] = [];
    for (let index = 0; index < ids.length; index += KEY_BATCH) {
      const slice = ids.slice(index, index + KEY_BATCH);
      const query = new URLSearchParams({
        keyIds: slice.join(","),
        from,
        to,
        granularity: "hour",
      });
      const response = await service("GET", `/api/service/usage?${query.toString()}`);
      if (!response.ok) throw new Error(`拉取扣费失败：${await errorText(response)}`);
      const json = (await response.json()) as { buckets?: RawBucket[] };
      for (const bucket of json.buckets ?? []) {
        const owner = byKey.get(bucket.keyId);
        if (!owner) continue;
        buckets.push({
          botId: owner.botId,
          userId: owner.userId,
          model: "",
          hour: bucket.bucket,
          requests: bucket.requests,
          inputTokens: bucket.inputTokens,
          outputTokens: bucket.outputTokens,
          cacheReadTokens: bucket.cacheReadTokens,
          cacheWriteTokens: bucket.cacheWriteTokens,
          costUsd: bucket.costUsd,
          costSource: "viate",
        });
      }
    }
    return buckets;
  }

  const credentialsApi = {
    async issue(bot: ViateBot, policyRef?: string): Promise<ViateIssued> {
      if (!bot.subject) throw new Error("这个用户还没有 viate 身份，不能签发 key");
      const channelId = policyRef || (await firstChannel(bot.subject));
      const response = await service("POST", `/api/service/users/${encodeURIComponent(bot.subject)}/keys`, {
        name: `bot:${bot.name}`,
        channelId,
        kind: "bot",
        externalRef: bot.id,
      });
      if (!response.ok) throw new Error(`签发 key 失败：${await errorText(response)}`);
      const json = (await response.json()) as { id?: string; key?: string; channelId?: string };
      if (!json.id || !json.key) throw new Error("签发 key 的响应缺少 id 或 key");
      return {
        provider: "viate",
        externalId: json.id,
        secret: json.key,
        policyRef: json.channelId ?? channelId,
        shared: false,
      };
    },
    async revoke(credential: ViateCredentialRef): Promise<void> {
      if (credential.shared || !credential.externalId) return;
      const response = await service("DELETE", `/api/service/keys/${encodeURIComponent(credential.externalId)}`);
      if (response.status === 404) return;
      if (!response.ok) throw new Error(`吊销 key 失败：${await errorText(response)}`);
    },
    async listPolicies(user: { subject: string | null }): Promise<ViatePolicy[]> {
      if (!user.subject) return [];
      const response = await service("GET", `/api/service/users/${encodeURIComponent(user.subject)}/channels`);
      if (!response.ok) throw new Error(`查询渠道失败：${await errorText(response)}`);
      const json = (await response.json()) as { channels?: ViatePolicy[] };
      return json.channels ?? [];
    },
  };

  const directory = {
    async listUsers(cursor?: string) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await service("GET", `/api/service/users${query}`);
      if (!response.ok) throw new Error(`查询用户目录失败：${await errorText(response)}`);
      const json = (await response.json()) as {
        users?: Array<{ id: string; email: string; name: string; status: string }>;
        nextCursor?: string | null;
      };
      return {
        users: (json.users ?? []).map((user) => ({
          subject: user.id,
          email: user.email,
          name: user.name,
          status: user.status === "disabled" ? "disabled" as const : "active" as const,
        })),
        nextCursor: json.nextCursor ?? null,
      };
    },
    async userStatus(identity: { subject: string }): Promise<"active" | "disabled" | "unknown"> {
      const response = await service("GET", `/api/service/users/${encodeURIComponent(identity.subject)}`);
      if (response.status === 404) return "unknown";
      if (!response.ok) throw new Error(`查询用户状态失败：${await errorText(response)}`);
      const json = (await response.json()) as { status?: string };
      if (json.status === "active" || json.status === "disabled") return json.status;
      return "unknown";
    },
    pullUsage,
    usage: pullUsage,
  };

  return {
    credentials: credentialsApi,
    directory,
    pullUsage,
    async reconcile(isActive) {
      const response = await service("GET", "/api/service/keys?kind=bot");
      if (!response.ok) throw new Error(`列出 key 失败：${await errorText(response)}`);
      const json = (await response.json()) as { apiKeys?: Array<{ id: string; externalRef: string | null }> };
      const revoked: string[] = [];
      for (const key of json.apiKeys ?? []) {
        if (key.externalRef && isActive(key.externalRef)) continue;
        const deleted = await service("DELETE", `/api/service/keys/${encodeURIComponent(key.id)}`);
        if (deleted.status !== 404 && !deleted.ok) throw new Error(`对账吊销失败：${await errorText(deleted)}`);
        revoked.push(key.id);
      }
      return revoked;
    },
  };

  async function firstChannel(subject: string): Promise<string> {
    const channels = await credentialsApi.listPolicies({ subject });
    const first = channels[0];
    if (!first) throw new Error("这个用户没有可用的 viate 渠道");
    return first.id;
  }
}

interface RawBucket {
  keyId: string;
  bucket: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: string | null;
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string };
    if (typeof json.error === "string") return json.error_description ?? json.error;
    if (json.error && typeof json.error.message === "string") return json.error.message;
  } catch {
    return text || `HTTP ${response.status}`;
  }
  return text || `HTTP ${response.status}`;
}
