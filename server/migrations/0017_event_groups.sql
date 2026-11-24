-- Notification groups (docs/agents/server-ai.md; the owner's "Yes, build it" of 2026-11-19). One column and its
-- index: the server-only key that joins a notification to others about the same thing (a hash, never the reference
-- itself). Nothing is marked here: a build without the grouping code that applies this migration changes nothing, and
-- the first start of a build with it asks every notification that isn't done for its reference (src/ai/ask-again.ts).
ALTER TABLE `threads` ADD `event_key` text;--> statement-breakpoint
CREATE INDEX `threads_event_key` ON `threads` (`inbox_id`,`event_key`);