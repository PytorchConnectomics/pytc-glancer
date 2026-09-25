DROP INDEX `idx_studies_slug`;--> statement-breakpoint
ALTER TABLE `studies` ADD `account_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_studies_account_slug` ON `studies` (`account_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_studies_account` ON `studies` (`account_id`);