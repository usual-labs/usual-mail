/**
 * The host's Google OAuth client as Google Cloud's console downloads it for a Web application client
 * (`{ "web": { "client_id", "client_secret", "redirect_uris", … } }`), and how a person's device gives it to the server
 * (`PUT /v1/google/client`). One reading of the file for every part that takes it: the server (its data directory's
 * `google-client.json`, and the route) and the command (`usual-mail google set --file`). The behaviour is in
 * docs/contract-sync.md ("Connecting Gmail by signing in with Google").
 */
import type { GoogleSignInInfo } from "./google.ts";

/** The largest client file `PUT /v1/google/client` takes, in bytes. Google's own file is well under 1 KiB. */
export const GOOGLE_CLIENT_FILE_MAX_BYTES = 16_384;

/** What a client file holds that the server uses. The secret never leaves the server again. */
export interface GoogleClientFile {
  clientId: string;
  clientSecret: string;
  /** The redirect addresses the file lists, as it was when downloaded; null when it lists none (typed in by hand). */
  redirectUris: string[] | null;
}

/**
 * Why a file isn't a client the server takes. `not_json`: it isn't JSON at all. `desktop_client`: Google's file for a
 * Desktop app client (`installed`), which the server refuses (docs/agents/decisions.md, 2026-11-17). `no_web_client`:
 * JSON without `web.client_id` and `web.client_secret`.
 */
export type GoogleClientFileProblem = "not_json" | "desktop_client" | "no_web_client";

/** Reads a client file's text. Never throws, and never puts any of the text in what it answers. */
export function readGoogleClientFile(text: string): { client: GoogleClientFile } | { problem: GoogleClientFileProblem } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { problem: "not_json" };
  }
  const top = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (top && top.installed !== undefined) return { problem: "desktop_client" };
  const web = top && top.web !== null && typeof top.web === "object" ? (top.web as Record<string, unknown>) : null;
  const clientId = typeof web?.client_id === "string" ? web.client_id.trim() : "";
  const clientSecret = typeof web?.client_secret === "string" ? web.client_secret.trim() : "";
  if (!clientId || !clientSecret) return { problem: "no_web_client" };
  const uris = Array.isArray(web?.redirect_uris) ? web.redirect_uris.filter((uri): uri is string => typeof uri === "string") : null;
  return { client: { clientId, clientSecret, redirectUris: uris } };
}

/**
 * What to say when a client file doesn't list the server's redirect address: a hint, never a failure. The file holds
 * the client as it was when it was downloaded; an address added at Google later isn't in it, and Google's own list is
 * what counts. The server's log, `PUT /v1/google/client`, `usual-mail google`, `google set` and `doctor` say these
 * words. `file` names the file the way the reader knows it (a path, or "The client file").
 */
export function googleRedirectHint(file: string, redirect: string): string {
  return `${file} doesn't list ${redirect} among the client's redirect addresses. The file may simply be older than a change made at Google, where the client's own list is what counts. If Google refuses a sign-in, check that address at Google.`;
}

/**
 * Where the server's Google client comes from. `environment`: the host's settings where the server starts (on Node,
 * USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET); they win, so nothing a device gives is used.
 * `saved`: the client the host saved (on Node, `<data-dir>/google-client.json`, from `usual-mail google set` or a
 * person's device). `none`: the server has no client it can use (none given, or a saved file it refuses).
 */
export type GoogleClientSource = "environment" | "saved" | "none";

/** The server's Google client as a person's device sees it (`GET /v1/google/setup`). Never the secret. */
export interface GoogleClientState {
  source: GoogleClientSource;
  /** The client's id, as an inbox's `connection` shows it. Absent while there is none. */
  clientId?: string;
  /** True when a person's device may give the server a client now (`PUT /v1/google/client`). */
  changeable: boolean;
  /** While `changeable` is false: why, in words a person can read (the route answers these and "Nothing was saved."). */
  reason?: string;
  /**
   * What to know before giving a client, in words a person can read; absent when there is nothing to say. Today: a
   * client file is saved but the server doesn't use it (other users can read it, or it isn't a Web application
   * client's), so giving one replaces it only once the device confirms; and inboxes connected by signing in with Google
   * use a client the server doesn't have now (with their client ids), so they don't sync until it has that client again
   * or each signs in again. Added 2026-11-21, after the first shape; optional.
   */
  note?: string;
}

/** Giving the server its Google client from a person's device. In REST the body is `file` itself, `?replace=true`. */
export interface GoogleClientInput {
  /** The text of the JSON file Google Cloud's console downloads for a Web application client, as it is. */
  file: string;
  /**
   * Replace what the server has. Without it the server saves nothing and answers `conflict` while a client file is
   * saved (used or not) or inboxes are connected by signing in with Google under another client id: another client
   * stops those inboxes until each signs in again.
   */
  replace?: boolean;
}

/** What `PUT /v1/google/client` answers once the client is saved. Never the secret. */
export interface GoogleClientSaved {
  /** The saved client's id. */
  clientId: string;
  /**
   * True when something was replaced: a client file that was saved (used or not), or inboxes connected by signing in
   * with Google under another client id, which now need to sign in again.
   */
  replaced: boolean;
  /** Google sign-in after the change, as `GET /v1/info` says it. */
  googleSignIn: GoogleSignInInfo;
  /** When the file lists redirect addresses and not the server's: `googleRedirectHint`'s words, a hint only. */
  redirectHint?: string;
}
