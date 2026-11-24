-- Search (docs/contract-search.md, server/src/search/; the owner's "do step 1 and 2 first" of 2026-11-20). Two tables
-- the server writes from what it stores, and an FTS5 full-text index beside them: one row per thread, its columns the
-- subject, who wrote, who else is in it, the summary, the AI's checked facts, attachment names and the bodies'
-- reading text. unicode61 with remove_diacritics 2 (case and accents folded, so "muller" finds "Müller"), and prefix
-- indexes of 2 and 3 characters for search as you type. A trigger deletes a thread's index row with its search_docs
-- row, so a thread or an inbox deleted takes it along. Nothing is filled here: the server's first start builds the
-- index from the stored mail, by rule, with no provider read and no AI request.
CREATE TABLE `search_docs` (
	`id` integer PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`version` integer NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_docs_thread` ON `search_docs` (`thread_id`);--> statement-breakpoint
CREATE TABLE `search_people` (
	`thread_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`role` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`folded` text NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `role`, `email`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_people_email` ON `search_people` (`inbox_id`,`role`,`email`);--> statement-breakpoint
CREATE VIRTUAL TABLE `search_index` USING fts5(subject, sender, people, summary, facts, attachments, body, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');--> statement-breakpoint
CREATE TRIGGER `search_docs_delete` AFTER DELETE ON `search_docs` BEGIN DELETE FROM `search_index` WHERE rowid = old.id; END;