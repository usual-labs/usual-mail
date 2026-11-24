/**
 * The server's owner and their password (docs/contract.md, "The owner's password"). One owner per server. The first
 * to claim an unclaimed server owns it, unless the host named the owner's email, which Sign in with Google must then
 * prove. A password lets any device of the owner's sign in; a person's paired device may set a new one.
 */
import type { IsoTime } from "./domain.ts";

/** The shortest password the server takes, in characters (after Unicode NFKC normalisation). */
export const OWNER_PASSWORD_MIN = 12;
/** The longest. */
export const OWNER_PASSWORD_MAX = 256;

/**
 * How an unclaimed server is claimed: "password", by whoever comes first; "google", when the host named the owner's
 * email (`USUAL_MAIL_OWNER_EMAIL`), by signing in with Google as that address first.
 */
export type OwnerClaim = "password" | "google";

/** What `GET /v1/info` says of the owner. A server from before the owner's password sends none: treat it as `NO_OWNER_INFO`. */
export interface OwnerInfo {
  /** Whether the owner has set a password, so a device may sign in with it (`POST /v1/owner/sign-in`). */
  password: boolean;
  /**
   * Whether the server can be claimed now: it has no password and no person's device is paired. Once either exists
   * it can't: a server paired before the password existed gets its password from a signed-in device.
   */
  claimable: boolean;
  /** How it is claimed, while it is claimable. */
  claim?: OwnerClaim;
}

/** What an older server's missing `owner` means. */
export const NO_OWNER_INFO: OwnerInfo = { password: false, claimable: false };

/** `POST /v1/owner/claim`, no token: makes the caller the owner and pairs its device as a person's. */
export interface OwnerClaimInput {
  password: string;
  /** What the person will see in the device list. */
  name: string;
  /** The owner's email, optional, shown on the dashboard. With `claim: "google"` it is Google's and this is ignored. */
  email?: string;
  /** With `claim: "google"`: the one-time proof the Google sign-in left (`startOwnerClaim`), for ten minutes. */
  proof?: string;
}

/** `POST /v1/owner/sign-in`, no token: pairs the caller's device as a person's with the owner's password. */
export interface OwnerSignInInput {
  password: string;
  /** What the person will see in the device list. */
  name: string;
}

/** `PUT /v1/owner/password`, a person: sets the owner's password, a first one or a new one. No old one is asked for. */
export interface OwnerPasswordInput {
  password: string;
}

/** `GET /v1/owner`, a person: the owner as the server keeps them. Never the password or its hash. */
export interface Owner {
  email: string | null;
  password: boolean;
  /** When the password was last set; absent without one. */
  passwordSetAt?: IsoTime;
}

/**
 * `POST /v1/owner/recovery-code`, no token: asks the server to make a recovery code, a pairing code for a person's
 * device, and to put it where its host puts the owner's code (a file in the data directory and its log on Node; the
 * owner's code's table in Data Studio on Cloudflare). It is never in the answer. While no person's device is paired,
 * the owner's code already waits there and no other is made. One recovery code at a time; it works once.
 */
export interface RecoveryCodeAnswer {
  /** "owner": the owner's code waits; "recovery": a recovery code waits. */
  kind: "owner" | "recovery";
  /** When the waiting code stops working. */
  expiresAt: IsoTime;
}

/** How long a recovery code works. */
export const RECOVERY_CODE_TTL_MS = 30 * 60_000;

/**
 * `POST /v1/owner/claim/google`, no token, while the server is claimable with `claim: "google"`: Google's address for
 * the browser. Google sends it back to `/v1/google/callback`; when the verified email is the host's owner email, the
 * server sends the browser on to the dashboard's `/claim?proof=<proof>`, where the password is set.
 */
export interface OwnerClaimStart {
  url: string;
  expiresAt: IsoTime;
}
