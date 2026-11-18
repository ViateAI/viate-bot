CREATE TABLE `app_publish_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`app_version_id` text NOT NULL,
	`requester_user_id` text NOT NULL,
	`bot_id` text,
	`task_id` text,
	`note` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`reviewer_user_id` text,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`app_version_id`) REFERENCES `app_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `app_publish_requests_version_idx` ON `app_publish_requests` (`app_version_id`, `state`);
