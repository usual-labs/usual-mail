CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`action` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`actor_kind` text NOT NULL,
	`reason` text,
	`state` text NOT NULL,
	`at` integer NOT NULL,
	`undone_at` integer,
	`undoable` integer NOT NULL,
	`error` text,
	`before` text NOT NULL,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actions_thread` ON `actions` (`thread_id`,`at`);--> statement-breakpoint
CREATE INDEX `actions_inbox` ON `actions` (`inbox_id`,`at`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`inline` integer NOT NULL,
	`content_id` text,
	`position` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_message` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`period_from` integer NOT NULL,
	`period_to` integer NOT NULL,
	`sections` text NOT NULL,
	`written_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`inbox_ids` text,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_id` text NOT NULL,
	`thread_id` text,
	`in_reply_to_message_id` text,
	`to_addresses` text NOT NULL,
	`cc_addresses` text NOT NULL,
	`bcc_addresses` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`created_by` text NOT NULL,
	`state` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `drafts_inbox` ON `drafts` (`inbox_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `inboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`color` text NOT NULL,
	`provider` text NOT NULL,
	`trust` text NOT NULL,
	`guide` text DEFAULT '' NOT NULL,
	`agent_access` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`status_detail` text,
	`paused` integer DEFAULT false NOT NULL,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`credentials` text NOT NULL,
	`sync_cursor` text,
	`history_done` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`ref` text NOT NULL,
	`message_id` text,
	`in_reply_to` text,
	`references` text NOT NULL,
	`from_address` text NOT NULL,
	`to_addresses` text NOT NULL,
	`cc_addresses` text NOT NULL,
	`bcc_addresses` text NOT NULL,
	`reply_to` text,
	`date` integer NOT NULL,
	`subject` text NOT NULL,
	`text` text,
	`html` text,
	`unread` integer NOT NULL,
	`outgoing` integer NOT NULL,
	`list_id` text,
	`list_unsubscribe` text,
	`automated` integer NOT NULL,
	`placement` text NOT NULL,
	`seen` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_ref` ON `messages` (`inbox_id`,`ref`);--> statement-breakpoint
CREATE INDEX `messages_message_id` ON `messages` (`inbox_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `messages_thread` ON `messages` (`thread_id`,`date`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`inbox_ids` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_id` text NOT NULL,
	`text` text NOT NULL,
	`match` text NOT NULL,
	`then` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rules_inbox` ON `rules` (`inbox_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `senders` (
	`inbox_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`inbox_id`, `email`),
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `teach_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_id` text NOT NULL,
	`question` text NOT NULL,
	`rule` text NOT NULL,
	`from_action_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_id` text NOT NULL,
	`thread_key` text NOT NULL,
	`subject` text NOT NULL,
	`snippet` text NOT NULL,
	`participants` text NOT NULL,
	`last_message_at` integer NOT NULL,
	`message_count` integer NOT NULL,
	`unread` integer NOT NULL,
	`has_attachments` integer NOT NULL,
	`pile` text NOT NULL,
	`done` integer NOT NULL,
	`stack` text,
	`come_back_at` integer,
	`come_back_if_no_reply` integer DEFAULT false NOT NULL,
	`come_back_set_at` integer,
	`sort_at` integer NOT NULL,
	`triage` text NOT NULL,
	`need` text,
	`reason` text,
	`sender` text,
	`trashed` integer DEFAULT false NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `threads_key` ON `threads` (`inbox_id`,`thread_key`);--> statement-breakpoint
CREATE INDEX `threads_lists` ON `threads` (`inbox_id`,`pile`,`done`,`sort_at`);--> statement-breakpoint
CREATE INDEX `threads_sender` ON `threads` (`inbox_id`,`sender`);--> statement-breakpoint
CREATE INDEX `threads_come_back` ON `threads` (`come_back_at`);