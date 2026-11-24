ALTER TABLE `inboxes` ADD `connection` text;--> statement-breakpoint
ALTER TABLE `rules` ADD `created_by` text DEFAULT '{"kind":"system"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `rules` ADD `version` integer DEFAULT 1 NOT NULL;