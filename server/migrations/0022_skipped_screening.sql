-- Mail that skips Screening without letting its sender in (docs/contract.md, "Rules and learning"; the owner's decision
-- of 2026-11-25): the recipient fields the sender's own DKIM signature vouches for (`ProviderMessage.signedRecipients`,
-- which the screening gate reads), and the kind the server's AI named and the server's own check confirmed, served as
-- `Thread.skippedScreening`. Null everywhere after the upgrade: stored mail says nothing of its signature, and a code
-- that skipped Screening before says no kind.
ALTER TABLE `messages` ADD `signed_recipients` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `skipped_screening` text;
