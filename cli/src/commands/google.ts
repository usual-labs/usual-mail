// Google sign-in for Gmail, from the host's side: what the server says about it (`google`), giving the server its
// Google OAuth client (`google set`), and the browser agent's prompt with the server's redirect address filled in
// (`google prompt`). `google set` writes `<data-dir>/google-client.json`, readable only by its owner, in the shape
// Google's console downloads it; the server reads it from there (a person's app may also write it through
// `PUT /v1/google/client`). The file is checked as the server checks it (core's `readGoogleClientFile`). The secret is
// read unseen, from that file or from standard input, and never printed, logged or kept anywhere else.

import {
  GOOGLE_RULES_WORDS,
  googleRedirectHint,
  readGoogleClientFile,
  type GoogleClientFileProblem,
  type GoogleSetup,
  type GoogleSignInInfo,
  type ServerInfo,
} from "@usualmail/core";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fchmodSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { clientFor } from "../client.ts";
import { flag, text, type Command } from "../command.ts";
import { absolute, readConfig, shown } from "../config.ts";
import { note, printJson, say, type Context } from "../context.ts";
import { ApiError, explain, Failure, UsageError } from "../errors.ts";
import { askSecret, askText } from "../prompt.ts";
import { needFlags } from "./credentials.ts";

export const GOOGLE_CLIENT_FILE = "google-client.json";
const GUIDE = "docs/google-setup.md in Usual Mail";
const CALLBACK = "/v1/google/callback";

export const googleStatus: Command = {
  name: "google",
  summary: "say whether Gmail can be connected by signing in with Google, and how to set it up",
  usage: "usual-mail google [--json]",
  details: `
--json   print what the server says (GET /v1/info's googleSignIn)

Signing in with Google needs the server's host to give it a Google OAuth client of type Web application, whose
authorized redirect URI is exactly the address this prints. \`usual-mail google set\` gives it the client.`,
  options: { json: { type: "boolean" } },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const info = await clientFor(ctx).call<ServerInfo>("info");
    const google = googleOf(info);
    if (flag(values, "json")) return printJson(ctx, google);
    const dataDir = readConfig(ctx).run?.dataDir;
    for (const line of describe(google, dataDir ? clientFileHint(ctx, join(dataDir, GOOGLE_CLIENT_FILE), google) : null)) say(ctx, line);
  },
};

export const googleSet: Command = {
  name: "google set",
  summary: "give the server its Google OAuth client, for signing in with Google",
  usage: "usual-mail google set [--file CLIENT.json | --client-id ID --secret-stdin] [--data-dir PATH]",
  details: `
--file PATH        the JSON file Google Cloud's console downloads for the client (client_secret_….json)
--client-id ID     the client's id, when you have no file; the secret is then asked unseen, or:
--secret-stdin     read the client secret from standard input (the first line)
--data-dir PATH    the server's data directory (default: where \`usual-mail init\` set the server up)
--json             print what the server says afterwards

The client must be of type Web application, with the authorized redirect URI that \`usual-mail google\` prints
(for a server on this Mac, http://127.0.0.1:<port>${CALLBACK}). This writes <data-dir>/${GOOGLE_CLIENT_FILE},
readable only by you, as Google downloads it; the server reads it at once, without a restart. The secret is
never printed. ${GUIDE} says each step at Google.`,
  options: {
    file: { type: "string" },
    "client-id": { type: "string" },
    "secret-stdin": { type: "boolean" },
    "data-dir": { type: "string" },
    json: { type: "boolean" },
  },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const dataDir = dataDirFor(ctx, text(values, "data-dir"));
    const given = text(values, "file");
    if (given && (text(values, "client-id") || flag(values, "secret-stdin"))) throw new UsageError("Pass --file, or --client-id with the secret; not both.");
    if (!given) needFlags(ctx, [...(text(values, "client-id") ? [] : ["file or --client-id"]), ...(flag(values, "secret-stdin") ? [] : ["secret-stdin"])], "google set");
    const content = given ? downloadedFile(absolute(ctx, given)) : await typedClient(ctx, text(values, "client-id"), flag(values, "secret-stdin"));
    const path = join(dataDir, GOOGLE_CLIENT_FILE);
    writeOwnerOnly(path, content.text);
    const info = await clientFor(ctx).call<ServerInfo>("info").catch(() => null);
    if (flag(values, "json")) return printJson(ctx, { file: path, googleSignIn: info ? googleOf(info) : null });
    say(ctx, `Saved the Google client ${content.clientId} to ${shown(ctx, path)}, readable only by you.`);
    if (!info) return say(ctx, "The server didn't answer; it reads the file when it next needs it.");
    const google = googleOf(info);
    const unlisted = google.redirectUri && content.redirectUris && !content.redirectUris.includes(google.redirectUri);
    for (const line of describe(google, unlisted ? googleRedirectHint(shown(ctx, path), google.redirectUri!) : null)) say(ctx, line);
  },
};

