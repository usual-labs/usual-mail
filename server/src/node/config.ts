// Settings from flags and environment variables. Flags win.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { GoogleClient } from "../google/config.ts";

export interface Config {
  dataDir: string;
  port: number;
  host: string;
  demo: boolean;
  /** Base64 or base64url, 32 bytes. Otherwise a key file in the data directory is used. */
  secretKey: string | null;
  pollIntervalMs: number;
  /**
   * How many days of mail a new inbox's first sync takes, from USUAL_MAIL_SYNC_DAYS; null when it isn't set, and then
   * the data directory's settings.json decides (`firstSyncDays` in settings.ts).
   */
  syncWindowDays: number | null;
  /**
   * Development only: the server's AI answers from fake models, and nothing is sent to any AI service. Refused unless
   * the server listens on this machine only and NODE_ENV isn't "production", so a release can't start with it by
   * accident.
   */
  devFakeAi: boolean;
  /**
   * The address people reach the server at, as an origin ("https://mail.example.org"), for Google sign-in's redirect
   * address. Null: the loopback address it listens on, when it listens on this machine only; otherwise unknown.
   */
  publicUrl: string | null;
  /** The host's Google client from USUAL_MAIL_GOOGLE_CLIENT_ID and _SECRET; null to read the data directory's file. */
  googleClient: GoogleClient | null;
  /**
   * Development only: Google's sign-in, token, revocation and Gmail addresses go to a fake at this loopback origin, and
   * nothing reaches Google. Refused like --dev-fake-ai.
   */
  devFakeGoogle: string | null;
  help: boolean;
}

export const USAGE = `Usage: usual-mail-server [options]

  --data-dir <path>   Where the database and the secret key live (USUAL_MAIL_DATA_DIR, default ./data)
  --port <number>     Port to listen on (USUAL_MAIL_PORT, default 8484)
  --host <address>    Address to listen on (USUAL_MAIL_HOST, default 127.0.0.1)
  --demo              Start on a fresh in-memory store filled with the sample data
  --public-url <url>  The address people reach the server at, for Google sign-in (USUAL_MAIL_PUBLIC_URL; default
                      http://127.0.0.1:<port> when it listens on this machine only). HTTPS unless it is this machine
  --dev-fake-ai       Development only: the AI answers from fake models and nothing reaches an AI service.
                      Only with --host 127.0.0.1, ::1 or localhost, and never with NODE_ENV=production
  --dev-fake-google <url>
                      Development only: Google's sign-in, token and Gmail addresses go to a fake at <url> on this
                      machine; nothing reaches Google. The same limits as --dev-fake-ai
  --help              Show this

Environment only:
  USUAL_MAIL_SECRET_KEY      32 bytes in base64 that seal mailbox credentials (default: <data-dir>/secret.key)
  USUAL_MAIL_POLL_SECONDS    How often to check mailboxes that can't push changes (default 60)
  USUAL_MAIL_SYNC_DAYS       How many days of mail a new inbox's first sync takes. Wins over syncDays in
                             <data-dir>/settings.json, which \`usual-mail init\` and \`sync-days\` write (default 30)
  USUAL_MAIL_GOOGLE_CLIENT_ID, USUAL_MAIL_GOOGLE_CLIENT_SECRET
                             The host's Google OAuth client (a web application client), both or neither. Without
                             them the server reads <data-dir>/google-client.json, as Google's console downloads it
`;

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

export function readConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const { values } = parseArgs({
    args: argv,
    options: {
      "data-dir": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      demo: { type: "boolean", default: false },
      "dev-fake-ai": { type: "boolean", default: false },
      "public-url": { type: "string" },
      "dev-fake-google": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  const host = values.host ?? env.USUAL_MAIL_HOST ?? "127.0.0.1";
  const devFakeAi = values["dev-fake-ai"] ?? false;
  if (devFakeAi && !LOOPBACK.includes(host)) {
    throw new Error(`--dev-fake-ai is for development on this machine only: it needs --host 127.0.0.1, ::1 or localhost, not ${host}`);
  }
  if (devFakeAi && env.NODE_ENV === "production") throw new Error("--dev-fake-ai can't be used with NODE_ENV=production");
  const devFakeGoogle = values["dev-fake-google"] ?? null;
  if (devFakeGoogle !== null) {
    if (!LOOPBACK.includes(host)) {
      throw new Error(`--dev-fake-google is for development on this machine only: it needs --host 127.0.0.1, ::1 or localhost, not ${host}`);
    }
    if (env.NODE_ENV === "production") throw new Error("--dev-fake-google can't be used with NODE_ENV=production");
    if (!isLoopbackOrigin(devFakeGoogle, false)) throw new Error("--dev-fake-google takes the fake's address on this machine, like http://127.0.0.1:9999");
  }
  return {
    dataDir: resolve(values["data-dir"] ?? env.USUAL_MAIL_DATA_DIR ?? "data"),
    port: number("port", values.port ?? env.USUAL_MAIL_PORT ?? "8484", 0, 65_535),
    host,
    demo: values.demo ?? false,
    secretKey: env.USUAL_MAIL_SECRET_KEY || null,
    pollIntervalMs: number("USUAL_MAIL_POLL_SECONDS", env.USUAL_MAIL_POLL_SECONDS ?? "60", 5, 86_400) * 1000,
    syncWindowDays: env.USUAL_MAIL_SYNC_DAYS ? number("USUAL_MAIL_SYNC_DAYS", env.USUAL_MAIL_SYNC_DAYS, 1, 36_500) : null,
    devFakeAi,
    publicUrl: publicUrl(values["public-url"] ?? env.USUAL_MAIL_PUBLIC_URL),
    googleClient: googleClient(env),
    devFakeGoogle: devFakeGoogle === null ? null : new URL(devFakeGoogle).origin,
    help: values.help ?? false,
  };
}

/** An origin only: HTTPS, or HTTP on this machine (Google takes plain HTTP only for loopback addresses). */
function publicUrl(text: string | undefined): string | null {
  if (text === undefined || text === "") return null;
  const problem = "--public-url (USUAL_MAIL_PUBLIC_URL) is the address people reach the server at, an origin like https://mail.example.org: HTTPS unless it is this machine, without a path, a query or a login";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(problem);
  }
  const loopback = isLoopbackOrigin(text, true);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error(problem);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(problem);
  return url.origin;
}

function isLoopbackOrigin(text: string, allowPath: boolean): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && (allowPath || url.pathname === "/");
  } catch {
    return false;
  }
}

/** Both variables or neither; the values are never repeated in an error. */
function googleClient(env: NodeJS.ProcessEnv): GoogleClient | null {
  const clientId = env.USUAL_MAIL_GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.USUAL_MAIL_GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error("Give the Google client as USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET together, or neither");
  return { clientId, clientSecret };
}

function number(name: string, text: string, min: number, max: number): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, not "${text}"`);
  }
  return value;
}
