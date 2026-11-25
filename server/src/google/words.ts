// What the server tells a person about a Google sign-in: on the page Google sends them back to, in the sign-in's
// outcome, and on an inbox that needs attention. Only the server's own sentences; nothing Google sent is repeated,
// except a mailbox's address (escaped wherever it is shown).

import { GOOGLE_CLIENT_FILE_MAX_BYTES, type GoogleSignInFailure, type GoogleSignInMissing } from "@usualmail/core";

const AGAIN = "Start again in Usual Mail.";

export const words = {
  connected: (address: string) => `Gmail is connected: ${address}. Go back to Usual Mail; you can close this tab.`,
  reconnected: (address: string) =>
    `${address} is reconnected, with its rules, history and settings. Go back to Usual Mail; you can close this tab.`,
  declined: `You didn't allow Usual Mail to use this Google account, so nothing was connected. ${AGAIN} On Google's screen, choose Continue.`,
  scopeMissing:
    "Google's screen left Gmail access unticked, and Usual Mail can't work without reading and changing your mail, so " +
    `nothing was connected. ${AGAIN} Tick the box for reading, composing and sending your email.`,
  noRefreshToken:
    "Google didn't give this server lasting access to the mailbox, so nothing was connected. Start again. If it happens " +
    "again, remove Usual Mail's access in your Google Account (Security, Your connections to third-party apps and " +
    "services), then start again.",
  expired: `This sign-in expired before you came back from Google, so nothing was connected. ${AGAIN}`,
  wrongAccount: (got: string, want: string) =>
    `You signed in as ${got}, but this inbox is ${want}, so nothing changed. Start again and choose ${want} on Google's screen.`,
  deviceRemoved: `The device that started this sign-in was removed from Usual Mail, so nothing was connected. ${AGAIN}`,
  inboxRemoved: "The inbox being reconnected was removed while you were signing in, so nothing changed. Start again to connect it.",
  googleError: `Google didn't finish the sign-in, so nothing was connected. ${AGAIN}`,
  codeRefused: `Google didn't accept the sign-in, so nothing was connected. ${AGAIN}`,
  adminPolicy:
    "Your organisation's Google administrator doesn't allow this app to use Gmail, so nothing was connected. Ask the " +
    "administrator, or Start again with another account.",
  orgInternal:
    "This Google client only accepts accounts of its own organisation, so nothing was connected. Start again with an " +
    "account of that organisation, or set the client's audience to External at Google.",
  notSetUp: `Google sign-in is no longer set up on this server, so nothing was connected. Its host must give it the Google client again; then ${AGAIN.toLowerCase()}`,
  clientRefused:
    "Google refused this server's Google client (its id or secret is wrong, or it was deleted), so nothing was " +
    "connected. Its host must give the server the right client (usual-mail google set); then start again.",
  mailboxError: (detail: string) =>
    `You signed in, but Gmail didn't accept the new access (${detail}), so nothing was connected. Start again. If it ` +
    "happens again, check that the Gmail API is turned on in the Google Cloud project.",
  unknownState:
    "This sign-in isn't one this server is waiting for: it was used already, it expired a while ago, or its address " +
    `was changed. Nothing was connected. ${AGAIN}`,
  alreadyUsed: "This sign-in was already used, so nothing more happened. Go back to Usual Mail to see how it went.",
};

/** The page's heading for each way a sign-in can end. */
export const headings: Record<GoogleSignInFailure | "connected" | "unknown", string> = {
  connected: "Gmail is connected",
  declined: "Nothing was connected",
  scope_missing: "Gmail access was left out",
  no_refresh_token: "Google gave no lasting access",
  expired: "This sign-in expired",
  wrong_account: "That's another account",
  cancelled: "This sign-in was cancelled",
  google_error: "Google didn't finish the sign-in",
  mailbox_error: "Gmail didn't accept it",
  unknown: "This sign-in can't be used",
};

/** Why starting answers `conflict`: what the host still has to give. */
export function notAvailable(missing: GoogleSignInMissing[]): string {
  const parts = missing.map((part) =>
    part === "client"
      ? "its host hasn't given it a Google OAuth client (usual-mail google set, or USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET)"
      : "it doesn't know its own address (USUAL_MAIL_PUBLIC_URL)",
  );
  return `Google sign-in isn't set up on this server: ${parts.join(", and ")}. Connect Gmail with a client id, secret and refresh token instead, or ask the host.`;
}

/**
 * How a server its host starts itself (Node, Docker) is given its Google client, in the words below; a host whose way
 * differs says its own (`GoogleOptions.clientFix`: on Cloudflare, the Worker's secrets).
 */
export const NODE_CLIENT_FIX = "usual-mail google set";

