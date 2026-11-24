/**
 * Connecting Gmail by signing in with Google: the server runs Google's sign-in with the Google OAuth client its host
 * gave it, receives the answer itself, and keeps the token. The behaviour, the safety rules and Google's own rules
 * are in docs/contract-sync.md ("Connecting Gmail by signing in with Google").
 */
import type { Id, InboxIcon, IsoTime } from "./domain.ts";

/** The one scope the server asks for: read, change, label and send mail, never delete it for good. Restricted. */
export const GOOGLE_GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** Whether this server can connect Gmail by signing in with Google. Part of `GET /v1/info`. */
export interface GoogleSignInInfo {
  /** True when the host gave the server a Google OAuth client and the server knows its own address. */
  available: boolean;
  /**
   * Where Google sends a person back after signing in: `<the server's root>/v1/google/callback`. The host registers
   * exactly this at Google as an authorized redirect URI. Absent while the server doesn't know its own address.
   */
  redirectUri?: string;
  /** What the host still has to give the server, while it isn't available: its Google client, its own address. */
  missing?: GoogleSignInMissing[];
}

export type GoogleSignInMissing = "client" | "address";

/** Starting a sign-in. Person only. */
export interface GoogleSignInInput {
  /** Reconnect this Gmail inbox in place. Without it, the sign-in connects a new inbox. */
  inboxId?: Id;
  /** For a new inbox only. Default: the mailbox's address. */
  name?: string;
  /** For a new inbox only: "#RRGGBB". Default: the slate hat's colour. */
  color?: string;
  /** For a new inbox only. Default: the next of person, building and briefcase in turn, as when connecting. */
  icon?: InboxIcon;
}

/** A sign-in that was started: what to open, and how to ask how it ended. */
export interface GoogleSignInStart {
  /** Ask how it ended with `GET /v1/google/sign-ins/:id`. */
  id: Id;
  /** Open this in the person's browser: Google's sign-in, which sends them back to the server. */
  url: string;
  /** After this the sign-in can no longer be finished; start a new one. */
  expiresAt: IsoTime;
}

/** `waiting` until the person comes back from Google (or it expires), then `connected` or `failed`. */
export type GoogleSignInState = "waiting" | "connected" | "failed";
export const GOOGLE_SIGN_IN_STATES = ["waiting", "connected", "failed"] as const;

/**
 * Why a sign-in failed. `declined`: the person didn't allow it at Google. `scope_missing`: they left Gmail access
 * unticked. `no_refresh_token`: Google gave no lasting access. `expired`: not finished in time. `wrong_account`:
 * they signed in with another account than the inbox being reconnected. `cancelled`: the device that started it, or
 * the inbox being reconnected, was removed meanwhile. `google_error`: Google refused or didn't answer.
 * `mailbox_error`: Gmail didn't accept the new access.
 */
export type GoogleSignInFailure =
  | "declined"
  | "scope_missing"
  | "no_refresh_token"
  | "expired"
  | "wrong_account"
  | "cancelled"
  | "google_error"
  | "mailbox_error";
export const GOOGLE_SIGN_IN_FAILURES = [
  "declined",
  "scope_missing",
  "no_refresh_token",
  "expired",
  "wrong_account",
  "cancelled",
  "google_error",
  "mailbox_error",
] as const;

/** How a sign-in stands, for the device that started it (`GET /v1/google/sign-ins/:id`). */
export interface GoogleSignIn {
  id: Id;
  state: GoogleSignInState;
  /** The inbox being reconnected, or, once `connected`, the inbox connected or reconnected. */
  inboxId?: Id;
  /** Once `connected`: true when an existing inbox was reconnected in place, false for a new inbox. */
  reconnected?: boolean;
  /** Once `failed`: why. */
  failure?: GoogleSignInFailure;
  /** Once it ended: what happened, in words a person can act on. The same words as the page Google sent them to. */
  message?: string;
  expiresAt: IsoTime;
}

/**
 * Google's rules, in words for whoever sets the server's Google client up (the command and the dashboard show
 * them). Checked against Google's documentation on 2026-11-17; docs/google-setup.md has the sources.
 */
export const GOOGLE_RULES_WORDS: readonly string[] = [
  "Reading and changing Gmail (the gmail.modify scope) is one of Google's restricted scopes.",
  "Until Google verifies the app, Google warns that it isn't verified before anyone signs in; you continue past the " +
    "warning. An app only you, or a few people you know, use doesn't need verification.",
  "While the Google client's consent screen is in Testing, only the test users you list (up to 100) can sign in, " +
    "and Google ends each sign-in after seven days: sign in with Google again each week. Published (In production) " +
    "and unverified, the weekly sign-in ends, the warning stays, and at most 100 people can ever sign in.",
  "A server hosted for other people needs Google's verification, and for a restricted scope a security assessment " +
    "by an assessor Google names, repeated every year.",
];
