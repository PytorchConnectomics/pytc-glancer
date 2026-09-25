CREATE TABLE `data_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text DEFAULT 'gcs' NOT NULL,
	`bucket` text NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`ngauth_base` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `glances` (
	`id` text PRIMARY KEY NOT NULL,
	`study_id` text NOT NULL,
	`source_id` text,
	`short_key` text NOT NULL,
	`short_name` text,
	`title` text,
	`url_base` text NOT NULL,
	`state` text NOT NULL,
	`source_path` text,
	`position` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`study_id`) REFERENCES `studies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `data_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_glances_short_key` ON `glances` (`short_key`);--> statement-breakpoint
CREATE INDEX `idx_glances_study_position` ON `glances` (`study_id`,`position`);--> statement-breakpoint
CREATE TABLE `studies` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_studies_slug` ON `studies` (`slug`);