export const googlePrompt: Command = {
  name: "google prompt",
  summary: "print a prompt for your own browser agent that sets up the server's Google client",
  usage: "usual-mail google prompt [--json]",
  details: `
--json   print what the server says (GET /v1/google/setup): the prompt, the steps by hand, what is missing

Prints the prompt of docs/google-setup-agent.md with this server's redirect address filled in. Sign in to
console.cloud.google.com in your own browser, fill in the two lines that still say FILL IN, and give the whole
prompt to your own AI agent that controls that browser. The prompt goes to standard output (so
\`usual-mail google prompt | pbcopy\` copies it), what to do with it to standard error. Afterwards,
\`usual-mail google set --file <the downloaded file>\` gives the client to the server.`,
  options: { json: { type: "boolean" } },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const setup = await setupOf(ctx);
    if (flag(values, "json")) return printJson(ctx, setup);
    if (!setup.prompt) throw new Failure(setup.noAddress ?? "The server gave no prompt.", "failed");
    if (setup.promptNote) note(ctx, `${setup.promptNote}\n`);
    say(ctx, setup.prompt);
  },
};

/** The guided set-up the server serves, or words for a server older than the route. */
async function setupOf(ctx: Context): Promise<GoogleSetup> {
  try {
    return await clientFor(ctx).raw<GoogleSetup>("googleSetup");
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "not_found") {
      throw new Failure("This server is older than this command and doesn't serve the prompt. Update the server, then try again.", "not_found");
    }
    throw explain(error);
  }
}

/** What the server says, for a server too old to say it: not available. */
function googleOf(info: ServerInfo): GoogleSignInInfo {
  return info.googleSignIn ?? { available: false, missing: ["client"] };
}

/**
 * The hint for the client file in the data directory, when it lists redirect addresses and not the server's. Null when
 * there is no such file, it can't be read, or it lists the address.
 */
export function clientFileHint(ctx: Context, path: string, google: GoogleSignInInfo): string | null {
  if (!google.redirectUri || !existsSync(path)) return null;
  try {
    const uris = (JSON.parse(readFileSync(path, "utf8")) as { web?: { redirect_uris?: unknown } } | null)?.web?.redirect_uris;
    if (!Array.isArray(uris) || uris.includes(google.redirectUri)) return null;
    return googleRedirectHint(shown(ctx, path), google.redirectUri);
  } catch {
    return null;
  }
}

