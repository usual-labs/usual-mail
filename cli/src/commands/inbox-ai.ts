// An inbox's icon and its place in the profile switch. (There is no per-inbox AI switch since 2026-11-17: a key
// processes every inbox's mail, and `usual-mail ai set` shows what is sent and to whom before it saves one.)

import { INBOX_ICONS, type Inbox, type InboxIcon } from "@usualmail/core";
import { clientFor } from "../client.ts";
import { flag, type Command } from "../command.ts";
import { printJson, say } from "../context.ts";
import { UsageError } from "../errors.ts";
import { findInbox } from "../lookup.ts";
import { required } from "./inbox.ts";

const INBOX_SCENE = { listCommand: "usual-mail inbox list" };

export const inboxIcon: Command = {
  name: "inbox icon",
  summary: "choose an inbox's icon in the apps' profile switch",
  usage: `usual-mail inbox icon <inbox> <icon> [--json]`,
  details: `
<inbox>  the inbox's id, name or address
<icon>   one of: ${INBOX_ICONS.join(", ")}
--json   print the inbox as the server gives it afterwards`,
  options: { json: { type: "boolean" } },
  maxPositionals: 2,
  async run(ctx, { values, positionals }) {
    const [ref, icon] = positionals;
    if (!icon) throw new UsageError(`\`usual-mail inbox icon\` needs the inbox and the icon: one of ${INBOX_ICONS.join(", ")}.`);
    if (!(INBOX_ICONS as readonly string[]).includes(icon)) throw new UsageError(`The icon is one of ${INBOX_ICONS.join(", ")}, not "${icon}".`);
    const client = clientFor(ctx);
    const inbox = await findInbox(client, required([ref!], "inbox icon"));
    const changed = await client.call<Inbox>("updateInbox", { params: { id: inbox.id }, body: { icon: icon as InboxIcon }, scene: INBOX_SCENE });
    if (flag(values, "json")) return printJson(ctx, changed);
    say(ctx, `${changed.name}'s icon is now ${changed.icon}.`);
  },
};

export const inboxMove: Command = {
  name: "inbox move",
  summary: "move an inbox to another place in the profile switch and the inbox list",
  usage: "usual-mail inbox move <inbox> <position> [--json]",
  details: `
<inbox>     the inbox's id, name or address
<position>  its new place, counting from 1 as \`usual-mail inbox list\` shows it (the server counts from 0)
--json      print the inbox as the server gives it afterwards

The others move up or down to make room; no two share a place.`,
  options: { json: { type: "boolean" } },
  maxPositionals: 2,
  async run(ctx, { values, positionals }) {
    const [ref, place] = positionals;
    if (!place) throw new UsageError("`usual-mail inbox move` needs the inbox and its new place, counting from 1.");
    const client = clientFor(ctx);
    const inboxes = await client.call<Inbox[]>("listInboxes");
    const position = Number(place);
    if (!/^\d+$/.test(place) || position < 1 || position > inboxes.length) {
      throw new UsageError(`The place is a whole number from 1 to ${inboxes.length}, not "${place}".`);
    }
    const inbox = await findInbox(client, required([ref!], "inbox move"));
    if (inbox.position === position - 1) {
      if (flag(values, "json")) return printJson(ctx, inbox);
      return say(ctx, `${inbox.name} is already in place ${position}. Nothing changed.`);
    }
    const changed = await client.call<Inbox>("updateInbox", { params: { id: inbox.id }, body: { position: position - 1 }, scene: INBOX_SCENE });
    if (flag(values, "json")) return printJson(ctx, changed);
    say(ctx, `Moved ${changed.name} to place ${changed.position + 1} of ${inboxes.length}.`);
  },
};

