CREATE TABLE `app_installs` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`app_version_id` text NOT NULL,
	`forced` integer DEFAULT false NOT NULL,
	`desired` text NOT NULL,
	`state` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_version_id`) REFERENCES `app_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` text NOT NULL,
	`manifest_json` text NOT NULL,
	`archive_path` text NOT NULL,
	`sha256` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_visibility` (
	`app_id` text NOT NULL,
	`scope` text NOT NULL,
	`user_id` text,
	PRIMARY KEY(`app_id`, `scope`, `user_id`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`step_id` text,
	`tool` text NOT NULL,
	`summary` text NOT NULL,
	`args_json` text NOT NULL,
	`state` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_id`) REFERENCES `task_steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`owner_user_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_name_unique` ON `apps` (`name`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`attrs_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_apps` (
	`bot_id` text NOT NULL,
	`app_install_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`bot_id`, `app_install_id`),
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_install_id`) REFERENCES `app_installs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`instructions` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`model_credential_id` text,
	`display_no` integer,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_credential_id`) REFERENCES `model_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` text NOT NULL,
	`user_id` text,
	`bot_id` text,
	`machine_id` text,
	`type` text NOT NULL,
	`attrs_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_ts_idx` ON `events` (`ts`);--> statement-breakpoint
CREATE TABLE `identities` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`provider`, `subject`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `machine_meter` (
	`machine_id` text NOT NULL,
	`hour` text NOT NULL,
	`running_seconds` integer NOT NULL,
	`spec_json` text NOT NULL,
	PRIMARY KEY(`machine_id`, `hour`),
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `machine_samples` (
	`machine_id` text NOT NULL,
	`ts` text NOT NULL,
	`cpu_pct` real NOT NULL,
	`mem_mb` real NOT NULL,
	`disk_mb` real NOT NULL,
	`net_rx` integer NOT NULL,
	`net_tx` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `ts`),
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`state` text NOT NULL,
	`spec_json` text NOT NULL,
	`image_version` text NOT NULL,
	`container_id` text,
	`network_id` text,
	`volume_name` text NOT NULL,
	`machined_token_enc` text NOT NULL,
	`egress_mode` text DEFAULT 'direct' NOT NULL,
	`last_heartbeat_at` text,
	`last_started_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machines_user_id_unique` ON `machines` (`user_id`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`content` text NOT NULL,
	`source_task_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content_json` text NOT NULL,
	`task_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`bot_id` text,
	`provider` text NOT NULL,
	`external_id` text,
	`secret_enc` text NOT NULL,
	`policy_ref` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quotas` (
	`user_id` text PRIMARY KEY NOT NULL,
	`max_bots` integer NOT NULL,
	`spec_json` text NOT NULL,
	`max_concurrent_tasks` integer NOT NULL,
	`max_routines` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `routine_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`task_id` text,
	`scheduled_at` text NOT NULL,
	`state` text NOT NULL,
	`error` text,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`cron` text NOT NULL,
	`timezone` text NOT NULL,
	`prompt` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`value_enc` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`csrf` text NOT NULL,
	`idp_refresh_token_enc` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stats_minute` (
	`bucket` text NOT NULL,
	`metric` text NOT NULL,
	`dims_key` text NOT NULL,
	`value_sum` real NOT NULL,
	`value_count` integer NOT NULL,
	`value_max` real NOT NULL,
	PRIMARY KEY(`bucket`, `metric`, `dims_key`)
);
--> statement-breakpoint
CREATE TABLE `task_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text,
	`status` text NOT NULL,
	`approval_id` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`conversation_id` text,
	`routine_run_id` text,
	`state` text NOT NULL,
	`trigger` text NOT NULL,
	`step_count` integer DEFAULT 0 NOT NULL,
	`usage_json` text,
	`error` text,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `usage_hourly` (
	`bot_id` text NOT NULL,
	`user_id` text NOT NULL,
	`model` text NOT NULL,
	`hour` text NOT NULL,
	`requests` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`cost_usd` text,
	`cost_source` text NOT NULL,
	PRIMARY KEY(`bot_id`, `user_id`, `model`, `hour`),
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`last_synced_at` text,
	`created_at` text NOT NULL
);
