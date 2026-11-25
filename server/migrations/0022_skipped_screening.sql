-- Mail that skips Screening without letting its sender in (docs/contract.md, "Rules and learning"; the owner's decision
-- of 2026-11-25): the kind the server's AI named and the server's own check confirmed, served as
-- `Thread.skippedScreening`. Null on every thread after the upgrade: a code that skipped Screening before it says no kind.
ALTER TABLE `threads` ADD `skipped_screening` text;
