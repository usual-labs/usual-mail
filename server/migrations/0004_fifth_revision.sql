CREATE TABLE `server_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`ai_credentials` text,
	`ai_service` text,
	`ai_models` text DEFAULT '{}' NOT NULL,
	`history_days` integer DEFAULT 7 NOT NULL,
	`ai_paused` integer DEFAULT false NOT NULL,
	`settings_version` integer DEFAULT 1 NOT NULL,
	`ai_state` text,
	`ai_detail` text,
	`ai_job` text,
	`ai_last_run_at` integer,
	`ai_retry_at` integer,
	`ai_failures` integer DEFAULT 0 NOT NULL,
	`status_version` integer DEFAULT 1 NOT NULL,
	`counts_version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `inboxes` ADD `icon` text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE `inboxes` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `inboxes` ADD `ai_processing` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `category` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `categorized_by` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `screened` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `screened_by_mailbox` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `gate_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `category_due` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `summary_due` integer DEFAULT false NOT NULL;
--> statement-breakpoint
INSERT INTO `server_state` (`id`) VALUES (1);--> statement-breakpoint
-- Inboxes keep the order they were connected in, take person, building and briefcase in turn, and the AI processes
-- none of them until a person turns it on (docs/contract.md, "Inboxes"). Each changed as clients see it.
UPDATE `inboxes` SET `position` = (SELECT count(*) FROM `inboxes` AS `earlier` WHERE `earlier`.`rowid` < `inboxes`.`rowid`);--> statement-breakpoint
UPDATE `inboxes` SET `icon` = CASE `position` % 3 WHEN 0 THEN 'person' WHEN 1 THEN 'building' ELSE 'briefcase' END, `version` = `version` + 1;--> statement-breakpoint
-- Piles become categories and screening a gate (docs/contract-sync.md, "Earlier revisions' piles"): people is
-- conversation, reads newsletter, receipts receipt, and a screening thread is screened in unknown. The triage state
-- becomes who decided the category. A thread nobody had decided (pending) was waiting for someone to sort it, so it is
-- unknown, whatever its pile: a decided category always says who decided it.
UPDATE `threads` SET
  `category` = CASE
    WHEN `triage` = 'pending' THEN 'unknown'
    WHEN `pile` = 'people' THEN 'conversation'
    WHEN `pile` = 'reads' THEN 'newsletter'
    WHEN `pile` = 'receipts' THEN 'receipt'
    ELSE 'unknown' END,
  `categorized_by` = CASE `triage` WHEN 'by_rule' THEN 'rule' WHEN 'by_agent' THEN 'agent' WHEN 'by_person' THEN 'person' ELSE NULL END,
  `screened` = (`pile` = 'screening'),
  `version` = `version` + 1;--> statement-breakpoint
-- Nothing has a summary yet, and undecided threads wait for the AI once an inbox's AI processing is on.
UPDATE `threads` SET `summary_due` = (`category` <> 'otp'), `category_due` = (`category` = 'unknown' AND `categorized_by` IS NULL);--> statement-breakpoint
-- A move becomes a categorize to the matching category; a move into screening has no counterpart, so it goes. The
-- before-states records keep, and rules' actions, are rewritten by the server at start (src/db/upgrade.ts).
DELETE FROM `actions` WHERE `kind` = 'move' AND json_extract(`action`, '$.pile') = 'screening';--> statement-breakpoint
UPDATE `actions` SET
  `kind` = 'categorize',
  `action` = json_object('kind', 'categorize', 'category', CASE json_extract(`action`, '$.pile')
    WHEN 'people' THEN 'conversation' WHEN 'reads' THEN 'newsletter' ELSE 'receipt' END),
  `version` = `version` + 1
WHERE `kind` = 'move';--> statement-breakpoint
-- Placements as the providers now report them: a category (null for none) and the Screening gate. IMAP's Screening
-- folder keeps no category.
UPDATE `messages` SET `placement` = json_remove(json_set(`placement`,
    '$.category', CASE json_extract(`placement`, '$.pile') WHEN 'reads' THEN 'newsletter' WHEN 'receipts' THEN 'receipt' ELSE NULL END,
    '$.screened', json(CASE WHEN json_extract(`placement`, '$.pile') = 'screening' THEN 'true' ELSE 'false' END)),
  '$.pile')
WHERE json_type(`placement`, '$.screened') IS NULL;--> statement-breakpoint
UPDATE `messages` SET `placement` = json_remove(`placement`, '$.category')
WHERE json_extract(`placement`, '$.screened') = 1 AND `inbox_id` IN (SELECT `id` FROM `inboxes` WHERE `provider` = 'imap');--> statement-breakpoint
DROP INDEX `threads_lists`;--> statement-breakpoint
CREATE INDEX `threads_lists` ON `threads` (`inbox_id`,`category`,`done`,`last_message_at`);--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `pile`;--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `triage`;