ALTER TABLE `sessions` ADD `token_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_validated_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
DELETE FROM `sessions` WHERE `token_hash` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);