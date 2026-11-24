// Giving a connected inbox new credentials in place, for example after its password changed: the inbox keeps its
// rules and history. The server checks the new details with the provider before it keeps them; when the provider
// refuses them, or they are for another address, nothing changes (docs/contract.md, "Inboxes").

import type { Inbox, ServerInfo } from "@usualmail/core";
import { clientFor, type Client } from "../client.ts";
import { flag, text, type Command, type Values } from "../command.ts";
import { printJson, say, type Context } from "../context.ts";
import { Failure } from "../errors.ts";
import { PROVIDER_WORDS, statusLine } from "../format.ts";
import { signInWithGoogle } from "../google.ts";
import { findInbox } from "../lookup.ts";
import { CONNECTION_HELP, CONNECTION_OPTIONS, connectionWords, gmailDetails, imapDetails, missingConnectionFlags, needFlags, withoutSecrets } from "./credentials.ts";
import { required } from "./inbox.ts";
import { confirm } from "../prompt.ts";

export const inboxReconnect: Command = {
  name: "inbox reconnect",
  summary: "give an inbox a new password or other connection details",
  usage: "usual-mail inbox reconnect <inbox> [flags]",
  details: `
<inbox>  the inbox's id, name or address, as \`usual-mail inbox list\` shows them

For when the password changed or the provider stopped accepting it. The inbox keeps its rules, history and
guide. The server checks the new details with the provider first: if the provider refuses them, or they are for
another address than the inbox's, nothing changes and the provider's words are shown. Afterwards the inbox is
connecting until its next good sync; a paused inbox stays paused.

Gmail: when the server has Google sign-in (\`usual-mail google\`), it signs the inbox in again with Google in your
browser, in place (in a terminal it asks first). Another Google account than the inbox's is refused. With
--client-id or --secrets-stdin it takes your own client id, secret and refresh token instead.

The server keeps the details that aren't secret (servers, ports, TLS, login, saving sent mail; for Gmail the
client id), and this command starts from them: it asks only for the password (or the client secret and refresh
token), unseen. In a terminal it first asks whether to keep the stored details; flags change any of them. The
new details replace the old ones whole, so everything is sent again. The address is the inbox's own. Secrets are
sent to the server once and never stored or printed by this command.

${CONNECTION_HELP}

--no-browser            Gmail with Google sign-in: print Google's address instead of opening a browser
--json                  print the inbox as the server gives it afterwards

Example without a terminal (the stored servers are kept):
  printf '%s\\n' "$PASSWORD" | usual-mail inbox reconnect Acme --secrets-stdin`,
  options: { ...CONNECTION_OPTIONS, "no-browser": { type: "boolean" }, json: { type: "boolean" } },
  maxPositionals: 1,
  async run(ctx, { values, positionals }) {
    const client = clientFor(ctx);
    const inbox = await findInbox(client, required(positionals, "inbox reconnect"));
    const manual = Boolean(text(values, "client-id")) || flag(values, "secrets-stdin");
    const google = inbox.provider === "gmail" && !manual && (await client.call<ServerInfo>("info")).googleSignIn?.available === true;
    if (!google) checkFlags(ctx, values, inbox);
    const prompter = ctx.interactive ? ctx.prompter() : null;
    try {
      if (google && (!prompter || (await confirm(prompter, `Sign in with Google in your browser to reconnect ${inbox.name} (${inbox.address})?`, true)))) {
        return await reconnectWithGoogle(ctx, client, values, inbox);
      }
      if (prompter) say(ctx, `New connection details for ${inbox.name} (${inbox.address}, ${PROVIDER_WORDS[inbox.provider] ?? inbox.provider}).`);
      const stored = inbox.connection;
      const { credentials, secrets } = inbox.provider === "imap"
        ? await imapDetails(ctx, prompter, values, inbox.address, stored?.kind === "imap" ? stored : undefined)
        : await gmailDetails(ctx, prompter, values, stored?.kind === "gmail" ? stored : undefined);
      const changed = await client
        .call<Inbox>("updateInbox", {
          params: { id: inbox.id },
          body: { credentials },
          timeoutMs: 120_000,
          scene: { listCommand: "usual-mail inbox list" },
        })
        .catch((error: unknown) => {
          throw withoutSecrets(error, secrets);
        });
      if (flag(values, "json")) return printJson(ctx, changed);
      say(ctx, `The provider accepted the new details for ${changed.name}. Its rules and history stay.`);
      say(ctx, `Status: ${statusLine(changed)}.`);
      if (changed.connection) say(ctx, `Connected: ${connectionWords(changed.connection)}.`);
      say(ctx, changed.status === "paused" ? "It stays paused until `usual-mail inbox resume`." : "It syncs again; `usual-mail inbox list` shows how it goes.");
    } finally {
      prompter?.close();
    }
  },
};

/** Signs the inbox in again with Google, in place; another account than the inbox's is refused by the server. */
async function reconnectWithGoogle(ctx: Context, client: Client, values: Values, inbox: Inbox): Promise<void> {
  const outcome = await signInWithGoogle(ctx, client, { inboxId: inbox.id }, { browser: !flag(values, "no-browser") });
  if (outcome.state !== "connected") throw new Failure(outcome.message ?? "The sign-in didn't finish. Start again.");
  const changed = (await client.call<Inbox[]>("listInboxes")).find((each) => each.id === inbox.id) ?? inbox;
  if (flag(values, "json")) return printJson(ctx, changed);
  say(ctx, `Reconnected ${changed.name} (${changed.address}) by signing in with Google. Its rules and history stay.`);
  say(ctx, `Status: ${statusLine(changed)}.`);
  say(ctx, changed.status === "paused" ? "It stays paused until `usual-mail inbox resume`." : "It syncs again; `usual-mail inbox list` shows how it goes.");
}

/** Without a terminal, or with --json, every answer must come from a flag. */
function checkFlags(ctx: Context, values: Values, inbox: Inbox): void {
  if (ctx.interactive) return;
  needFlags(ctx, missingConnectionFlags(values, inbox.provider, inbox.connection), "inbox reconnect");
}
