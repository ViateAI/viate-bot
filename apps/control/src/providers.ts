/**
 * 核心只依赖这三个接口。viate 的实现由 compose.ts 按 VB_INTEGRATION 接进来。
 * 签名相对设计文档的细化写在 TECH-DESIGN 第 4 节的实现备注里。
 */

export interface ExternalIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** state、nonce、PKCE 一次生成，放进 vb_oauth，回调时原样交回。 */
export interface OidcTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

export interface IdentityProvider {
  /** 写入 identities.provider。viate 集成时是 "viate"，否则是 "oidc"。 */
  readonly id: string;
  authorizeUrl(transaction: OidcTransaction, redirectUri: string): Promise<URL>;
  /** 校验 state、nonce、id_token，并带回可轮换的 refresh token。 */
  handleCallback(
    callbackUrl: URL,
    transaction: OidcTransaction,
  ): Promise<{ identity: ExternalIdentity; refreshToken: string }>;
  /**
   * 用 refresh token 向身份提供方确认用户仍有效。
   * 成功时必须带回当前有效的 refresh token（提供方可能已经轮换）。
   * 刷新响应没有 id_token 时 identity 为 null。
   */
  refresh(refreshToken: string): Promise<{ identity: ExternalIdentity | null; refreshToken: string } | "revoked">;
}

export interface CredentialSubject {
  id: string;
  name: string;
  userId: string;
  /** identities 里 provider 对应的 subject。共享 key 不需要。 */
  subject: string | null;
}

export interface IssuedCredential {
  provider: string;
  externalId: string | null;
  secret: string;
  policyRef: string | null;
  /** 所有 bot 共用一条凭据时为 true，删除 bot 不得吊销它。 */
  shared: boolean;
}

export interface StoredCredentialRef {
  provider: string;
  externalId: string | null;
  shared: boolean;
}

export interface ModelPolicy {
  id: string;
  name: string;
}

export interface CredentialProvider {
  issue(bot: CredentialSubject, policyRef?: string): Promise<IssuedCredential>;
  revoke(credential: StoredCredentialRef): Promise<void>;
  listPolicies?(user: { subject: string | null }): Promise<ModelPolicy[]>;
}

export interface DirectoryUser {
  subject: string;
  email: string;
  name: string;
  status: "active" | "disabled";
}

export interface DirectoryPage {
  users: DirectoryUser[];
  nextCursor: string | null;
}

export interface UsageQueryCredential {
  externalId: string;
  botId: string;
  userId: string;
}

export interface UsageBucket {
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

export interface Directory {
  listUsers?(cursor?: string): Promise<DirectoryPage>;
  userStatus?(identity: { subject: string; provider?: string }): Promise<"active" | "disabled" | "unknown">;
  usage?(credentials: UsageQueryCredential[], from: string, to: string): Promise<UsageBucket[]>;
}

export interface AppHooks {
  /** WebSocket 还不存在。会话被身份提供方拒绝或本地禁用时调用。 */
  disconnectUser: (userId: string) => void;
}

export interface AppRuntime {
  identity: IdentityProvider;
  credentials: CredentialProvider;
  directory: Directory;
  hooks: AppHooks;
  startJobs: () => () => void;
}
