-- How far a first sync has got (docs/contract-sync.md; the owner's decision of 2026-11-23): two columns on the inbox,
-- the count the server last showed while its first sync runs (`Inbox.firstSync`). Null on every inbox after the
-- upgrade, a first sync in progress included: its count comes with its next batch. Nothing else changes.
ALTER TABLE `inboxes` ADD `first_sync_fetched` integer;--> statement-breakpoint
ALTER TABLE `inboxes` ADD `first_sync_total` integer;