/** What Google sign-in is on the server, what the host must still do, and Google's rules. */
function describe(google: GoogleSignInInfo, hint: string | null = null): string[] {
  const lines: string[] = [];
  const redirect = google.redirectUri ?? `<the server's address>${CALLBACK}`;
  if (google.available) {
    lines.push("Google sign-in is available: `usual-mail inbox add` and `inbox reconnect` offer it for Gmail.");
    lines.push(`Google sends people back to ${redirect}. That must be exactly the client's authorized redirect URI at Google.`);
    if (hint) lines.push(hint);
  } else {
    lines.push("Google sign-in is off on this server.");
    if (google.missing?.includes("client")) {
      lines.push(
        "It has no Google OAuth client. At Google Cloud: a project with the Gmail API on; its consent screen (External;",
        "Testing is fine for yourself, with you as a test user; the one scope https://www.googleapis.com/auth/gmail.modify);",
        `an OAuth client of type Web application whose authorized redirect URI is exactly ${redirect}.`,
        "Download its JSON, then run `usual-mail google set --file <the downloaded file>`.",
      );
    }
    if (google.missing?.includes("address")) {
      lines.push(
        "It doesn't know its own address. Set USUAL_MAIL_PUBLIC_URL (or --public-url) to the HTTPS address people reach it",
        `at, restart it, and register that address followed by ${CALLBACK} at Google.`,
      );
    }
    if (hint) lines.push(hint);
    lines.push(`${GUIDE} says each step.`);
  }
  lines.push("", "Google's rules:", ...GOOGLE_RULES_WORDS.map((words) => `- ${words}`));
  return lines;
}

/** Where the server keeps its data: the flag, or where `init` set it up on this machine. */
function dataDirFor(ctx: Context, given: string | undefined): string {
  const dir = given ? absolute(ctx, given) : readConfig(ctx).run?.dataDir;
  if (!dir) {
    throw new UsageError(
      "This command doesn't know where the server keeps its data. Pass --data-dir (the folder that holds usual-mail.db), " +
        "or give the server USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET where it runs.",
    );
  }
  if (!existsSync(dir)) throw new Failure(`${shown(ctx, dir)} doesn't exist. Pass the server's data directory with --data-dir.`);
  return dir;
}

interface ClientFile {
  text: string;
  clientId: string;
  redirectUris: string[] | null;
}

/** Why a file isn't a client the server takes, in the command's words. Core reads the file, as the server does. */
const FILE_PROBLEMS: Record<GoogleClientFileProblem, string> = {
  not_json: "That file isn't a Google OAuth client file: download the client's JSON from Google Cloud's console and pass it as it is.",
  desktop_client: "That file holds a Desktop app client. Create an OAuth client of type Web application at Google and pass its JSON instead.",
  no_web_client: "That file isn't a Google OAuth client file: it needs web.client_id and web.client_secret, as Google downloads them.",
};

/** The file as Google downloaded it, checked, never repeated in a message. */
function downloadedFile(path: string): ClientFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Failure(`Can't read ${path}.`);
  }
  const read = readGoogleClientFile(raw);
  if ("problem" in read) throw new Failure(FILE_PROBLEMS[read.problem]);
  return { text: raw, clientId: read.client.clientId, redirectUris: read.client.redirectUris };
}

/** The id from a flag or a question, the secret unseen or from standard input; written in the downloaded shape. */
async function typedClient(ctx: Context, givenId: string | undefined, fromStdin: boolean): Promise<ClientFile> {
  const prompter = ctx.interactive ? ctx.prompter() : null;
  try {
    const clientId = (givenId ?? (await askText(prompter!, "Client ID (ends in .apps.googleusercontent.com)"))).trim();
    const secret = fromStdin ? ((await ctx.readStdin()).split(/\r?\n/)[0] ?? "").trim() : (await askSecret(prompter!, "Client secret")).trim();
    if (!clientId || !secret) throw new Failure("The Google client needs its id and its secret.");
    return { text: `${JSON.stringify({ web: { client_id: clientId, client_secret: secret } })}\n`, clientId, redirectUris: null };
  } finally {
    prompter?.close();
  }
}

/**
 * Written whole to a new temporary file beside it, then renamed into place. The temporary file is created exclusively
 * under a random name with mode 0600 from creation, so a file or link already at that name is never used, and it is
 * removed if anything fails. `suffix` is for tests.
 */
export function writeOwnerOnly(path: string, content: string, suffix = randomBytes(12).toString("hex")): void {
  const temporary = `${path}.${suffix}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeSync(fd, content);
    fchmodSync(fd, 0o600);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) rmSync(temporary, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    throw new Failure(`Couldn't write ${path}${code ? ` (${code})` : ""}. Nothing was changed.`);
  }
}
