import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** 本地用户。id 是本系统生成的 ULID，不是外部身份提供方的 subject。 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  /** 关闭时服务端不返回工具参数、结果、中间回复、推理和截图。 */
  showProcess: integer("show_process", { mode: "boolean" }).notNull().default(false),
  lastSyncedAt: text("last_synced_at"),
  createdAt: text("created_at").notNull(),
});

/** 外部身份。provider 是身份提供方标识，subject 是对方的用户 ID（OIDC 的 sub）。 */
export const identities = sqliteTable(
  "identities",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    email: text("email"),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.subject] })],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** Cookie 里的会话 token 只存哈希，明文不入库。 */
    tokenHash: text("token_hash").notNull().default(""),
    csrf: text("csrf").notNull(),
    idpRefreshTokenEnc: text("idp_refresh_token_enc").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    /**
     * 上次向身份提供方校验的时间。不能复用 last_seen_at：
     * 后者每次请求都滑动，活跃用户会永远跨不过 5 分钟的刷新窗口。
     */
    lastValidatedAt: text("last_validated_at").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("sessions_token_hash_unique").on(table.tokenHash)],
);

export const machines = sqliteTable(
  "machines",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    state: text("state").notNull(),
    specJson: text("spec_json").notNull(),
    imageVersion: text("image_version").notNull(),
    containerId: text("container_id"),
    networkId: text("network_id"),
    volumeName: text("volume_name").notNull(),
    machinedTokenEnc: text("machined_token_enc").notNull(),
    egressMode: text("egress_mode").notNull().default("direct"),
    lastHeartbeatAt: text("last_heartbeat_at"),
    lastStartedAt: text("last_started_at"),
    /** 协议不兼容等原因。空表示没有需要展示的拒绝原因。 */
    statusDetail: text("status_detail"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("machines_user_id_unique").on(table.userId)],
);

export const bots = sqliteTable("bots", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  avatar: text("avatar"),
  bio: text("bio").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  model: text("model").notNull(),
  modelCredentialId: text("model_credential_id").references((): AnySQLiteColumn => modelCredentials.id),
  displayNo: integer("display_no"),
  settingsJson: text("settings_json").notNull().default("{}"),
  noticeReady: integer("notice_ready", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
});

/**
 * 模型网关访问上游用的凭据。共享 key 时 user_id 和 bot_id 为空；
 * 按 bot 签发时各有一条。secret_enc 只留在控制面。
 */
export const modelCredentials = sqliteTable("model_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id),
  botId: text("bot_id").references((): AnySQLiteColumn => bots.id),
  provider: text("provider").notNull(),
  externalId: text("external_id"),
  secretEnc: text("secret_enc").notNull(),
  policyRef: text("policy_ref"),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
});

export const botApps = sqliteTable(
  "bot_apps",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id),
    appInstallId: text("app_install_id")
      .notNull()
      .references(() => appInstalls.id),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.botId, table.appInstallId] })],
);

