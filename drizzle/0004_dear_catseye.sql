CREATE TABLE `glance_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`glance_id` text NOT NULL,
	`operation` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`author` text NOT NULL,
	`present` integer NOT NULL,
	`body` text NOT NULL,
	`summary` text,
	`restored_from` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`glance_id`) REFERENCES `glances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_glance_versions_glance_id` ON `glance_versions` (`glance_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_glance_versions_operation` ON `glance_versions` (`glance_id`,`operation`);
--> statement-breakpoint
/* One step captures both presence and absence at one migration timestamp. */
INSERT INTO glance_versions (glance_id, operation, kind, source, author, present, body, summary, restored_from, created_at, updated_at)
WITH now(ms) AS (SELECT CAST(strftime('%s', 'now') AS integer) * 1000)
SELECT g.id, 'baseline:' || g.id, 'report', 'baseline', 'system', r.glance_id IS NOT NULL, COALESCE(r.body, ''), NULL, NULL, now.ms, now.ms
  FROM glances g CROSS JOIN now LEFT JOIN glance_reports r ON r.glance_id = g.id
UNION ALL
SELECT g.id, 'baseline:' || g.id, 'review', 'baseline', 'system', v.glance_id IS NOT NULL, COALESCE(v.body, ''), NULL, NULL, now.ms, now.ms
  FROM glances g CROSS JOIN now LEFT JOIN glance_reviews v ON v.glance_id = g.id;
