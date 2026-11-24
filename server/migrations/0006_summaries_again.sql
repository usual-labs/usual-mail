-- The upgrade of 2026-11-18 (docs/agents/server.md): builds before it dropped a summarize answer over 200 characters,
-- or one naming the sender, and cleared the thread's summary_due, so it was never asked again. Once, at the first
-- start of a build with this migration, every thread without a summary that isn't a one-time code, done, trashed or
-- removed is due a summary again; the AI then works through them as history, newest first.
UPDATE `threads` SET `summary_due` = 1
WHERE `summary` IS NULL AND `category` <> 'otp' AND `done` = 0 AND `trashed` = 0 AND `removed` = 0 AND `summary_due` = 0;
