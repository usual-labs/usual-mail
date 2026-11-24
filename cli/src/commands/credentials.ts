// A mailbox's connection details, asked for or read from flags, for connecting an inbox (`inbox add`) and for
// giving a connected one new credentials (`inbox reconnect`): both take the same shape (docs/contract.md,
// "Inboxes"). For a connected inbox the details the server stored (`Inbox.connection`) are the starting point, so
// only the secrets are asked again. Secrets are read unseen in a terminal, or from standard input with
// --secrets-stdin, never from flags.

import type { GmailCredentials, ImapCredentials, InboxConnection, ServerLogin } from "@usualmail/core";
import { flag, noQuestions, portFrom, text, type Values } from "../command.ts";
import type { Context } from "../context.ts";
import { Failure } from "../errors.ts";
import { askNumber, askSecret, askText, confirm, type Prompter } from "../prompt.ts";

/** The flags both commands take for the connection itself. */
export const CONNECTION_OPTIONS = {
  user: { type: "string" },
  "imap-host": { type: "string" },
  "imap-port": { type: "string" },
  "imap-starttls": { type: "boolean" },
  "smtp-host": { type: "string" },
  "smtp-port": { type: "string" },
  "smtp-starttls": { type: "boolean" },
  "no-save-sent": { type: "boolean" },
  "save-sent": { type: "boolean" },
  "client-id": { type: "string" },
  "secrets-stdin": { type: "boolean" },
} as const;

export const CONNECTION_HELP = `IMAP and SMTP:
--user LOGIN            the login, when it isn't the address
--imap-host HOST        --imap-port N (default 993, TLS)   --imap-starttls (STARTTLS instead; default port 143)
--smtp-host HOST        --smtp-port N (default 465, TLS)   --smtp-starttls (STARTTLS instead; default port 587)
--no-save-sent          don't save a copy of sent mail to the Sent folder (for servers that do it themselves)
--save-sent             save one again (the default for a new inbox)

Gmail by hand (your own Google OAuth client, with the scope https://www.googleapis.com/auth/gmail.modify),
instead of signing in with Google:
--client-id ID          the OAuth client's id

Secrets without a terminal:
--secrets-stdin         read them from standard input, one per line. IMAP: the password, then optionally a
                        different SMTP password. Gmail: the client secret, then the refresh token.`;

/**
 * The connection flags a command needs without a terminal, for a provider. With the details a connected inbox has
 * stored, only what they lack (and the secrets).
 */
export function missingConnectionFlags(values: Values, provider: string | undefined, stored?: InboxConnection): string[] {
  const missing: string[] = [];
  const storedImap = stored?.kind === "imap" ? stored : undefined;
  if (provider === "imap") {
    if (!text(values, "imap-host") && !storedImap?.imap.host) missing.push("imap-host");
    if (!text(values, "smtp-host") && !storedImap?.smtp.host) missing.push("smtp-host");
  }
  if (provider === "gmail" && !text(values, "client-id") && !(stored?.kind === "gmail" && stored.clientId)) missing.push("client-id");
  if (!flag(values, "secrets-stdin")) missing.push("secrets-stdin");
  return missing;
}

/** Whether a copy of sent mail is saved: from the flags, else as stored, else left to the server (yes). */
function saveSentFrom(values: Values, stored: boolean | undefined): boolean | undefined {
  if (flag(values, "no-save-sent") && flag(values, "save-sent")) throw new Failure("Pass --save-sent or --no-save-sent, not both.", "usage");
  if (flag(values, "no-save-sent")) return false;
  if (flag(values, "save-sent")) return true;
  return stored;
}

/** One server's details in words, as `inbox list` and `inbox reconnect` show them. */
export function loginWords(login: ServerLogin): string {
  return login.host ? `${login.host}:${login.port} (${login.secure ? "TLS" : "STARTTLS"}) as ${login.user}` : "not known";
}

/** How a connected inbox is connected, in full. Never a secret: the server has none to show. */
export function connectionWords(connection: InboxConnection): string {
  if (connection.kind === "gmail") {
    return connection.signIn === "google" ? `signed in with Google (client ${connection.clientId})` : `Google client ${connection.clientId || "not known"}`;
  }
  return `IMAP ${loginWords(connection.imap)}, SMTP ${loginWords(connection.smtp)}${connection.saveSent ? "" : ", sent mail not saved"}`;
}

/** The same in a table's few words: the IMAP server and login, or the Google client. */
export function connectionShort(connection: InboxConnection): string {
  if (connection.kind === "gmail") return connection.signIn === "google" ? "Google sign-in" : `client ${connection.clientId || "not known"}`;
  return connection.imap.host ? `${connection.imap.host}:${connection.imap.port} as ${connection.imap.user}` : "not known";
}

/** Fails with every flag that is missing, when nothing can be asked. */
export function needFlags(ctx: Context, missing: string[], command: string): void {
  if (ctx.interactive || !missing.length) return;
  throw new Failure(
    `${noQuestions(ctx)} Pass ${missing.map((key) => `--${key}`).join(", ")}. \`usual-mail ${command} --help\` shows an example.`,
    "not_a_terminal",
  );
}

/**
 * IMAP and SMTP details for the mailbox at `address`. Secrets are asked unseen or read from standard input. With
 * `stored` (a connected inbox's `connection`), its details are kept unless a flag changes them, and in a terminal
 * the person is asked once whether to keep them; only the secrets are asked otherwise.
 */
