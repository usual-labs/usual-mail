-- Asking the AI again (docs/agents/server-ai.md; the owner's decision of 2026-11-19, only real payments and purchases
-- are receipts). Columns only: which asking-again a store has had, and the threads marked for one. The marking itself
-- is done by the server at a start (src/ai/ask-again.ts), once per asking-again, so a build without that code that
-- applies this migration changes nothing.
ALTER TABLE `server_state` ADD `categories_asked_again` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `category_ask_again` integer DEFAULT false NOT NULL;
