CREATE TABLE `held_copies` (
	`inbox_id` text NOT NULL,
	`ref` text NOT NULL,
	`message_id` text NOT NULL,
	`seen` integer NOT NULL,
	`placement` text NOT NULL,
	`held_at` integer NOT NULL,
	PRIMARY KEY(`inbox_id`, `ref`),
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `held_copies_message` ON `held_copies` (`message_id`);