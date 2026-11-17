ALTER TABLE `machines` ADD `egress_offline_policy` text DEFAULT 'pause' NOT NULL;--> statement-breakpoint
ALTER TABLE `machines` ADD `egress_device_id` text;--> statement-breakpoint
CREATE TABLE `client_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	`last_ip` text,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `client_devices_token_hash` ON `client_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `client_devices_user` ON `client_devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `client_link_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_name` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_challenge` text NOT NULL,
	`state` text NOT NULL,
	`redirect_port` integer NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `client_link_codes_hash` ON `client_link_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `egress_bytes_hourly` (
	`machine_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hour` text NOT NULL,
	`bytes_to_client` integer DEFAULT 0 NOT NULL,
	`bytes_to_machine` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`machine_id`, `device_id`, `hour`)
);
