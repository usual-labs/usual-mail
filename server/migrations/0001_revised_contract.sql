DROP INDEX `threads_lists`;--> statement-breakpoint
ALTER TABLE `threads` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `threads_lists` ON `threads` (`inbox_id`,`pile`,`done`,`last_message_at`);--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `sort_at`;--> statement-breakpoint
ALTER TABLE `actions` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inboxes` ADD `reset_listing` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `listed` integer;