export const quotas = sqliteTable("quotas", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  maxBots: integer("max_bots").notNull(),
  specJson: text("spec_json").notNull(),
  maxConcurrentTasks: integer("max_concurrent_tasks").notNull(),
  maxRoutines: integer("max_routines").notNull(),
  /** null 表示沿用全局预算。0 表示不限制。 */
  taskTokenBudget: integer("task_token_budget"),
  /** null 表示沿用全局步数上限。0 表示不限制。 */
  taskMaxSteps: integer("task_max_steps"),
  /** null 表示沿用全局时长上限。0 表示不限制。 */
  taskMaxDurationSec: integer("task_max_duration_sec"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  botId: text("bot_id")
    .notNull()
    .references(() => bots.id),
  title: text("title").notNull().default(""),
  /** 较早对话的摘要。原始 messages 不改。 */
  summaryText: text("summary_text"),
  /** 摘要覆盖到的最后一条消息 id，含这条。 */
  summaryUntilMessageId: text("summary_until_message_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id),
  role: text("role").notNull(),
  contentJson: text("content_json").notNull(),
  taskId: text("task_id"),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  botId: text("bot_id")
    .notNull()
    .references(() => bots.id),
  conversationId: text("conversation_id").references(() => conversations.id),
  routineRunId: text("routine_run_id"),
  botMessageId: text("bot_message_id").references((): AnySQLiteColumn => botMessages.id),
  state: text("state").notNull(),
  trigger: text("trigger").notNull(),
  stepCount: integer("step_count").notNull().default(0),
  usageJson: text("usage_json"),
  error: text("error"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
});

export const botMessages = sqliteTable(
  "bot_messages",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    fromBotId: text("from_bot_id")
      .notNull()
      .references(() => bots.id),
    toBotId: text("to_bot_id")
      .notNull()
      .references(() => bots.id),
    replyToId: text("reply_to_id").references((): AnySQLiteColumn => botMessages.id),
    originTaskId: text("origin_task_id").references((): AnySQLiteColumn => tasks.id),
    hop: integer("hop").notNull(),
    body: text("body").notNull(),
    state: text("state").notNull(),
    taskId: text("task_id").references((): AnySQLiteColumn => tasks.id),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("bot_messages_to_state_created").on(table.toBotId, table.state, table.createdAt)],
);

export const taskSteps = sqliteTable("task_steps", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  requestJson: text("request_json").notNull(),
  responseJson: text("response_json"),
  status: text("status").notNull(),
  approvalId: text("approval_id"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  stepId: text("step_id").references(() => taskSteps.id),
  tool: text("tool").notNull(),
  summary: text("summary").notNull(),
  argsJson: text("args_json").notNull(),
  state: text("state").notNull(),
  /** sha256(tool + canonical JSON)。一次性消费前必须与这次调用一致。 */
  argsHash: text("args_hash"),
  consumedAt: text("consumed_at"),
  decidedBy: text("decided_by"),
  decidedAt: text("decided_at"),
});

export const approvalRules = sqliteTable(
  "approval_rules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id),
    category: text("category").notNull(),
    matchJson: text("match_json").notNull(),
    expiresAt: text("expires_at"),
    hitCount: integer("hit_count").notNull().default(0),
    lastHitAt: text("last_hit_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("approval_rules_bot_idx").on(table.botId)],
);

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  botId: text("bot_id")
    .notNull()
    .references(() => bots.id),
  content: text("content").notNull(),
  sourceTaskId: text("source_task_id").references(() => tasks.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const routines = sqliteTable("routines", {
  id: text("id").primaryKey(),
  botId: text("bot_id")
    .notNull()
    .references(() => bots.id),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull(),
  prompt: text("prompt").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** draft 未确认；active 可调度；deleted 保留运行历史。 */
  state: text("state").notNull().default("active"),
  nextRunAt: text("next_run_at"),
  createdAt: text("created_at").notNull(),
});

export const routineRuns = sqliteTable("routine_runs", {
  id: text("id").primaryKey(),
  routineId: text("routine_id")
    .notNull()
    .references(() => routines.id),
  taskId: text("task_id").references(() => tasks.id),
  scheduledAt: text("scheduled_at").notNull(),
  state: text("state").notNull(),
  error: text("error"),
  /** schedule：调度产生；manual：用户手动运行，不进入按时率。 */
  source: text("source").notNull().default("schedule"),
});

export const secrets = sqliteTable("secrets", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  valueEnc: text("value_enc").notNull(),
  scope: text("scope").notNull(),
  createdAt: text("created_at").notNull(),
});

export const apps = sqliteTable("apps", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  source: text("source").notNull(),
  ownerUserId: text("owner_user_id").references(() => users.id),
  createdAt: text("created_at").notNull(),
});

export const appVersions = sqliteTable("app_versions", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id),
  version: text("version").notNull(),
  manifestJson: text("manifest_json").notNull(),
  archivePath: text("archive_path").notNull(),
  sha256: text("sha256").notNull(),
  status: text("status").notNull(),
  recommended: integer("recommended", { mode: "boolean" }).notNull().default(false),
  importantNote: text("important_note"),
  importantAt: text("important_at"),
  createdAt: text("created_at").notNull(),
});

/** 用户级系统通知。同一用户对同一 dedupe_key 只生成一次。 */
export const systemNotices = sqliteTable(
  "system_notices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
    deliveredMessageId: text("delivered_message_id").references(() => messages.id),
    deliveredAt: text("delivered_at"),
  },
  (table) => [uniqueIndex("system_notices_user_dedupe_unique").on(table.userId, table.dedupeKey)],
);

export const appVisibility = sqliteTable(
  "app_visibility",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    scope: text("scope").notNull(),
    userId: text("user_id").references(() => users.id),
  },
  (table) => [primaryKey({ columns: [table.appId, table.scope, table.userId] })],
);

export const appInstalls = sqliteTable("app_installs", {
  id: text("id").primaryKey(),
  machineId: text("machine_id")
    .notNull()
    .references(() => machines.id),
  appVersionId: text("app_version_id")
    .notNull()
    .references(() => appVersions.id),
  forced: integer("forced", { mode: "boolean" }).notNull().default(false),
  desired: text("desired").notNull(),
  state: text("state").notNull(),
  configJson: text("config_json").notNull().default("{}"),
  error: text("error"),
  updatedAt: text("updated_at").notNull(),
  /** bot 安装时记下当时的名字。用户在应用页看到「由 bot〈名称〉安装」。 */
  installedByBotId: text("installed_by_bot_id"),
  installedByBotName: text("installed_by_bot_name"),
  resolvedVersion: text("resolved_version"),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    ts: text("ts").notNull(),
    userId: text("user_id"),
    botId: text("bot_id"),
    machineId: text("machine_id"),
    type: text("type").notNull(),
    attrsJson: text("attrs_json").notNull().default("{}"),
  },
  (table) => [index("events_ts_idx").on(table.ts)],
);

