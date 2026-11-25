-- Why an inbox needs attention, and when a failing or silent sync counts as one (docs/contract-sync.md, "When an
-- inbox needs attention"; the owner's decision of 2026-11-25, for 0.1.2): the reason with `needs_attention`, when the
-- last sync attempt finished, and the run of failures that may pass (since when, how many). Null and 0 on every inbox
-- after the upgrade: an inbox that needs attention keeps its words without a reason until its next attempt.
ALTER TABLE `inboxes` ADD `status_reason` text;--> statement-breakpoint
ALTER TABLE `inboxes` ADD `last_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `inboxes` ADD `failing_since` integer;--> statement-breakpoint
ALTER TABLE `inboxes` ADD `failures` integer DEFAULT 0 NOT NULL;