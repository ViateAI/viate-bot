ALTER TABLE `routines` ADD `state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX `routines_due_idx` ON `routines` (`state`, `enabled`, `next_run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `routine_runs_slot` ON `routine_runs` (`routine_id`, `scheduled_at`);--> statement-breakpoint
ALTER TABLE `app_versions` ADD `recommended` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `approvals` ADD `args_hash` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `consumed_at` text;--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bot_id` text,
	`task_id` text,
	`kind` text NOT NULL,
	`read_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`, `read_at`);--> statement-breakpoint
CREATE TABLE `takeover_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text,
	`session_id` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `takeover_leases_bot_idx` ON `takeover_leases` (`bot_id`, `state`);--> statement-breakpoint
CREATE TABLE `app_pushes` (
	`id` text PRIMARY KEY NOT NULL,
	`app_version_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`forced` integer DEFAULT 0 NOT NULL,
	`wake` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`app_version_id`) REFERENCES `app_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `app_push_targets` (
	`push_id` text NOT NULL,
	`user_id` text NOT NULL,
	`machine_id` text,
	`install_id` text,
	`state` text NOT NULL,
	`error` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`push_id`, `user_id`),
	FOREIGN KEY (`push_id`) REFERENCES `app_pushes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`install_id`) REFERENCES `app_installs`(`id`) ON UPDATE no action ON DELETE no action
);
