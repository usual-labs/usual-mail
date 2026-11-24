CREATE TABLE `sent_message_ids` (
	`inbox_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`inbox_id`, `message_id`),
	FOREIGN KEY (`inbox_id`) REFERENCES `inboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Once: an inbox's own address that earlier builds let in by themselves (a copy of mail to itself counted as the inbox
-- writing to it) is forgotten, so a forged "From: <the inbox's own address>" is screened like any stranger. A block stays.
DELETE FROM `senders` WHERE `status` = 'known' AND `email` = (SELECT lower(`address`) FROM `inboxes` WHERE `inboxes`.`id` = `senders`.`inbox_id`);
