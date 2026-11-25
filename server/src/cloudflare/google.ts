// Google sign-in on Cloudflare (`GoogleOptions`): the host's Google client, which a person's paired device gives through
// `PUT /v1/google/client` and the host keeps sealed with the server's own key (src/secrets.ts) in the object's storage,
// or, optionally, the Worker secrets USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET (Node's names),
// which win, as on Node. Google's redirect address comes from the request being answered (address.ts).
// The client file's text and its secret are never logged or answered, and are stored only sealed.

import { readGoogleClientFile, type GoogleClientFile } from "@usualmail/core";
import type { GoogleClient, GoogleOptions, SavedGoogleClient } from "../google/config.ts";
import type { Log, Secrets } from "../host.ts";
import { ADDRESS_FIX } from "./address.ts";

/** The sealed client file's name in the object's key-value storage (the `_cf_KV` table Data Studio shows). */
export const GOOGLE_CLIENT_KEY = "usual-mail-google-client";
/** Authenticated with the sealed text, so a value sealed for anything else never opens as the client. */
const SEAL_CONTEXT = "google-client-file";

/** The Worker's Google settings, as wrangler.jsonc and the dashboard give them. */
export interface GoogleEnv {
  USUAL_MAIL_GOOGLE_CLIENT_ID?: string;
  USUAL_MAIL_GOOGLE_CLIENT_SECRET?: string;
}

/** Both secrets or neither. One alone is left out, with words for the log, never its value. */
/**
 * How a Cloudflare host gives the server its Google client (`GoogleOptions.clientFix`): the Worker's secrets, which win
 * over a client a device gave.
 */
const CLIENT_FIX = "the Worker's secrets USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET, in its settings";

export function environmentClient(env: GoogleEnv): { client: GoogleClient | null; problem?: string } {
  const clientId = env.USUAL_MAIL_GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.USUAL_MAIL_GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId && !clientSecret) return { client: null };
  if (!clientId || !clientSecret) {
    return {
      client: null,
      problem:
        "Google sign-in: USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET are given together or not at " +
        "all; with only one set, neither is used.",
    };
  }
  return { client: { clientId, clientSecret } };
}

type Read =
  | { state: "none" }
  | { state: "usable"; client: GoogleClientFile }
  | { state: "refused"; reason: string };

/** Why a saved client can't be opened, as a person's device is told (`SavedGoogleClient.reason`). */
const UNOPENED =
  "the server can't open it with its secret key (USUAL_MAIL_SECRET_KEY was set or changed after it was saved), so " +
  "the client must be given again";

export interface CloudflareGoogleOptions {
  kv: SyncKvStorage;
  secrets: Secrets;
  env: GoogleEnv;
  log: Log;
  redirectUri: () => string | null;
}

/** The host's Google seam on Cloudflare: every member `src/google/setup.ts` relies on, the replace guard's included. */
export function cloudflareGoogle(options: CloudflareGoogleOptions): GoogleOptions {
  const { kv, secrets, log } = options;
  const fromEnv = environmentClient(options.env);
  if (fromEnv.problem) log.info(fromEnv.problem);
  let refusedSaid = false;

  const read = async (): Promise<Read> => {
    const sealed = kv.get<string>(GOOGLE_CLIENT_KEY);
    if (typeof sealed !== "string" || !sealed) return { state: "none" };
    let text: string;
    try {
      text = await secrets.open(sealed, SEAL_CONTEXT);
    } catch {
      if (!refusedSaid) log.info(`Google sign-in is off: the saved Google client can't be opened with the server's secret key. Give the client again.`);
      refusedSaid = true;
      return { state: "refused", reason: UNOPENED };
    }
    // Checked before it was saved; read again so a stored value is never trusted blindly.
    const file = readGoogleClientFile(text);
    if ("problem" in file) return { state: "refused", reason: "it isn't a Google OAuth client file" };
    return { state: "usable", client: file.client };
  };

  return {
    async client() {
      if (fromEnv.client) return fromEnv.client;
      const saved = await read();
      return saved.state === "usable" ? { clientId: saved.client.clientId, clientSecret: saved.client.clientSecret } : null;
    },
    redirectUri: options.redirectUri,
    addressFix: ADDRESS_FIX,
    clientFix: CLIENT_FIX,
    clientFromEnvironment: fromEnv.client !== null,
    async saveClient(file) {
      const sealed = await secrets.seal(file, SEAL_CONTEXT);
      kv.put(GOOGLE_CLIENT_KEY, sealed);
      refusedSaid = false;
    },
    async savedClient(): Promise<SavedGoogleClient> {
      const saved = await read();
      if (saved.state === "usable") return { state: "usable", clientId: saved.client.clientId };
      return saved;
    },
  };
}

/** The start's line about Google sign-in, never naming the secret. */
export function googleStartWords(google: GoogleOptions, publicOrigin: string | null, hasClient: boolean): string {
  const where = publicOrigin ? `its workers.dev address or ${publicOrigin}` : "its workers.dev address";
  const client = google.clientFromEnvironment
    ? "its Google client from USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET"
    : hasClient
      ? "the Google client a person's device gave it"
      : "no Google client yet (a person's paired device gives it, in the Usual Mail app's Google set-up)";
  return `Google sign-in: ${client}; Google sends people back to https://<the address a request comes to>/v1/google/callback, for ${where} only.`;
}