export const statsMinute = sqliteTable(
  "stats_minute",
  {
    bucket: text("bucket").notNull(),
    metric: text("metric").notNull(),
    dimsKey: text("dims_key").notNull(),
    valueSum: real("value_sum").notNull(),
    valueCount: integer("value_count").notNull(),
    valueMax: real("value_max").notNull(),
  },
  (table) => [primaryKey({ columns: [table.bucket, table.metric, table.dimsKey] })],
);

export const machineSamples = sqliteTable(
  "machine_samples",
  {
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id),
    ts: text("ts").notNull(),
    cpuPct: real("cpu_pct").notNull(),
    memMb: real("mem_mb").notNull(),
    diskMb: real("disk_mb").notNull(),
    netRx: integer("net_rx").notNull(),
    netTx: integer("net_tx").notNull(),
  },
  (table) => [primaryKey({ columns: [table.machineId, table.ts] })],
);

export const usageHourly = sqliteTable(
  "usage_hourly",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    model: text("model").notNull(),
    hour: text("hour").notNull(),
    requests: integer("requests").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    costUsd: text("cost_usd"),
    costSource: text("cost_source").notNull(),
  },
  (table) => [primaryKey({ columns: [table.botId, table.userId, table.model, table.hour] })],
);

export const machineMeter = sqliteTable(
  "machine_meter",
  {
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id),
    hour: text("hour").notNull(),
    runningSeconds: integer("running_seconds").notNull(),
    specJson: text("spec_json").notNull(),
  },
  (table) => [primaryKey({ columns: [table.machineId, table.hour] })],
);

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  ts: text("ts").notNull(),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  target: text("target").notNull(),
  attrsJson: text("attrs_json").notNull().default("{}"),
});

/** 站内未读。只存种类和任务 id，不存对话正文、截图或密钥。 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    botId: text("bot_id").references(() => bots.id),
    taskId: text("task_id").references(() => tasks.id),
    kind: text("kind").notNull(),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("notifications_user_idx").on(table.userId, table.readAt)],
);

/** 接管租约。进程重启后 active 租约失效，因为浏览器套接字已经没了。 */
export const takeoverLeases = sqliteTable(
  "takeover_leases",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    taskId: text("task_id").references(() => tasks.id),
    sessionId: text("session_id"),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("takeover_leases_bot_idx").on(table.botId, table.state)],
);

export const appPushes = sqliteTable("app_pushes", {
  id: text("id").primaryKey(),
  appVersionId: text("app_version_id")
    .notNull()
    .references(() => appVersions.id),
  actorUserId: text("actor_user_id")
    .notNull()
    .references(() => users.id),
  forced: integer("forced", { mode: "boolean" }).notNull().default(false),
  wake: integer("wake", { mode: "boolean" }).notNull().default(false),
  state: text("state").notNull(),
  createdAt: text("created_at").notNull(),
});

export const appPushTargets = sqliteTable(
  "app_push_targets",
  {
    pushId: text("push_id")
      .notNull()
      .references(() => appPushes.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    machineId: text("machine_id").references(() => machines.id),
    installId: text("install_id").references(() => appInstalls.id),
    state: text("state").notNull(),
    error: text("error"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pushId, table.userId] })],
);

/** 用户应用某个版本的公开审批。待审批、驳回、撤回都不让其他用户看到该版本。 */
export const appPublishRequests = sqliteTable(
  "app_publish_requests",
  {
    id: text("id").primaryKey(),
    appVersionId: text("app_version_id")
      .notNull()
      .references(() => appVersions.id),
    requesterUserId: text("requester_user_id")
      .notNull()
      .references(() => users.id),
    botId: text("bot_id").references(() => bots.id),
    taskId: text("task_id").references(() => tasks.id),
    note: text("note").notNull(),
    state: text("state").notNull(),
    reason: text("reason"),
    reviewerUserId: text("reviewer_user_id").references(() => users.id),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (table) => [index("app_publish_requests_version_idx").on(table.appVersionId, table.state)],
);

/** 控制面上传副本。message_id 为空表示还没有被消息引用。 */
export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    messageId: text("message_id").references(() => messages.id),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    mime: text("mime").notNull(),
    sha256: text("sha256").notNull(),
    kind: text("kind").notNull(),
    createdAt: text("created_at").notNull(),
    /** 成功写到机器上的时间。失败保持空，同一任务可以重试。已写入的不再覆盖。 */
    deliveredAt: text("delivered_at"),
  },
  (table) => [index("uploads_user_idx").on(table.userId), index("uploads_message_idx").on(table.messageId)],
);
