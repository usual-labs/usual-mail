CREATE TABLE `ai_cost_lookups` (
	`generation_id` text PRIMARY KEY NOT NULL,
	`hour` integer NOT NULL,
	`job` text NOT NULL,
	`model` text NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_cost_lookups_due` ON `ai_cost_lookups` (`next_at`);