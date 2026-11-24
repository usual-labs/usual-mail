// Google sign-in on a Node host: the host's Google client from the environment or from
// `<data-dir>/google-client.json` (the file Google's console downloads for a web application client, renamed, readable
// by the owner only, written by `usual-mail google set` or by a person's device through `PUT /v1/google/client`), the
// server's own address for Google's redirect, and the development-only fake.
// Nothing here ever prints or logs the file's contents or the client secret.

import { googleRedirectHint, readGoogleClientFile, type GoogleClientFile, type GoogleClientFileProblem } from "@usualmail/core";
import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { CALLBACK_PATH, type GoogleClient, type GoogleFetch, type SavedGoogleClient } from "../google/config.ts";
import type { Log } from "../host.ts";
import type { Config } from "./config.ts";

export const GOOGLE_CLIENT_FILE = "google-client.json";

/**
 * Where Google sends people back: under `--public-url` when it is set, else under the loopback address the server
 * listens on (so `--host 127.0.0.1 --port 8585` gives `http://127.0.0.1:8585/v1/google/callback`). Null for a server
 * on every address without `--public-url`: it can't know its name, and never takes one from a request.
 */
export function redirectUriFor(config: Pick<Config, "publicUrl" | "host">, port: number): string | null {
  if (config.publicUrl) return `${config.publicUrl}${CALLBACK_PATH}`;
  if (config.host === "127.0.0.1" || config.host === "localhost") return `http://${config.host}:${port}${CALLBACK_PATH}`;
  if (config.host === "::1") return `http://[::1]:${port}${CALLBACK_PATH}`;
  return null;
}

/**
 * Reads the host's client when the server needs it, so a file written while it runs takes effect at once. The
 * environment wins. A file others can read, a desktop client's file or anything else is refused, said once in the
 * log in the server's own words.
 */
export function googleClientSource(options: {
  dataDir: string | null;
  env: GoogleClient | null;
  log: Log;
  redirectUri: () => string | null;
}): () => Promise<GoogleClient | null> {
  let lastSaid = "";
  const say = (line: string) => {
    if (line === lastSaid) return;
    lastSaid = line;
    if (line) options.log.info(line);
  };
  return async () => {
    if (options.env) return options.env;
    if (!options.dataDir) return null;
    const path = join(options.dataDir, GOOGLE_CLIENT_FILE);
    const read = await readClientFile(path);
    if (read.state === "none") {
      say("");
      return null;
    }
    if (read.state === "refused") {
      say(`Google sign-in is off: ${read.log}`);
      return null;
    }
    const redirect = options.redirectUri();
    if (redirect && read.client.redirectUris && !read.client.redirectUris.includes(redirect)) {
      // A hint, not a failure foretold: the file is frozen when it is downloaded, and Google's own list is what counts.
      say(`Google sign-in: ${googleRedirectHint(path, redirect)}`);
    } else {
      say("");
    }
    return { clientId: read.client.clientId, clientSecret: read.client.clientSecret };
  };
}

/**
 * What the data directory's client file holds, used or not (`GoogleOptions.savedClient`): a refused file still names a
 * client some inboxes may be connected with, so a device's client replaces it only when the device confirms.
 */
export function savedGoogleClient(dataDir: string): () => Promise<SavedGoogleClient> {
  return async () => {
    const read = await readClientFile(join(dataDir, GOOGLE_CLIENT_FILE));
    if (read.state === "usable") return { state: "usable", clientId: read.client.clientId };
    if (read.state === "refused") return { state: "refused", reason: read.reason };
    return { state: "none" };
  };
}

type FileRead =
  | { state: "none" }
  | { state: "usable"; client: GoogleClientFile }
  /** `log`: after "Google sign-in is off: " in the log, with the path. `reason`: a person's words, without the path. */
  | { state: "refused"; log: string; reason: string };

/** One read of the client file, for the client, the log and what is saved. Never puts any of the file in its words. */
async function readClientFile(path: string): Promise<FileRead> {
  let text: string;
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) {
      return {
        state: "refused",
        log: `other users can read ${path}. Run chmod 600 on it; the server reads it again at once.`,
        reason: "other users can read it (its host runs chmod 600 on google-client.json in the server's data directory to use it as it is)",
      };
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "none" };
    return {
      state: "refused",
      log: `${path} can't be read.`,
      reason: "the server can't read it (its host checks google-client.json in the server's data directory)",
    };
  }
  const read = readGoogleClientFile(text);
  if ("problem" in read) return { state: "refused", log: `${path} ${FILE_PROBLEMS[read.problem]}`, reason: FILE_REASONS[read.problem] };
  return { state: "usable", client: read.client };
}

/** Why the data directory's file is refused, after its path in the log. Core reads the file (`readGoogleClientFile`). */
const FILE_PROBLEMS: Record<GoogleClientFileProblem, string> = {
  not_json: "isn't a Google OAuth client file: save the JSON Google Cloud's console downloads for the client, as it is.",
  desktop_client: "holds a Desktop app client. Create a Web application client at Google and save its JSON here instead.",
  no_web_client:
    "isn't a Google OAuth client file: save the JSON Google Cloud's console downloads for the client, as it is (it needs web.client_id and web.client_secret).",
};

/** The same, as a person's device is told (`SavedGoogleClient.reason`). */
const FILE_REASONS: Record<GoogleClientFileProblem, string> = {
  not_json: "it isn't a Google OAuth client file",
  desktop_client: "it holds a Desktop app client, not a Web application client",
  no_web_client: "it isn't a Google OAuth client file (it has no web.client_id and web.client_secret)",
};

/**
 * Keeps the client a person's device gave (`PUT /v1/google/client`) as `usual-mail google set` does: the file's text
 * as it is, in `<data-dir>/google-client.json`, owner-only. Written whole to a new temporary file beside it (created
 * exclusively, under a random name, mode 0600 from creation, so a file or link already at that name is never used),
 * then renamed into place, so `googleClientSource` never reads half of it; the temporary file is removed if anything
 * fails. An error names the path, never the text. `suffix` is for tests.
 */
export async function saveGoogleClientFile(dataDir: string, text: string, suffix = randomBytes(12).toString("hex")): Promise<void> {
  const path = join(dataDir, GOOGLE_CLIENT_FILE);
  const temporary = `${path}.${suffix}.tmp`;
  let file: FileHandle | undefined;
  let created = false;
  try {
    file = await open(temporary, "wx", 0o600);
    created = true;
    await file.writeFile(text);
    await file.chmod(0o600);
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } catch (error) {
    await file?.close().catch(() => {});
    if (created) await rm(temporary, { force: true }).catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`Couldn't write ${path}${code ? ` (${code})` : ""}`);
  }
}

/**
 * Development only (`--dev-fake-google`): Google's token, revocation and Gmail addresses go to the fake at `origin`,
 * under the same paths. Any other address is refused, so nothing can reach Google or anywhere else by mistake.
 */
export function fakeGoogleFetch(origin: string, base: GoogleFetch = (input, init) => fetch(input, init)): GoogleFetch {
  return (input, init) => {
    const url = new URL(input);
    if (url.origin !== "https://oauth2.googleapis.com" && url.origin !== "https://gmail.googleapis.com") {
      return Promise.reject(new Error(`The fake Google takes only Google's token and Gmail addresses, not ${url.origin}`));
    }
    return base(`${origin}${url.pathname}${url.search}`, init);
  };
}

/** Where the fake's authorization page is. */
export function fakeAuthorizationUrl(origin: string): string {
  return `${origin}/o/oauth2/v2/auth`;
}
