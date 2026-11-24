// The once-only passes by rule at a start that share `server_state.payment_rules_applied` (no model is asked): the
// store keeps the last one it had, and has had every one before it in the order builds brought them, so a later
// build's pass doesn't run an earlier one again.

/**
 * The payment details' pass over stored details (payment-store.ts). The first ("2026-11-19 payment rules") re-read due
 * dates, cleaned parties and unified them by address; the second ("…, by domain") cut a district from a party and
 * unified by domain; this one also gives a party that is one lowercase word the sender's name.
 */
export const PAYMENT_RULES = "2026-11-19 payment rules, one-word parties";

/** Every stored thread's snippet made plain again (service/snippets.ts). */
export const SNIPPET_PASS = "2026-11-19 plain snippets";

/**
 * Every stored notification grouped again by its moment, and a limit's stored reset time dropped (event-regroup.ts).
 * This build's (2026-11-20) also joins untimed events about the same thing; the one before it was "2026-11-19 moment
 * groups".
 */
export const MOMENT_PASS = "2026-11-20 moment groups, untimed";

const ORDER: readonly string[] = [PAYMENT_RULES, SNIPPET_PASS, "2026-11-19 moment groups", MOMENT_PASS];

/** Whether a store whose marker is `marker` has had the pass `id`. */
export function hadRulePass(marker: string | null, id: string): boolean {
  if (marker === id) return true;
  const [had, asked] = [ORDER.indexOf(marker ?? ""), ORDER.indexOf(id)];
  return had >= 0 && asked >= 0 && had > asked;
}
