ALTER TABLE `app_versions` ADD `important_note` text;--> statement-breakpoint
ALTER TABLE `app_versions` ADD `important_at` text;--> statement-breakpoint
CREATE TABLE `system_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_message_id` text,
	`delivered_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivered_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `system_notices_user_dedupe_unique` ON `system_notices` (`user_id`, `dedupe_key`);
