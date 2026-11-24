-- The server's owner (docs/contract.md, "The owner's password"; the owner's decision of 2026-11-24): one row, id 1,
-- made when the server is claimed or its password first set. Empty after the upgrade: a server paired before it has no
-- password until a signed-in device sets one, and can't be claimed, since a person's device is paired.
CREATE TABLE `owner` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text,
	`password_hash` text,
	`password_set_at` integer,
	`created_at` integer NOT NULL
);
