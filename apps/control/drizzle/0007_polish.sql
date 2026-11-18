ALTER TABLE `users` ADD `show_process` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `bots` ADD `bio` text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE TABLE `approval_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`category` text NOT NULL,
	`match_json` text NOT NULL,
	`expires_at` text,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`last_hit_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `approval_rules_bot_idx` ON `approval_rules` (`bot_id`);--> statement-breakpoint
ALTER TABLE `quotas` ADD `task_token_budget` integer;
