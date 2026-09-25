CREATE TABLE `glance_reports` (
	`glance_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`glance_id`) REFERENCES `glances`(`id`) ON UPDATE no action ON DELETE no action
);