/** Words on an inbox connected by signing in with Google when its access stops working. */
export const attention = {
  tokenRefused:
    "Google no longer accepts this inbox's sign-in: it was revoked, it expired (while the Google client's consent " +
    "screen is in Testing, a sign-in lasts seven days), or the account's password changed. Sign in with Google again " +
    "to reconnect it; its rules and history stay.",
  /** `fix`: how this host gives the server its client (`GoogleOptions.clientFix`). */
  clientRefused: (fix: string = NODE_CLIENT_FIX) =>
    "Google refused this server's Google client (its id or secret is wrong, or it was deleted). The host must give the " +
    `server the right client (${fix}); then the inbox syncs again.`,
  clientMissing: (fix: string = NODE_CLIENT_FIX) =>
    "This inbox was connected by signing in with Google, but Google sign-in isn't set up on this server any more. Its " +
    `host must give the server its Google client again (${fix}); then the inbox syncs again.`,
  otherClient:
    "This inbox was connected with another Google client than the one this server has now. Sign in with Google again " +
    "to reconnect it with this one; its rules and history stay.",
};

/**
 * What `PUT /v1/google/client` answers when it saves nothing, and why a device can't give a client
 * (`GoogleClientState.reason`). Only the server's own sentences: never anything of the file a device sent. The apps
 * show the replace cases' words above their own "Replace it" button, so those name no flag: a caller confirms with
 * `?replace=true`, as the contract says.
 */
export const clientWords = {
  /** Why a device can't give a client (`GoogleClientState.reason`); the route adds `notSavedYet`. */
  environment:
    "USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET give this server its Google client where it " +
    "starts, and they win over a saved one, so a client given here would do nothing. Its host changes them there.",
  notKept: "This server keeps no Google client: it runs in demo mode, with made-up mail and nothing kept.",
  notSavedYet: "Nothing was saved.",
  tooLarge:
    `That file is too large to be a Google client file (at most ${GOOGLE_CLIENT_FILE_MAX_BYTES} bytes), so nothing was ` +
    "saved. Give the JSON file Google Cloud's console downloads for the client, as it is.",
  not_json:
    "That isn't a Google OAuth client file, so nothing was saved. Give the JSON file Google Cloud's console downloads " +
    "for the client, as it is.",
  desktop_client:
    "That file holds a Desktop app client, so nothing was saved. Create an OAuth client of type Web application at " +
    "Google and give its JSON file instead.",
  no_web_client:
    "That isn't a Google OAuth client file, so nothing was saved: it needs web.client_id and web.client_secret, as " +
    "Google downloads them. Give the JSON file Google Cloud's console downloads for the client, as it is.",
  otherClient:
    "This server already has another Google client, so nothing was saved. Replacing it stops every inbox connected " +
    "by signing in with Google from syncing until each is signed in with Google again. Confirm to replace it.",
  sameClient:
    "This server already has this Google client (the same client id), so nothing was saved. Saving it again, for " +
    "example with a new secret, keeps its inboxes working. Confirm to replace it.",
  /** A saved file the server refuses still holds a client inboxes may be connected with. `reason` is the host's. */
  refusedFile: (reason: string) =>
    `This server already has a Google client file, so nothing was saved. It doesn't use that file: ${reason}. ` +
    "Replacing it stops any inbox connected with the client in it from syncing until each is signed in with Google " +
    "again. Confirm to replace it.",
  /** Inboxes signed in with another client than the one given, when the server has no client of its own. */
  stranded: (count: number, clientIds: string[]) =>
    `${inboxCount(count)} connected by signing in with Google ${count === 1 ? "uses" : "use"} another Google client ` +
    `(${clientIds.join(", ")}), so nothing was saved: with this one ${count === 1 ? "it" : "they"} won't sync until ` +
    `${count === 1 ? "it is" : "each is"} signed in with Google again. Confirm to save it anyway.`,
  /** `GoogleClientState.note`: a saved file the server doesn't use. */
  refusedFileNote: (reason: string) =>
    `A Google client file is saved, but the server doesn't use it: ${reason}. Giving a client here replaces it once you confirm.`,
  /** `GoogleClientState.note`: inboxes signed in with a client the server doesn't have now. */
  strandedNote: (count: number, clientIds: string[]) =>
    `${inboxCount(count)} connected by signing in with Google ${count === 1 ? "uses" : "use"} a Google client this ` +
    `server doesn't have now (${clientIds.join(", ")}), so ${count === 1 ? "it doesn't" : "they don't"} sync. Giving ` +
    `the server that client again brings ${count === 1 ? "it" : "them"} back; with any other, each must sign in with ` +
    "Google again.",
  notSaved: "The server couldn't save the Google client, so nothing changed. The server's log says why.",
  replaceFlag: "replace must be true or false",
};

function inboxCount(count: number): string {
  return count === 1 ? "1 inbox" : `${count} inboxes`;
}
