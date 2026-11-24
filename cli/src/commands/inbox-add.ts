// Connecting a mailbox. Passwords and secrets are read without showing them (or from standard input with
// --secrets-stdin), sent to the server once in the request that connects the inbox, and never stored or printed.

import type { AiSettings, Inbox, InboxIcon, ServerInfo, TrustLevel } from "@usualmail/core";
import { INBOX_ICONS, TRUST_LEVELS } from "@usualmail/core";
import { serviceName } from "../ai-words.ts";
import { clientFor, type Client } from "../client.ts";
import { flag, text, type Command, type Values } from "../command.ts";
import { printJson, say, type Context } from "../context.ts";
import { Failure, UsageError } from "../errors.ts";
import { signInWithGoogle } from "../google.ts";
import { PROVIDER_WORDS, statusLine } from "../format.ts";
import { HATS, hatNamed, isHex, nearestHat, swatch } from "../hats.ts";
import { askText, choose, type Prompter } from "../prompt.ts";
import {
  CONNECTION_HELP,
  CONNECTION_OPTIONS,
  gmailDetails,
  imapDetails,
  missingConnectionFlags,
  needFlags,
  withoutSecrets,
} from "./credentials.ts";

type Provider = "imap" | "gmail";
/** Gmail by signing in with Google, through the server's own Google client. */
type Choice = Provider | "google";

export const inboxAdd: Command = {
  name: "inbox add",
  summary: "connect a mailbox",
  usage: "usual-mail inbox add [--provider imap|gmail] [--name NAME] [--color COLOUR] [flags]",
  details: `
In a terminal it asks for everything it needs. Passwords and secrets are not shown while you type them. They
are sent to the server once, which stores them sealed, and this command never stores or prints them.

Gmail: when the server has Google sign-in (\`usual-mail google\`), it opens Google's sign-in in your browser and
waits for you to come back; the server receives the answer and keeps the token. Without --client-id or
--secrets-stdin that is the way for Gmail. Otherwise give your own client id, secret and refresh token.

--provider imap|gmail   how to reach the mailbox
--name NAME             what to call the inbox, for example the company's name
--color COLOUR          one of: ${HATS.map((hat) => hat.name).join(", ")}; or any #RRGGBB
--trust LEVEL           how much rules and agents may do alone in this inbox:
                        suggest (the default): they only propose, and you approve in Handled
                        act_with_undo: they act, and every change shows in Handled with undo
                        act_silently: they act quietly; Handled shows their changes only when asked,
                        still with undo, and always shows anything that went wrong
--icon ICON             its icon in the apps' profile switch: ${INBOX_ICONS.join(", ")}
                        (by default the next of person, building and briefcase)
--address ADDRESS       IMAP: the mailbox's address
--no-browser            Gmail with Google sign-in: print Google's address instead of opening a browser
--json                  print the new inbox as the server gives it

${CONNECTION_HELP}

Example without a terminal:
  printf '%s\\n' "$PASSWORD" | usual-mail inbox add --provider imap --name Acme --color blue \\
    --address ana@acme.example --imap-host imap.acme.example --smtp-host smtp.acme.example --secrets-stdin`,
  options: {
    provider: { type: "string" },
    name: { type: "string" },
    color: { type: "string" },
    trust: { type: "string" },
    icon: { type: "string" },
    address: { type: "string" },
    "no-browser": { type: "boolean" },
    ...CONNECTION_OPTIONS,
    json: { type: "boolean" },
  },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const client = clientFor(ctx);
    const existing = await client.call<Inbox[]>("listInboxes");
    const trust = trustFrom(text(values, "trust"));
    const icon = iconFrom(text(values, "icon"));
    // Gmail goes through the server's Google sign-in when it has one, unless the person brings their own credentials.
    const info = await client.call<ServerInfo>("info");
    const manual = Boolean(text(values, "client-id")) || flag(values, "secrets-stdin");
    const google = info.googleSignIn?.available === true && !manual;
    checkFlags(ctx, values, google);
    // Read for what the new inbox's mail does: with a key, it goes to the AI like every inbox's.
    const ai = await client.call<AiSettings>("aiSettings");
    const prompter = ctx.interactive ? ctx.prompter() : null;
    try {
      const picked = await pickProvider(ctx, prompter, text(values, "provider"), google);
      const provider: Provider = picked === "google" ? "gmail" : picked;
      const name = text(values, "name") ?? (await askText(prompter!, "Name (for example the company's name)"));
      const color = await pickColor(ctx, prompter, text(values, "color"), existing);
      // Chosen from the list, "Gmail" is the person's own credentials; given as --provider gmail, Google sign-in.
      if (picked === "google" || (text(values, "provider") === "gmail" && google)) {
        return await addWithGoogle(ctx, client, values, { name, color, icon, trust }, ai);
      }
      const address = provider === "imap" ? (text(values, "address") ?? (await askText(prompter!, "The mailbox's address"))) : "";
      const { credentials, secrets } =
        provider === "imap" ? await imapDetails(ctx, prompter, values, address) : await gmailDetails(ctx, prompter, values);
      const inbox = await client
        .call<Inbox>("connectInbox", {
          body: { name, color, provider, credentials, ...(trust ? { trust } : {}), ...(icon ? { icon } : {}) },
          timeoutMs: 120_000,
        })
        .catch((error: unknown) => {
          throw withoutSecrets(error, secrets);
        });
      if (flag(values, "json")) return printJson(ctx, inbox);
      say(ctx, `Connected ${swatch(inbox.color, ctx.color)}${inbox.name} (${inbox.address}), ${PROVIDER_WORDS[inbox.provider] ?? inbox.provider}, hat ${nearestHat(inbox.color).name}.`);
      say(ctx, `Status: ${statusLine(inbox)}. Trust: ${inbox.trust}.`);
      if (inbox.trust === "suggest") say(ctx, "Rules and agents only propose in this inbox until you choose otherwise.");
      say(ctx, aiWords(ai));
      say(ctx, "`usual-mail inbox list` shows how the first sync goes.");
    } finally {
      prompter?.close();
    }
  },
};

