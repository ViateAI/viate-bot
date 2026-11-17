ALTER TABLE `routine_runs` ADD `source` text DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
CREATE INDEX `routine_runs_scheduled_idx` ON `routine_runs` (`scheduled_at`);
