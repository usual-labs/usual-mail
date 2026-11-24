// Starting, stopping and watching the server `init` set up, in either mode.

import type { Device, ServerInfo } from "@usualmail/core";
import { existsSync } from "node:fs";
import { Client, clientFor, whoAmI } from "../client.ts";
import { flag, text, type Command } from "../command.ts";
import { readConfig, serverUrl, shown, type Config, type RunSettings } from "../config.ts";
import { printJson, say, type Context } from "../context.ts";
import { Failure, UsageError } from "../errors.ts";
import { launcherFor } from "../launch/index.ts";
import { portIsFree } from "../launch/launcher.ts";
import { waitUntilAnswering } from "../launch/wait.ts";
import { savedSyncDays } from "../server-settings.ts";
import { serverSyncDays } from "./sync-days.ts";

/** The run settings `init` saved, or a failure that says why there are none. */
export function runSettings(ctx: Context, config: Config = readConfig(ctx)): RunSettings {
  if (config.run) return config.run;
  if (config.server) {
    throw new Failure(
      `usual-mail didn't set up the server at ${config.server} on this machine, so it can't start or stop it. ` +
        "Do that where it runs.",
      "not_set_up",
    );
  }
  throw new Failure("No server is set up on this machine yet. Run `usual-mail init`.", "not_set_up");
}

const describe = (ctx: Context, run: RunSettings) =>
  run.mode === "docker"
    ? `Docker (container ${run.container}, image ${run.image}), data in ${shown(ctx, run.dataDir)}`
    : `Node (${shown(ctx, run.serverFile ?? "?")}), data in ${shown(ctx, run.dataDir)}`;

export const start: Command = {
  name: "start",
  summary: "start the server init set up",
  usage: "usual-mail start [--wait SECONDS]",
  details: `
--wait SECONDS   how long to wait for it to answer (default 60)

In Docker it starts the container again; it also starts by itself when Docker starts, until \`usual-mail stop\`.
In Node mode it starts the server in the background, with its output in ~/.local/state/usual-mail/server.log.`,
  options: { wait: { type: "string" } },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const run = runSettings(ctx);
    const launcher = launcherFor(ctx, run);
    const client = new Client(serverUrl(run.port), undefined, ctx.fetch);
    await launcher.prepare({ build: false });
    if ((await launcher.state()).state === "running") {
      return say(ctx, `It runs already, at ${client.server}.`);
    }
    if (!(await portIsFree(run.port))) {
      throw new Failure(`Port ${run.port} is in use by another program. Stop it, or run \`usual-mail init --port <other>\`.`);
    }
    await launcher.start();
    const wait = Number(text(values, "wait") ?? 60);
    if (!Number.isFinite(wait) || wait <= 0) throw new UsageError("--wait takes a number of seconds.");
    await waitUntilAnswering(ctx, client, launcher, wait);
    say(ctx, `Started. Usual Mail answers at ${client.server}.`);
  },
};

export const stop: Command = {
  name: "stop",
  summary: "stop the server init set up",
  usage: "usual-mail stop",
  details: `
In Docker the container stays stopped, also after Docker restarts, until \`usual-mail start\`. Its data stays.`,
  options: {},
  maxPositionals: 0,
  async run(ctx) {
    const launcher = launcherFor(ctx, runSettings(ctx));
    say(ctx, (await launcher.stop()) ? "Stopped." : "It wasn't running.");
  },
};

export const status: Command = {
  name: "status",
  summary: "say whether the server runs and answers",
  usage: "usual-mail status [--json]",
  details: `
--json   print the same as JSON

Exits with 0 when the server answers and 1 when it doesn't.`,
  options: { json: { type: "boolean" } },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const config = readConfig(ctx);
    const client = clientFor(ctx);
    const run = config.run && config.server === client.server ? config.run : undefined;
    const runState = run ? await launcherFor(ctx, run).state() : undefined;
    const answers = await client.healthy(3_000);
    const info = answers ? await client.call<ServerInfo>("info").catch(() => null) : null;
    const device = answers && client.hasToken ? await whoAmI(client).catch(() => null) : null;
    // How many days of mail a new inbox's first sync takes: what the server uses, else what is saved for it here.
    const syncDays = (answers ? await serverSyncDays(client) : null) ?? (run && existsSync(run.dataDir) ? savedSyncDays(run.dataDir) ?? null : null);
    if (flag(values, "json")) {
      printJson(ctx, {
        server: client.server,
        mode: run?.mode ?? "elsewhere",
        dataDir: run?.dataDir,
        port: run?.port,
        state: runState?.state,
        stateDetail: runState?.detail,
        answers,
        version: info?.version ?? null,
        paired: device ? { id: device.id, name: device.name, kind: device.kind } : null,
        syncDays,
      });
    } else {
      say(ctx, `Server     ${client.server}`);
      say(ctx, `Runs with  ${run ? describe(ctx, run) : "set up elsewhere, not by usual-mail on this machine"}`);
      if (runState) say(ctx, `State      ${runState.state}${runState.detail ? ` (${runState.detail})` : ""}`);
      say(ctx, `Answers    ${answers ? `yes, version ${info?.version ?? "unknown"}` : "no"}`);
      if (answers) {
        say(ctx, `Paired as  ${device ? pairedAs(device, Boolean(ctx.env.USUAL_MAIL_TOKEN)) : client.hasToken ? "nothing: the server refuses this command's token" : "nothing yet"}`);
      }
      if (syncDays !== null) say(ctx, `First sync the last ${syncDays} days of mail, for each new inbox (\`usual-mail sync-days\` changes it)`);
      if (!answers) say(ctx, run ? "`usual-mail start` starts it; `usual-mail logs` shows why it stopped." : "Check it where it runs.");
      else if (!device) say(ctx, "`usual-mail init` pairs this command.");
    }
    if (!answers) throw new Failure("", "unreachable");
  },
};

/** What the token in use belongs to, in words, as the server names it, and whether it came from USUAL_MAIL_TOKEN. */
function pairedAs(device: Device, fromEnv: boolean): string {
  const kind = device.kind === "agent" ? ", an agent" : "";
  return `${device.name}${kind}${fromEnv ? " (the token in USUAL_MAIL_TOKEN)" : ""}`;
}

export const logs: Command = {
  name: "logs",
  summary: "show the server's log",
  usage: "usual-mail logs [--follow] [--lines N]",
  details: `
--follow, -f   keep showing new lines until Ctrl-C
--lines N      how many of the last lines to show first (default 100)

The server prints an owner's pairing code once, when it makes it; a later start only says one waits. Read the
code from owner-pairing-code in the data directory, not from the log: \`usual-mail init\` pairs with it.`,
  options: { follow: { type: "boolean", short: "f" }, lines: { type: "string" } },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const lines = Number(text(values, "lines") ?? 100);
    if (!Number.isInteger(lines) || lines < 1) throw new UsageError("--lines takes a whole number above 0.");
    await launcherFor(ctx, runSettings(ctx)).logs({ follow: flag(values, "follow"), lines });
  },
};
