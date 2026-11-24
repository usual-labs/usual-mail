-- Payment details (docs/agents/server-ai.md; the owner's request of 2026-11-19 for the Receipts tab). One column: a
-- receipt's or invoice's details from the AI. Nothing is marked here: a receipt or invoice without details needs them by
-- rule (src/ai/work.ts), so a build without that code that applies this migration changes nothing, and the first start
-- of a build with it asks for every one that isn't done, trashed or gone.
ALTER TABLE `threads` ADD `payment` text;
