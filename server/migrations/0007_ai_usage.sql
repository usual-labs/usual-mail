CREATE TABLE `ai_usage` (
	`hour` integer NOT NULL,
	`job` text NOT NULL,
	`model` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`input_reported` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`output_reported` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`cost_reported` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`hour`, `job`, `model`)
);
--> statement-breakpoint
ALTER TABLE `server_state` ADD `ai_usage_since` integer;