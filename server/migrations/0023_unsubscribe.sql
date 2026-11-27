-- Unsubscribing from a sender (docs/contract.md, "Unsubscribing"; the owner's request of 2026-11-27): one row per inbox and
-- sender, the newest asked, with the ways already started on it; each message's List-Unsubscribe-Post header as sent, and
-- what of its unsubscribe the sender's own signature vouches for (null for mail stored before: nothing of it is used to
-- unsubscribe until the message is read again); and the browser agent's sealed key and how its service last answered.
-- Amended before 0.1.5 shipped (the security review of 2026-11-27): a store that ran the draft of it needs resetting.
CREATE TABLE `unsubscribes` (
	`inbox_id` text NOT NULL,
	`address` text NOT NULL,
	`thread_id` text NOT NULL,
	`state` text NOT NULL,
	`way` text,
	`url` text,
	`detail` text,
	`step` text,
	`tried` text DEFAULT '[]' NOT NULL,
	`marker` text,
	`run_id` text,
	`page` text,
	`next_at` integer,
	`asked_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`inbox_id`, `address`),
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `unsubscribes_due` ON `unsubscribes` (`next_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `list_unsubscribe_post` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `signed_unsubscribe` text;--> statement-breakpoint
ALTER TABLE `server_state` ADD `browser_agent_credentials` text;--> statement-breakpoint
ALTER TABLE `server_state` ADD `browser_agent_state` text;--> statement-breakpoint
ALTER TABLE `server_state` ADD `browser_agent_detail` text;