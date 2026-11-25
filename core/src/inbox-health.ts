/**
 * Why an inbox needs attention, and when a failing or silent sync counts as one (docs/contract-sync.md, "When an
 * inbox needs attention"; the owner's decision of 2026-11-25, for 0.1.2).
 */

/**
 * Why an inbox is `needs_attention` (`Inbox.statusReason`), so an interface offers the step that fits:
 * - `needs_sign_in`: the mailbox refused the inbox's sign-in (Google's refresh token, or the IMAP login). Sign in
 *   again, or give new credentials.
 * - `host_setup`: the host's own setup stops it, as the server's Google client being refused or gone. The host fixes
 *   it; signing in again doesn't help.
 * - `provider_error`: the provider kept failing for `SYNC_FAILURE_GRACE_MS` (it couldn't be reached, timed out or
 *   answered with errors). Trying again may do; `statusDetail` has the provider's words.
 * - `not_syncing`: no sync of the inbox has finished, good or failed, for `notSyncingAfterMs` while the server ran.
 *
 * A server from before 0.1.2 sends none, and a later one may send another: interfaces then act as for an unknown
 * reason (statusDetail's words, the inbox's settings).
 */
export type InboxStatusReason = "needs_sign_in" | "host_setup" | "provider_error" | "not_syncing";

/**
 * How long syncs of an inbox may fail with errors that may pass (no connection, a timeout, the provider's own error)
 * before it needs attention, counted from the first failure after its last good sync, and only across two failed
 * attempts or more. A refused sign-in or the host's setup needs attention at once.
 */
export const SYNC_FAILURE_GRACE_MS = 10 * 60_000;

/** The least time without a finished sync before an inbox is `not_syncing` (see `notSyncingAfterMs`). */
export const NOT_SYNCING_MIN_MS = 15 * 60_000;

/** How many poll intervals without a finished sync make an inbox `not_syncing`, when that is longer. */
export const NOT_SYNCING_POLLS = 5;

/**
 * How long an inbox that isn't paused may go without a finished sync, good or failed, while the server runs before it
 * is `not_syncing`: the larger of 15 minutes and five poll intervals. Time while the server was stopped, its machine
 * asleep, or since it started or woke doesn't count, and neither does a first sync that is still fetching.
 */
export function notSyncingAfterMs(pollIntervalMs: number): number {
  return Math.max(NOT_SYNCING_MIN_MS, NOT_SYNCING_POLLS * pollIntervalMs);
}

/**
 * The `name` of the error a provider throws when the mailbox refuses the stored credentials (a wrong or changed IMAP
 * password, say), so the server can tell a refused sign-in from a failure that may pass.
 */
export const SIGN_IN_REFUSED = "SignInRefused";
