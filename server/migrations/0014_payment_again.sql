-- Payment details asked again (docs/agents/server-ai.md; 2026-11-19, after an audit of the first details). Columns
-- only: which asking-again of details a store has had, and the threads marked for it. The marking is done by the
-- server at a start (src/ai/ask-again.ts), once, so a build without that code that applies this migration changes
-- nothing.
ALTER TABLE `server_state` ADD `details_asked_again` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `payment_again` integer DEFAULT false NOT NULL;
