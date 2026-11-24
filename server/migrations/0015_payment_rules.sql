-- Payment rules over stored details (docs/agents/server-ai.md; 2026-11-19, after the re-audit of the details). One
-- column: which once-only pass this store has had. The pass itself is done by the server at a start
-- (src/ai/payment-store.ts), so a build without that code that applies this migration changes nothing.
ALTER TABLE `server_state` ADD `payment_rules_applied` text;
