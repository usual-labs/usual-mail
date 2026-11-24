ALTER TABLE `actions` ADD `silent` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `actions` ADD `note` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `note` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inboxes` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `senders` ADD `mark` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `come_back_announced` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Come-back times that passed before this upgrade were announced by the build that ran then.
UPDATE `threads` SET `come_back_announced` = 1 WHERE `come_back_at` IS NOT NULL AND `come_back_at` <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
