// What the tests of the host's Google client given from a device share: a client file as Google's console downloads it,
// and the Node host's Google seam on a scratch data directory, as src/node/main.ts builds it.

import type { GoogleClient, GoogleOptions } from "../src/google/config.ts";
import { googleClientSource, saveGoogleClientFile, savedGoogleClient } from "../src/node/google.ts";

export const REDIRECT = "http://127.0.0.1:8585/v1/google/callback";
export const SECRET = "GOCSPX-a-secret-nobody-prints";
export const OTHER_SECRET = "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";
export const CLIENT_ID = "1234-abc.apps.googleusercontent.example";

/** The file as Google Cloud's console downloads it for a Web application client. */
export function downloaded(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    web: {
      client_id: CLIENT_ID,
      project_id: "usual-mail-owner",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_secret: SECRET,
      redirect_uris: [REDIRECT],
      ...fields,
    },
  });
}

/**
 * The Node host's seam on `dir`. `env()` stands for USUAL_MAIL_GOOGLE_CLIENT_ID and _SECRET, read at each call so a
 * test can take them away as a host would between two starts.
 */
export function nodeGoogle(dir: string, options: { env?: () => GoogleClient | null; redirect?: () => string | null; fetch?: GoogleOptions["fetch"] } = {}): GoogleOptions {
  const env = options.env ?? (() => null);
  const redirect = options.redirect ?? (() => REDIRECT);
  const log = { info: () => {}, error: () => {} };
  const file = googleClientSource({ dataDir: dir, env: null, log, redirectUri: redirect });
  return {
    client: async () => env() ?? (await file()),
    redirectUri: redirect,
    get clientFromEnvironment() {
      return env() !== null;
    },
    saveClient: (text) => saveGoogleClientFile(dir, text),
    savedClient: savedGoogleClient(dir),
    ...(options.fetch && { fetch: options.fetch }),
  };
}
