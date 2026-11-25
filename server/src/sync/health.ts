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

/**
 * Sorts why a sync of `inbox` failed. For an inbox connected by signing in with Google the client is the host's:
 * Google refusing it is `host_setup`, in words naming how this host gives the client (`clientFix`,
 * `GoogleOptions.clientFix`), and the Gmail API off in its project is too, in words saying to turn it on there. For one
 * connected by hand the client is the person's own, so the same is theirs to fix (`needs_sign_in`): new credentials,
 * or the Gmail API turned on in their client's project. Gmail's missing scope (`kind` "scope", the same test
 * as its words) needs a new sign-in; its spent daily quota (`daily_quota`) may pass, in words saying until when.
 */
export function classifyFailure(inbox: InboxRow, error: unknown, clientFix?: string): Failure {
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
        return signedIn ? { reason: "host_setup", words: attention.clientRefused(clientFix) } : { reason: "needs_sign_in", words };
      }
      return { reason: "needs_sign_in", words: signedIn ? attention.tokenRefused : words };
    case SIGN_IN_REFUSED:
      return { reason: "needs_sign_in", words };
    case "GmailApiError": {
      const status = named.status;
      const gmailReason = typeof named.reason === "string" ? named.reason : "";
      if (status === 401 || named.kind === "scope") return { reason: "needs_sign_in", words };
      if (status === 403 && gmailReason === "accessNotConfigured") {
        return { reason: signedIn ? "host_setup" : "needs_sign_in", words: attention.gmailApiOff(signedIn) };
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
 * A sync attempt's start and end, on the wall clock. The engine takes the start as the end less the attempt's length
 * on the monotonic clock, so time the machine slept during it is left out: it falls in the gap before the attempt.
 */
export interface Attempt {
  startedAt: number;
  endedAt: number;
}

/**
 * The row after a failed attempt. A run of failures starts at the first after a good sync, or when the attempt
 * began more than `gapMs` after the last one ended (the server was stopped, or its machine asleep: that time isn't
 * failing); it counts from the attempt's start, so a long hang before a failure counts as failing, not as a gap. A
 * failure that needs the person sets its reason at once. One that may pass:
 * - leaves a refused sign-in or the host's setup as they are: only a good sync or new credentials clear those;
 * - after `not_syncing` (no attempt had finished for the stale time), is `provider_error` at once;
 * - else waits out the grace (two failures at least, `SYNC_FAILURE_GRACE_MS` since the run began), then is
 *   `provider_error`; within it the status stays as it was, except a reason-less `needs_attention` from before 0.1.2,
 *   which can't be told from one that may pass.
 */
export function afterFailure(row: InboxRow, failure: Failure, attempt: Attempt, gapMs: number): Health {
  const newRun = row.failingSince === null || row.lastAttemptAt === null || attempt.startedAt - row.lastAttemptAt > gapMs;
  const failingSince = newRun ? attempt.startedAt : row.failingSince!;
  const failures = newRun ? 1 : row.failures + 1;
  const run = { lastAttemptAt: attempt.endedAt, failingSince, failures };
  const said = row.status === "needs_attention" ? row.statusReason : undefined;
  if (failure.reason) return { ...run, status: "needs_attention", statusDetail: failure.words, statusReason: failure.reason };
  if (said === "needs_sign_in" || said === "host_setup") {
    return { ...run, status: row.status, statusDetail: row.statusDetail, statusReason: row.statusReason };
  }
  if (said === "not_syncing" || (failures >= 2 && attempt.endedAt - failingSince >= SYNC_FAILURE_GRACE_MS)) {
    return { ...run, status: "needs_attention", statusDetail: failure.words, statusReason: "provider_error" };
  }
  if (said === null) return { ...run, ...settled(row) };
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
 * The words on an inbox none of whose syncs has finished for `afterMs` while the server ran: when it last synced well
 * (`lastSyncedAt`), in the server's time zone (`Host.timeZone`: the Cloudflare setting, or a Node process's own, so `TZ`
 * in Docker), and that it has stopped finishing.
 */
export function notSyncingWords(lastSyncedAt: number | null, afterMs: number, timeZone: string | undefined): string {
  const minutes = Math.round(afterMs / 60_000);
  const synced = lastSyncedAt === null ? "hasn't synced yet" : `hasn't synced since ${when(lastSyncedAt, timeZone)}`;
  return `This inbox ${synced}, and none of its syncs has finished for over ${minutes} minutes, though the server is ` +
    "running. Try again; if it stays like this, restart the server.";
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

