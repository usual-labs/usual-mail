// `usual-mail sync-days`: how many days of mail a new inbox's first sync takes. A setting of the server that persists:
// kept in the data directory's settings.json, which the server reads at every start, in Node mode and in Docker alike.
// Changing it restarts the server `init` set up here, so it takes effect at once: a smaller number also stops an
// inbox's first sync in progress from fetching older mail; a larger one applies to inboxes connected afterwards.

import type { FirstSyncWindow } from "@usualmail/core";
import { existsSync } from "node:fs";
import { Client, clientFor } from "../client.ts";
import { flag, text, type Command } from "../command.ts";
import { absolute, readConfig, serverUrl, shown } from "../config.ts";
import { note, printJson, say, warn } from "../context.ts";
import { Failure, UsageError } from "../errors.ts";
import { launcherFor } from "../launch/index.ts";
import { waitUntilAnswering } from "../launch/wait.ts";
import { DEFAULT_SYNC_DAYS, saveSyncDays, savedSyncDays, settingsPath, syncDaysFrom } from "../server-settings.ts";

export const syncDaysCommand: Command = {
  name: "sync-days",
  summary: "show or set how many days of mail a new inbox's first sync takes",
  usage: "usual-mail sync-days [<days>] [--data-dir DIR] [--json]",
  details: `
<days>            a whole number from 1 to 36500. Without it, says what the server takes now
--data-dir DIR    the server's data directory (default: where \`usual-mail init\` set the server up)
--wait SECONDS    how long to wait for the restarted server to answer (default 60)
--json            print { syncDays, file, restarted, serverDays }

When you connect an inbox, the server first copies this many days of its mail and sorts it. Older mail stays in
your mailbox, and new mail always arrives. The number is kept in <data-dir>/settings.json, where the server reads it
at every start, in Node mode and in Docker alike; this restarts the server \`init\` set up here so it takes effect.

A smaller number also applies to an inbox whose first sync is still running: it stops fetching mail older than
that, and what it fetched already stays. A larger number applies to inboxes connected from now on: fetching more
for an inbox already connected would be a new first sync.

USUAL_MAIL_SYNC_DAYS, where the server starts, wins over the saved number.`,
  options: { "data-dir": { type: "string" }, wait: { type: "string" }, json: { type: "boolean" } },
  maxPositionals: 1,
  async run(ctx, { values, positionals }) {
    const config = readConfig(ctx);
    const givenDir = text(values, "data-dir");
    const dataDir = givenDir ? absolute(ctx, givenDir) : config.run?.dataDir;
    // The server `init` runs here, when it is the one whose data directory this is.
    const local = config.run && config.run.dataDir === dataDir ? config.run : undefined;
    const client = ctx.env.USUAL_MAIL_SERVER || config.server ? clientFor(ctx) : null;
    const before = await serverSyncDays(client);
    const saved = dataDir && existsSync(dataDir) ? savedSyncDays(dataDir) : undefined;
    const [given] = positionals;

    if (given === undefined) {
      const days = before ?? saved ?? DEFAULT_SYNC_DAYS;
      if (flag(values, "json")) return printJson(ctx, { syncDays: days, file: dataDir ? settingsPath(dataDir) : null, saved: saved ?? null, serverDays: before });
      say(ctx, `A new inbox's first sync takes the last ${days} days of mail.`);
      if (before !== null && saved !== undefined && before !== saved) say(ctx, mismatchWords(before, saved));
      say(ctx, "`usual-mail sync-days <days>` changes it.");
      return;
    }

    const days = syncDaysFrom(given, "<days>");
    const wait = Number(text(values, "wait") ?? 60);
    if (!Number.isFinite(wait) || wait <= 0) throw new UsageError("--wait takes a number of seconds.");
    if (!dataDir) {
      throw new UsageError(
        "This command doesn't know where the server keeps its data. Pass --data-dir (the folder that holds usual-mail.db), " +
          "or set USUAL_MAIL_SYNC_DAYS where the server runs.",
      );
    }
    if (!existsSync(dataDir)) throw new Failure(`${shown(ctx, dataDir)} doesn't exist. Pass the server's data directory with --data-dir.`);
    const previous = before ?? saved ?? DEFAULT_SYNC_DAYS;
    const changed = saveSyncDays(dataDir, days);
    const fromEnv = ctx.env.USUAL_MAIL_SYNC_DAYS;
    if (fromEnv) warn(ctx, `USUAL_MAIL_SYNC_DAYS is set to ${fromEnv} here, and it wins over this setting wherever the server starts with it. Unset it to use the saved days.`);

    let restarted = false;
    if (local && (changed || (before !== null && before !== days))) {
      const launcher = launcherFor(ctx, local);
      if ((await launcher.state()).state === "running") {
        await launcher.stop();
        await launcher.start();
        await waitUntilAnswering(ctx, new Client(serverUrl(local.port), undefined, ctx.fetch), launcher, wait);
        note(ctx, "Restarted the server, so it takes effect.");
        restarted = true;
      }
    }
    const after = restarted ? await serverSyncDays(client) : before;
    if (flag(values, "json")) return printJson(ctx, { syncDays: days, file: settingsPath(dataDir), restarted, serverDays: after });

    if (!changed && previous === days) {
      say(ctx, `A new inbox's first sync already takes the last ${days} days of mail.`);
      return;
    }
    say(ctx, `A new inbox's first sync now takes the last ${days} days of mail. Saved in ${shown(ctx, settingsPath(dataDir))}.`);
    if (days < previous) {
      say(ctx, `An inbox still on its first sync stops fetching mail older than ${days} days; what it fetched already stays.`);
    } else if (days > previous) {
      say(
        ctx,
        `Inboxes connected from now on take ${days} days. Inboxes already connected keep the mail they have: fetching more ` +
          "for one would be a new first sync, which only removing it and connecting it again starts (removing it deletes " +
          "its rules and history on this server).",
      );
    }
    if (restarted) {
      if (after !== null && after !== days) warn(ctx, mismatchWords(after, days));
    } else if (local) {
      say(ctx, "It takes effect when the server starts: `usual-mail start`.");
    } else {
      say(ctx, "Restart the server where it runs for it to take effect.");
    }
  },
};

/** What the server takes now (`GET /v1/first-sync`, a person's): null without a person's token or an answer. */
export async function serverSyncDays(client: Client | null): Promise<number | null> {
  if (!client?.hasToken) return null;
  try {
    return (await client.raw<FirstSyncWindow>("firstSyncWindow")).days;
  } catch {
    return null;
  }
}

/** When the server takes other days than the saved setting: started with the variable, or before it was saved. */
export function mismatchWords(serverDays: number, savedDays: number): string {
  return (
    `The server takes the last ${serverDays} days of mail, but the saved setting is ${savedDays}: it was started with ` +
    "USUAL_MAIL_SYNC_DAYS, which wins, or before the setting was saved. Start it again without that variable " +
    "(`usual-mail stop`, then `usual-mail start`)."
  );
}