export async function imapDetails(
  ctx: Context,
  p: Prompter | null,
  values: Values,
  address: string,
  stored?: Extract<InboxConnection, { kind: "imap" }>,
): Promise<{ credentials: ImapCredentials; secrets: string[] }> {
  const domain = address.includes("@") ? address.split("@").pop()! : "";
  let keep = Boolean(stored?.imap.host && stored.smtp.host);
  if (keep && p) {
    ctx.stdout.write(`Stored details: IMAP ${loginWords(stored!.imap)}; SMTP ${loginWords(stored!.smtp)}; ${stored!.saveSent ? "a copy of sent mail is saved" : "sent mail isn't saved"}.\n`);
    keep = await confirm(p, "Keep these details and give only the password?", true);
  }
  const kept = keep ? stored : undefined;
  const user = text(values, "user") ?? kept?.imap.user ?? (p ? await askText(p, "Login", stored?.imap.user || address) : address);
  const imap = await server(p, values, "imap", "IMAP server", kept?.imap, stored?.imap, domain && `imap.${domain}`, [993, 143]);
  const smtp = await server(p, values, "smtp", "SMTP server (for sending)", kept?.smtp, stored?.smtp, domain && `smtp.${domain}`, [465, 587]);
  // A login given as a flag is the login for both; otherwise each server keeps the one it had.
  const smtpUser = text(values, "user") ?? kept?.smtp.user ?? user;
  const [password, smtpPassword] = await secrets(ctx, p, values, async (prompter) => {
    const first = await askSecret(prompter, "Password");
    const same = await confirm(prompter, "Use the same password for sending (SMTP)?", true);
    return [first, same ? first : await askSecret(prompter, "SMTP password")];
  });
  const saveSent = saveSentFrom(values, stored?.saveSent);
  const credentials: ImapCredentials = {
    imap: { ...imap, user, password: password! },
    smtp: { ...smtp, user: smtpUser, password: smtpPassword || password! },
    ...(address !== user ? { address } : {}),
    ...(saveSent !== undefined ? { saveSent } : {}),
  };
  return { credentials, secrets: [password!, smtpPassword].filter((secret): secret is string => Boolean(secret)) };
}

/**
 * One server's host, port and TLS: flags first, then what is kept, then questions (suggesting what was stored, or
 * a guess from the address) or defaults. `ports` are the TLS port and the STARTTLS port.
 */
async function server(
  p: Prompter | null,
  values: Values,
  name: "imap" | "smtp",
  question: string,
  kept: ServerLogin | undefined,
  stored: ServerLogin | undefined,
  guess: string,
  [tlsPort, starttlsPort]: [number, number],
): Promise<{ host: string; port: number; secure: boolean }> {
  const label = name.toUpperCase();
  const host = text(values, `${name}-host`) ?? kept?.host ?? (await askText(p!, question, stored?.host || guess));
  const starttls = flag(values, `${name}-starttls`);
  if (kept && text(values, `${name}-port`) === undefined && !starttls) return { host, port: kept.port, secure: kept.secure };
  const portNumber = await port(p, values, `${name}-port`, `${label} port`, starttls ? starttlsPort : (kept ?? stored)?.port || tlsPort);
  // Port 587 or 25 for SMTP, and 143 for IMAP, mean STARTTLS too.
  const plainPorts = name === "imap" ? [143] : [587, 25];
  return { host, port: portNumber, secure: !starttls && !plainPorts.includes(portNumber) };
}

export async function gmailDetails(
  ctx: Context,
  p: Prompter | null,
  values: Values,
  stored?: Extract<InboxConnection, { kind: "gmail" }>,
): Promise<{ credentials: GmailCredentials; secrets: string[] }> {
  const clientId = text(values, "client-id") ?? (stored?.clientId || (await askText(p!, "Google OAuth client id")));
  const [clientSecret, refreshToken] = await secrets(ctx, p, values, async (prompter) => [
    await askSecret(prompter, "Client secret"),
    await askSecret(prompter, "Refresh token"),
  ]);
  if (!clientSecret || !refreshToken) {
    throw new Failure("Gmail needs the client secret and the refresh token, one per line on standard input.", "usage");
  }
  return { credentials: { clientId, clientSecret, refreshToken }, secrets: [clientSecret, refreshToken] };
}

/**
 * A failure from the server with every secret the person typed taken out, so a provider that repeats what it was
 * sent can't make the command print a password.
 */
export function withoutSecrets(error: unknown, secrets: string[]): unknown {
  if (!(error instanceof Failure)) return error;
  const kept = secrets.filter((secret) => secret.length >= 4);
  const message = kept.reduce((out, secret) => out.split(secret).join("•••"), error.message);
  if (message === error.message) return error;
  return new Failure(message, error.code, error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter });
}

async function port(p: Prompter | null, values: Values, key: string, question: string, fallback: number): Promise<number> {
  const given = text(values, key);
  if (given !== undefined || !p) return portFrom(given, fallback);
  return askNumber(p, question, fallback, 1, 65_535);
}

/** Secrets from standard input with --secrets-stdin (when nothing can be asked), otherwise asked unseen. */
async function secrets(
  ctx: Context,
  p: Prompter | null,
  values: Values,
  ask: (prompter: Prompter) => Promise<string[]>,
): Promise<string[]> {
  if (flag(values, "secrets-stdin") && !p) {
    const lines = (await ctx.readStdin()).split(/\r?\n/).filter((line) => line.length > 0);
    if (!lines.length) throw new Failure("--secrets-stdin found nothing on standard input.", "usage");
    return lines;
  }
  return ask(p!);
}
