-- Sender pictures (docs/contract-avatars.md; the owner's request of 2026-11-19). Adds only: a table holding each
-- registrable domain's site icon or why there is none, what the mailbox provider's checker proved about a message's
-- From domain, and the picture a thread shows. Nothing is marked or fetched here: a build without that code that
-- applies this migration changes nothing, and a build with it asks Gmail again at its next start (the backfill).
CREATE TABLE `avatar_sites` (
	`domain` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`due_at` integer,
	`tries` integer DEFAULT 0 NOT NULL,
	`picture_id` text,
	`mime_type` text,
	`data` text,
	`width` integer,
	`height` integer,
	`fit` text,
	`checked_at` integer,
	`wanted_at` integer NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `avatar_sites_due` ON `avatar_sites` (`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `avatar_sites_picture` ON `avatar_sites` (`picture_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `from_check` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `from_verified` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `avatar` text;