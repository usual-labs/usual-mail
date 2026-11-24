// Listing and looking after inboxes. Connecting one is in inbox-add.ts.

import type { Inbox } from "@usualmail/core";
import { clientFor } from "../client.ts";
import { flag, needTerminal, type Command } from "../command.ts";
import { printJson, say } from "../context.ts";
import { UsageError } from "../errors.ts";
import { PROVIDER_WORDS, statusLine, table, utc } from "../format.ts";
import { nearestHat, swatch } from "../hats.ts";
import { findInbox } from "../lookup.ts";
import { confirm } from "../prompt.ts";
import { connectionShort } from "./credentials.ts";

const json = { json: { type: "boolean" } } as const;
const INBOX_SCENE = { listCommand: "usual-mail inbox list" };

export const inboxList: Command = {
  name: "inbox list",
  summary: "list inboxes, with the reason when something is wrong",
  usage: "usual-mail inbox list [--json]",
  details: `
--json   print the inboxes as the server gives them

Each inbox shows its place in the apps' profile switch (# counts from 1; \`inbox move\` changes it), its icon
(\`inbox icon\`), its hat (the nearest of the twelve colours), its address, its provider, how it is connected (the
details the server keeps that aren't secret; \`inbox reconnect\` starts from them), its status (while its first sync
runs, how far it has got: "fetching your mail · 120 of 340") and when it last synced.`,
  options: json,
  maxPositionals: 0,
  async run(ctx, { values }) {
    const inboxes = await clientFor(ctx).call<Inbox[]>("listInboxes");
    if (flag(values, "json")) return printJson(ctx, inboxes);
    if (!inboxes.length) return say(ctx, "No inboxes yet. `usual-mail inbox add` connects one.");
    const rows = [...inboxes].sort((a, b) => a.position - b.position).map((inbox) => [
      String(inbox.position + 1),
      `${swatch(inbox.color, ctx.color)}${inbox.name}`,
      inbox.icon,
      nearestHat(inbox.color).name,
      inbox.address,
      PROVIDER_WORDS[inbox.provider] ?? inbox.provider,
      inbox.connection ? connectionShort(inbox.connection) : "",
      statusLine(inbox),
      utc(inbox.lastSyncedAt),
      inbox.id,
    ]);
    ctx.stdout.write(table(["#", "NAME", "ICON", "HAT", "ADDRESS", "PROVIDER", "CONNECTION", "STATUS", "LAST SYNC", "ID"], rows));
  },
};

export const inboxSync: Command = {
  name: "inbox sync",
  summary: "check an inbox for new mail now",
  usage: "usual-mail inbox sync <inbox>",
  details: `
<inbox> is the inbox's id, name or address, as \`usual-mail inbox list\` shows them.

The server queues the sync and answers at once. \`usual-mail inbox list\` shows how it went.`,
  options: {},
  maxPositionals: 1,
  async run(ctx, { positionals }) {
    const client = clientFor(ctx);
    const inbox = await findInbox(client, required(positionals, "inbox sync"));
    await client.call("syncInbox", { params: { id: inbox.id }, scene: INBOX_SCENE });
    say(ctx, `Asked the server to sync ${inbox.name}.`);
  },
};

function pauseCommand(paused: boolean): Command {
  const name = paused ? "inbox pause" : "inbox resume";
  return {
    name,
    summary: paused ? "stop syncing an inbox until it is resumed" : "sync a paused inbox again",
    usage: `usual-mail ${name} <inbox> [--json]`,
    details: `
<inbox>  the inbox's id, name or address
--json   print the inbox as the server gives it afterwards`,
    options: json,
    maxPositionals: 1,
    async run(ctx, { values, positionals }) {
      const client = clientFor(ctx);
      const inbox = await findInbox(client, required(positionals, name));
      const changed = await client.call<Inbox>("updateInbox", {
        params: { id: inbox.id },
        body: { paused },
        scene: INBOX_SCENE,
      });
      if (flag(values, "json")) return printJson(ctx, changed);
      say(ctx, paused ? `Paused ${changed.name}. Nothing syncs until \`usual-mail inbox resume\`.` : `Resumed ${changed.name}.`);
    },
  };
}

export const inboxPause = pauseCommand(true);
export const inboxResume = pauseCommand(false);

export const inboxRemove: Command = {
  name: "inbox remove",
  summary: "remove an inbox from Usual Mail (asks first)",
  usage: "usual-mail inbox remove <inbox> [--yes]",
  details: `
<inbox>  the inbox's id, name or address
--yes    don't ask; needed when this isn't a terminal

The server deletes its copy of the inbox's mail, its rules, history, drafts and guide, and agents lose access to
it. Briefs no longer show its section. Nothing changes at the provider: the mail stays, and so do the labels or
folders Usual Mail made there. It can't be undone.`,
  options: { yes: { type: "boolean", short: "y" } },
  maxPositionals: 1,
  async run(ctx, { values, positionals }) {
    const client = clientFor(ctx);
    const inbox = await findInbox(client, required(positionals, "inbox remove"));
    if (!flag(values, "yes")) {
      needTerminal(ctx, "--yes to remove it without asking");
      const prompter = ctx.prompter();
      try {
        say(ctx, `The server will delete everything it holds for ${inbox.name} (${inbox.address}): its copy of the mail, its rules,`);
        say(ctx, "its history, its drafts and its guide. Agents lose access to it, and briefs no longer show its section.");
        say(ctx, "Nothing changes at the provider: the mail stays, and so do the labels or folders Usual Mail made there.");
        say(ctx, "This can't be undone.");
        if (!(await confirm(prompter, `Remove ${inbox.name}?`, false))) return say(ctx, "Nothing was removed.");
      } finally {
        prompter.close();
      }
    }
    await client.call("removeInbox", { params: { id: inbox.id }, scene: INBOX_SCENE });
    say(ctx, `Removed ${inbox.name}. Nothing changed at the provider.`);
  },
};

export function required(positionals: string[], command: string): string {
  const value = positionals[0];
  if (!value) {
    throw new UsageError(`\`usual-mail ${command}\` needs the inbox: its id, name or address. \`usual-mail inbox list\` shows them.`);
  }
  return value;
}