/**
 * Connects Gmail by signing in with Google: the server starts it, the person signs in in their browser, the server
 * connects the inbox (or reconnects the one that has that address). The trust and AI asked for are set afterwards.
 */
async function addWithGoogle(
  ctx: Context,
  client: Client,
  values: Values,
  asked: { name: string; color: string; icon: InboxIcon | undefined; trust: TrustLevel | undefined },
  settings: AiSettings,
): Promise<void> {
  const outcome = await signInWithGoogle(ctx, client, { name: asked.name, color: asked.color, ...(asked.icon ? { icon: asked.icon } : {}) }, { browser: !flag(values, "no-browser") });
  if (outcome.state !== "connected" || !outcome.inboxId) throw new Failure(outcome.message ?? "The sign-in didn't finish. Start again.");
  let inbox = (await client.call<Inbox[]>("listInboxes")).find((each) => each.id === outcome.inboxId);
  if (!inbox) throw new Failure("The server connected the inbox, but it is gone again. `usual-mail inbox list` shows what is there.");
  if (outcome.reconnected) {
    if (flag(values, "json")) return printJson(ctx, inbox);
    say(ctx, `${inbox.address} was connected already, as ${inbox.name}: it is reconnected in place, with its rules, history and settings.`);
    say(ctx, `Status: ${statusLine(inbox)}.`);
    return;
  }
  if (asked.trust) inbox = await client.call<Inbox>("updateInbox", { params: { id: inbox.id }, body: { trust: asked.trust } });
  if (flag(values, "json")) return printJson(ctx, inbox);
  say(ctx, `Connected ${swatch(inbox.color, ctx.color)}${inbox.name} (${inbox.address}), Gmail by signing in with Google, hat ${nearestHat(inbox.color).name}.`);
  say(ctx, `Status: ${statusLine(inbox)}. Trust: ${inbox.trust}.`);
  if (inbox.trust === "suggest") say(ctx, "Rules and agents only propose in this inbox until you choose otherwise.");
  say(ctx, aiWords(settings));
  say(ctx, "While the Google client's consent screen is in Testing, sign in again each week: `usual-mail inbox reconnect`.");
}

/** Without a terminal, or with --json, every answer must come from a flag. Says all that are missing at once. */
function checkFlags(ctx: Context, values: Values, google: boolean): void {
  if (ctx.interactive) return;
  const provider = text(values, "provider");
  const missing = ["provider", "name", "color"].filter((key) => !text(values, key));
  if (provider === "imap" && !text(values, "address")) missing.push("address");
  if (!(provider === "gmail" && google)) missing.push(...missingConnectionFlags(values, provider));
  needFlags(ctx, missing, "inbox add");
}

/** What happens to the new inbox's mail: with a key, the AI processes it like every inbox's. */
function aiWords(settings: AiSettings): string {
  return settings.credentialsSet
    ? `Its mail goes to the AI with ${serviceName(settings.connection)}, as every inbox's does.`
    : "No AI key is set, so its mail isn't categorized or summarized; `usual-mail ai set` sets one.";
}

function iconFrom(value: string | undefined): (typeof INBOX_ICONS)[number] | undefined {
  if (value === undefined) return undefined;
  if ((INBOX_ICONS as readonly string[]).includes(value)) return value as (typeof INBOX_ICONS)[number];
  throw new UsageError(`--icon takes ${INBOX_ICONS.join(", ")}, not "${value}".`);
}

function trustFrom(value: string | undefined): TrustLevel | undefined {
  if (value === undefined) return undefined;
  if ((TRUST_LEVELS as readonly string[]).includes(value)) return value as TrustLevel;
  throw new UsageError(`--trust takes ${TRUST_LEVELS.join(", ")}, not "${value}".`);
}

async function pickProvider(ctx: Context, p: Prompter | null, given: string | undefined, google: boolean): Promise<Choice> {
  if (given === "imap" || given === "gmail") return given;
  if (given !== undefined) throw new UsageError(`--provider takes imap or gmail, not "${given}".`);
  return choose<Choice>(p!, (line) => ctx.stdout.write(line), "Which provider?", [
    ...(google ? [{ label: "Gmail: sign in with Google in your browser", value: "google" as const }] : []),
    { label: "IMAP and SMTP (most mail services)", value: "imap" },
    { label: google ? "Gmail with your own client id, secret and refresh token" : "Gmail (with your own Google OAuth client)", value: "gmail" },
  ]);
}

async function pickColor(ctx: Context, p: Prompter | null, given: string | undefined, existing: Inbox[]): Promise<string> {
  if (given !== undefined) {
    const hat = hatNamed(given);
    if (hat) return hat.fill;
    if (isHex(given)) return given.toLowerCase();
    throw new UsageError(`--color takes one of ${HATS.map((h) => h.name).join(", ")}, or #RRGGBB; not "${given}".`);
  }
  const taken = new Set(existing.map((inbox) => nearestHat(inbox.color).name));
  const fallback = Math.max(0, HATS.findIndex((hat) => !taken.has(hat.name)));
  return choose(
    p!,
    (line) => ctx.stdout.write(line),
    "Which colour? Each inbox wears one, so you can tell them apart.",
    HATS.map((hat) => ({
      label: `${swatch(hat.fill, ctx.color)}${hat.name}${taken.has(hat.name) ? " (in use)" : ""}`,
      value: hat.fill,
    })),
    fallback,
  );
}
