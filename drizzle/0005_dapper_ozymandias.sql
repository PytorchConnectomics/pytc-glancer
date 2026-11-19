CREATE TABLE `roadmap_records` (
	`roadmap_id` text NOT NULL,
	`record_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`client` text NOT NULL,
	PRIMARY KEY(`roadmap_id`, `record_id`),
	FOREIGN KEY (`roadmap_id`) REFERENCES `roadmaps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_roadmap_records_seq` ON `roadmap_records` (`roadmap_id`,`seq`);--> statement-breakpoint
CREATE TABLE `roadmaps` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`schema` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_roadmaps_account_slug` ON `roadmaps` (`account_id`,`slug`);