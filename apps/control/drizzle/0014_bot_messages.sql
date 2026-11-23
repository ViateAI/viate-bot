CREATE TABLE `bot_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`from_bot_id` text NOT NULL,
	`to_bot_id` text NOT NULL,
	`reply_to_id` text,
	`origin_task_id` text,
	`hop` integer NOT NULL,
	`body` text NOT NULL,
	`state` text NOT NULL,
	`task_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_id`) REFERENCES `bot_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bot_messages_to_state_created` ON `bot_messages` (`to_bot_id`, `state`, `created_at`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `bot_message_id` text REFERENCES `bot_messages`(`id`);
