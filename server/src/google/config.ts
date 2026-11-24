// What the host gives the server for Google sign-in: its Google OAuth client (a web application client) and the
// address Google sends people back to. The client comes from the environment, or from where the host keeps it (on
// Node a file only the owner can read, src/node/google.ts), which a person's own paired device may write through
// `PUT /v1/google/client` (the owner's decision of 2026-11-21). The address comes from the host's settings, never
// from a header; on Cloudflare from the request's own host, only when it is one Cloudflare routes to the Worker on
// purpose (src/cloudflare/address.ts, docs/contract-sync.md).

/** The host's own Google OAuth client. The secret is the host's: never returned, logged or stored per inbox. */
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** A saved client as the host reads it. `reason`: the host's words for why it isn't used and how its host fixes it. */
export type SavedGoogleClient =
  | { state: "none" }
  | { state: "usable"; clientId: string }
  | { state: "refused"; reason: string };

export type GoogleFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface GoogleOptions {
  /** The client, read when it is needed, so a file the host changes takes effect at once. Null when not given. */
  client(): Promise<GoogleClient | null>;
  /** `<the server's root>/v1/google/callback`, or null while the server doesn't know its own address. */
  redirectUri(): string | null;
  /**
   * What the host does while `redirectUri()` gives none, in its own words, after core's `noAddress` sentence
   * (`GoogleSetupHostWords.addressFix`). Absent: core's words for a server its host starts itself (Node).
   */
  addressFix?: string;
  /**
   * True when the host's own settings give the client (on Node, USUAL_MAIL_GOOGLE_CLIENT_ID and
   * USUAL_MAIL_GOOGLE_CLIENT_SECRET). They win over a saved client, so a device can't give one.
   */
  clientFromEnvironment?: boolean;
  /**
   * Keeps the client a person's device gave: the text of the JSON file Google's console downloads, already checked,
   * kept where `client()` reads it from then on (on Node `<data-dir>/google-client.json`, owner-only, written through
   * a temporary file). Absent when this host keeps none (demo mode). Throws when it can't; its error must not hold the
   * text.
   */
  saveClient?(file: string): Promise<void>;
  /**
   * What the host has saved, whether the server uses it or not: a file it refuses (others can read it, it isn't a Web
   * application client's) still holds a client some inboxes may be connected with, so a device replaces it only when
   * it confirms. Absent: what `client()` gives is all that is saved.
   */
  savedClient?(): Promise<SavedGoogleClient>;
  /** Google's authorization endpoint, opened by the person's browser. A development switch points it at a fake. */
  authorizationUrl?: string;
  /** How Google's token and revocation endpoints are reached. A development switch sends them to a fake. */
  fetch?: GoogleFetch;
}

/** Google's endpoints for OAuth 2.0 for web server applications (Google's documentation, read 2026-11-17). */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Where Google sends people back, under the server's root. */
export const CALLBACK_PATH = "/v1/google/callback";
