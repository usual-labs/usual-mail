-- Notification events (docs/agents/server-ai.md; the owner's request of 2026-11-19 for the Notifications tab). One
-- column: a notification's event from the AI. Nothing is marked here: a notification without an event needs one by
-- rule (src/ai/work.ts), so a build without that code that applies this migration changes nothing, and the first
-- start of a build with it asks for every one that isn't done, trashed or gone.
ALTER TABLE `threads` ADD `event` text;
