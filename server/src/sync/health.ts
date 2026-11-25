// When an inbox needs attention (docs/contract-sync.md, "When an inbox needs attention"; the owner's decision of
// 2026-11-25, for 0.1.2). A refused sign-in or the host's setup needs it at once, with its reason; a failure that may
// pass (no connection, a timeout, the provider's own error) only once failures have gone on for `SYNC_FAILURE_GRACE_MS`
// across two attempts or more; a sync that never finishes is the watch's (watch.ts). Pure functions over the inbox's
// row, so each case is tested on its own; the engine stores what they give.

import { SIGN_IN_REFUSED, SYNC_FAILURE_GRACE_MS } from "@usualmail/core";
import type { InboxRow } from "../db/index.ts";
import { attention } from "../google/words.ts";
import { errorMessage } from "../util.ts";

/** A failed sync attempt, sorted: what needs the person at once (`reason`), or a failure that may pass (null). */
export interface Failure {
  reason: "needs_sign_in" | "host_setup" | null;
  /** In words a person can act on: the server's own for Google's cases, else the provider's. */
  words: string;
}

/** Gmail's reasons for a 403 that a new sign-in fixes: the token lacks the scope. */
const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);

/**
 * Sorts why a sync of `inbox` failed. For an inbox connected by signing in with Google the host's client is the
 * host's: Google refusing it, or the Gmail API off in its project, is `host_setup`. For one connected by hand the client
 * is the person's own, so the same is theirs to fix with new credentials (`needs_sign_in`).
 */
export function classifyFailure(inbox: InboxRow, error: unknown): Failure {
  const words = errorMessage(error);
  if (!(error instanceof Error)) return { reason: null, words };
  const signedIn = inbox.connection?.kind === "gmail" && inbox.connection.signIn === "google";
  const named = error as Error & { reason?: unknown; kind?: unknown; status?: unknown };
  switch (error.name) {
    // google/credentials.ts: no Google client on the server, or the inbox signed in with another one.
    case "InboxAccessError":
      return { reason: named.reason === "host_setup" ? "host_setup" : "needs_sign_in", words };
    case "GoogleTokenError":
      if (named.kind === "client_refused") {
        return signedIn ? { reason: "host_setup", words: attention.clientRefused } : { reason: "needs_sign_in", words };
      }
      return { reason: "needs_sign_in", words: signedIn ? attention.tokenRefused : words };
    case SIGN_IN_REFUSED:
      return { reason: "needs_sign_in", words };
    case "GmailApiError": {
      const status = named.status;
      const gmailReason = typeof named.reason === "string" ? named.reason : "";
      if (status === 401 || (status === 403 && SCOPE_REASONS.has(gmailReason))) return { reason: "needs_sign_in", words };
      if (status === 403 && gmailReason === "accessNotConfigured") {
        return { reason: signedIn ? "host_setup" : "needs_sign_in", words };
      }
      return { reason: null, words };
    }
    default:
      return { reason: null, words };
  }
}

/** What a sync attempt leaves on the inbox's row. */
export type Health = Pick<
  InboxRow,
  "status" | "statusDetail" | "statusReason" | "lastAttemptAt" | "failingSince" | "failures"
>;

/**
 * The row after a failed attempt at `now`. A run of failures starts at the first after a good sync, or after a gap
 * longer than `gapMs` since the last attempt (the server was stopped, or its machine asleep: that time isn't failing).
 * A failure that needs the person sets its reason at once; one that may pass waits out the grace, then is
 * `provider_error`. Within the grace the status stays as it was, except that a finished attempt ends `not_syncing`
 * (and a reason-less `needs_attention` from before 0.1.2, which can't be told from one that may pass).
 */
export function afterFailure(row: InboxRow, failure: Failure, now: number, gapMs: number): Health {
  const newRun = row.failingSince === null || row.lastAttemptAt === null || now - row.lastAttemptAt > gapMs;
  const failingSince = newRun ? now : row.failingSince!;
  const failures = newRun ? 1 : row.failures + 1;
  const run = { lastAttemptAt: now, failingSince, failures };
  if (failure.reason) return { ...run, status: "needs_attention", statusDetail: failure.words, statusReason: failure.reason };
  if (failures >= 2 && now - failingSince >= SYNC_FAILURE_GRACE_MS) {
    return { ...run, status: "needs_attention", statusDetail: failure.words, statusReason: "provider_error" };
  }
  const silent = row.status === "needs_attention" && (row.statusReason === "not_syncing" || row.statusReason === null);
  if (silent) return { ...run, ...settled(row) };
  return { ...run, status: row.status, statusDetail: row.statusDetail, statusReason: row.statusReason };
}

/** The row after a good sync at `now`: `ok`, and no run of failures. */
export function afterSuccess(now: number): Health {
  return { status: "ok", statusDetail: null, statusReason: null, lastAttemptAt: now, failingSince: null, failures: 0 };
}

/** What a warning that no longer holds goes back to: `ok`, or `connecting` before the inbox's first good sync. */
export function settled(row: Pick<InboxRow, "lastSyncedAt">): Pick<Health, "status" | "statusDetail" | "statusReason"> {
  return { status: row.lastSyncedAt === null ? "connecting" : "ok", statusDetail: null, statusReason: null };
}

/**
 * The words on an inbox no sync of which has finished for `afterMs` while the server ran: since when it last synced,
 * in the server's time zone, or for how long.
 */
export function notSyncingWords(lastSyncedAt: number | null, afterMs: number, timeZone: string | undefined): string {
  const minutes = Math.round(afterMs / 60_000);
  const since = lastSyncedAt === null ? `for over ${minutes} minutes` : `since ${when(lastSyncedAt, timeZone)}`;
  return `No sync of this inbox has finished ${since}, though the server is running. Try again; if it stays like ` +
    "this, restart the server.";
}

/** "25 Nov, 14:02 UTC" in the server's zone, UTC when it has none or names none Intl knows. */
function when(time: number, timeZone: string | undefined): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
    }).format(time);
  try {
    return format(timeZone ?? "UTC");
  } catch {
    return format("UTC");
  }
}

