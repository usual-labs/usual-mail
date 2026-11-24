// `usual-mail init`: sets up a server on this machine, starts it, and pairs this command as the owner's device.
// Safe to run again: with the same settings and a working token it changes nothing.

import type { Device, PairResult, ServerInfo } from "@usualmail/core";
import { existsSync, mkdirSync } from "node:fs";
import { Client } from "../client.ts";
import { flag, needTerminal, portFrom, text, type Command, type Values } from "../command.ts";
import {
  absolute,
  configFile,
  DEFAULT_CONTAINER,
  DEFAULT_IMAGE,
  DEFAULT_PORT,
  defaultDataDir,
  readConfig,
  sameConfig,
  serverUrl,
  shown,
  writeConfig,
  type Config,
  type RunMode,
  type RunSettings,
} from "../config.ts";
import { note, printJson, say, warn, type Context } from "../context.ts";
import { ApiError, explain, Failure, UsageError } from "../errors.ts";
import { launcherFor } from "../launch/index.ts";
import { portIsFree } from "../launch/launcher.ts";
import { defaultServerFile } from "../launch/node.ts";
import { readOwnerCode, waitUntilAnswering } from "../launch/wait.ts";
import { askNumber, askText, choose, type Prompter } from "../prompt.ts";
import { DEFAULT_SYNC_DAYS, envSyncDays, MAX_SYNC_DAYS, saveSyncDays, savedSyncDays, SYNC_DAYS_WORDS, syncDaysFrom } from "../server-settings.ts";

export const init: Command = {
  name: "init",
  summary: "set up a server on this machine, start it and pair this command with it",
  usage: "usual-mail init [--mode docker|node] [--data-dir DIR] [--port N] [flags]",
  details: `
In a terminal it asks how to run the server, where to keep its data and which port to use. It then starts the
server, waits until it answers, reads the owner's pairing code from the data directory and pairs this command
with it. The server writes that code whenever no app or browser is paired, and a new one when it expires, so
\`init\` also pairs this command again after its device was removed. Running it again with the same settings
changes nothing.

--mode docker|node    run the server in Docker, or directly with Node on this machine
--data-dir DIR        where the server keeps its data (default ~/.local/share/usual-mail)
--port N              the port on this machine (default ${DEFAULT_PORT}); it listens on 127.0.0.1 only
--sync-days N         how many days of mail a new inbox's first sync takes (default 30, or USUAL_MAIL_SYNC_DAYS);
                      kept in the data directory's settings.json, where every start finds it
--name NAME           what this command is called in the device list
--wait SECONDS        how long to wait for the server to answer (default 60)
--json                print the result as JSON

Docker:
--image NAME          the image to run (default "${DEFAULT_IMAGE}"). Run from a checkout of Usual Mail, a missing
                      image is built from it; --no-build fails instead
--container NAME      the container's name (default "${DEFAULT_CONTAINER}")

Node:
--server-file FILE    the server's built file (default server/dist/server.mjs in the checkout around this command)

A server that runs elsewhere (another machine, or compose.yaml):
--server URL          don't run a server; pair this command with the one at URL
--code CODE           the pairing code to use, when the owner's code isn't in --data-dir

The command's token and the server's address are saved in ~/.config/usual-mail/config.json, readable only by
you. The token is never printed.`,
  options: {
    mode: { type: "string" },
    "data-dir": { type: "string" },
    port: { type: "string" },
    "sync-days": { type: "string" },
    name: { type: "string" },
    wait: { type: "string" },
    image: { type: "string" },
    container: { type: "string" },
    "no-build": { type: "boolean" },
    "server-file": { type: "string" },
    server: { type: "string" },
    code: { type: "string" },
    json: { type: "boolean" },
  },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const config = readConfig(ctx);
    const waitSeconds = seconds(text(values, "wait"));
    const prompter = ctx.interactive ? ctx.prompter() : null;
    try {
      if (text(values, "server")) return await pairElsewhere(ctx, config, values, prompter);
      const run = await settings(ctx, config.run, values, prompter);
      const launcher = launcherFor(ctx, run);
      await launcher.prepare({ build: !flag(values, "no-build") });

      const previous = config.run;
      if (previous && !sameConfig(previous, run)) await stopPrevious(ctx, previous);
      if (!existsSync(run.dataDir)) mkdirSync(run.dataDir, { recursive: true, mode: 0o700 });
      // The first sync's days live in the data directory, where the server reads them at every start.
      const syncDays = await syncDaysSetting(ctx, run.dataDir, values, prompter);
      const syncChanged = saveSyncDays(run.dataDir, syncDays);
      if (syncChanged && (await launcher.state()).state === "running" && (await launcher.stop())) {
        note(ctx, `Stopped the server, so it starts again with the first sync's ${syncDays} days.`);
      }

      const server = serverUrl(run.port);
      const client = new Client(server, undefined, ctx.fetch);
      if ((await launcher.state()).state !== "running" && !(await portIsFree(run.port))) {
        throw (await client.healthy())
          ? new Failure(
              `A Usual Mail server already answers at ${server}, and usual-mail didn't start it here. ` +
                `To use it: \`usual-mail init --server ${server}\`. To run another one, pick a port with --port.`,
            )
          : new Failure(`Port ${run.port} is in use by another program. Pick another with --port.`);
      }

      // The saved token is kept and checked below: with the same data directory it still works on a new port.
      const next: Config = { ...config, server, run };
      const changedSettings = !sameConfig(config, next);
      if (changedSettings) writeConfig(ctx, next);

      const started = await launcher.start();
      if (started) note(ctx, `Started the server with ${launcher.label}. Waiting for it to answer…`);
      await waitUntilAnswering(ctx, client, launcher, waitSeconds);
      const info = await serverInfo(client);

      const paired = await pairIfNeeded(
        ctx,
        next,
        server,
        values,
        async () => text(values, "code") ?? (await readOwnerCode(ctx, run.dataDir, started ? 10 : 2)),
        async () => (text(values, "code") ? null : await readOwnerCode(ctx, run.dataDir, 2)),
      );
      const changed = changedSettings || syncChanged || started || paired.isNew;
      if (flag(values, "json")) {
        return printJson(ctx, {
          server,
          version: info.version,
          mode: run.mode,
          dataDir: run.dataDir,
          port: run.port,
          syncDays,
          device: { id: paired.device.id, name: paired.device.name },
          changed,
        });
      }
      say(ctx, `${changed ? "Usual Mail runs" : "Usual Mail already runs"} at ${server} (${launcher.label}; data in ${shown(ctx, run.dataDir)}).`);
      if (!changed) say(ctx, "Nothing changed.");
      nextSteps(ctx, paired.device.name);
    } finally {
      prompter?.close();
    }
  },
};

/** Flags first, then what an earlier `init` chose, then questions (in a terminal, the first time), then defaults. */
async function settings(ctx: Context, previous: RunSettings | undefined, values: Values, p: Prompter | null): Promise<RunSettings> {
  const firstTime = !previous;
  const given = text(values, "mode") ?? previous?.mode;
  if (given !== undefined && given !== "docker" && given !== "node") {
    throw new UsageError(`--mode takes docker or node, not "${given}".`);
  }
  let mode: RunMode | undefined = given;
  if (!mode) {
    needTerminal(ctx, "--mode docker or --mode node (and --data-dir and --port if not the defaults)");
    mode = await choose<RunMode>(p!, (line) => ctx.stdout.write(line), "How do you want to run the server?", [
      { label: "Docker: a container that restarts with the machine (needs Docker)", value: "docker" },
      { label: "Node: a process on this machine, from a built checkout of Usual Mail", value: "node" },
    ]);
  }
  const ask = firstTime && p !== null;
  const givenDir = text(values, "data-dir");
  const dataDir = absolute(
    ctx,
    givenDir ?? previous?.dataDir ?? (ask ? await askText(p!, "Where to keep the server's data", defaultDataDir(ctx)) : defaultDataDir(ctx)),
  );
  const givenPort = text(values, "port");
  const port =
    givenPort !== undefined || previous?.port !== undefined || !ask
      ? portFrom(givenPort, previous?.port ?? DEFAULT_PORT)
      : await askNumber(p!, "Port on this machine", DEFAULT_PORT, 1, 65_535);
  const keep = previous?.mode === mode ? previous : undefined;
  if (mode === "docker") {
    return {
      mode,
      dataDir,
      port,
      image: text(values, "image") ?? keep?.image ?? DEFAULT_IMAGE,
      container: text(values, "container") ?? keep?.container ?? DEFAULT_CONTAINER,
    };
  }
  const serverFile = text(values, "server-file") ?? keep?.serverFile ?? defaultServerFile(ctx) ?? undefined;
  return { mode, dataDir, port, ...(serverFile ? { serverFile: absolute(ctx, serverFile) } : {}) };
}

/**
 * How many days of mail a new inbox's first sync takes: the flag, else what the data directory already holds, else a
 * question (in a terminal) whose default is USUAL_MAIL_SYNC_DAYS or 30, else that default. Saving the variable's value
 * means a later plain start, without the variable, keeps it.
 */
async function syncDaysSetting(ctx: Context, dataDir: string, values: Values, p: Prompter | null): Promise<number> {
  const given = text(values, "sync-days");
  if (given !== undefined) return syncDaysFrom(given, "--sync-days");
  const saved = savedSyncDays(dataDir);
  if (saved !== undefined) return saved;
  const fallback = envSyncDays(ctx) ?? DEFAULT_SYNC_DAYS;
  if (!p) return fallback;
  say(ctx, SYNC_DAYS_WORDS);
  return askNumber(p, "Days of mail for a new inbox's first sync", fallback, 1, MAX_SYNC_DAYS);
}

async function stopPrevious(ctx: Context, previous: RunSettings): Promise<void> {
  try {
    if (await launcherFor(ctx, previous).stop()) note(ctx, "Stopped the server set up before with other settings.");
  } catch (error) {
    warn(ctx, `Couldn't stop the server set up before: ${(error as Error).message}`);
  }
}

/**
 * Pairs this command unless its saved token still works. The owner's code comes from `code()`: a flag, the file the
 * server writes whenever no person's device is paired, or a question. The server writes a new code to that file
 * when the old one expires, so a code refused as used or expired is read once more from `retry()`.
 */
async function pairIfNeeded(
  ctx: Context,
  config: Config,
  server: string,
  values: Values,
  code: () => Promise<string | null>,
  retry: () => Promise<string | null> = async () => null,
): Promise<{ device: Device; isNew: boolean }> {
  if (config.token) {
    const device = await currentDevice(new Client(server, config.token, ctx.fetch));
    if (device) return { device, isNew: false };
    note(ctx, "The saved token no longer works here, so this command pairs again.");
  }
  const found = await code();
  if (!found) {
    throw new Failure(
      "The server has no owner's pairing code, because an app or browser is paired with it already. " +
        "Make a pairing code there (Devices in the dashboard, or `usual-mail pair` where this command is paired) " +
        "and run `usual-mail init --code <code>`.",
      "unauthorized",
    );
  }
  const name = text(values, "name") ?? `usual-mail on ${ctx.hostname()}`;
  const anonymous = new Client(server, undefined, ctx.fetch);
  let result: PairResult;
  try {
    result = await anonymous.raw<PairResult>("pair", { body: { code: found, name } });
  } catch (error) {
    const again = error instanceof ApiError && error.code === "unauthorized" ? await retry() : null;
    if (!again || again === found) throw error instanceof ApiError ? explain(error, { pairing: true }) : error;
    note(ctx, "That owner's code had expired; the server wrote a new one, so this command uses that.");
    result = await anonymous.call<PairResult>("pair", { body: { code: again, name } });
  }
  if (result.device.kind !== "person") {
    // A code made for an agent: this command must be a person's device. End the agent's new token at once.
    await new Client(server, result.token, ctx.fetch).raw("revokeDevice", { params: { id: result.device.id } }).catch(() => undefined);
    throw new Failure(
      "That code was made for an agent, so this command can't pair with it. Make a code for an app: `usual-mail pair` " +
        "where this command is paired, or Devices in the dashboard.",
      "invalid",
    );
  }
  writeConfig(ctx, { ...config, server, token: result.token, deviceId: result.device.id, deviceName: result.device.name });
  note(ctx, `Paired this command with the server as "${result.device.name}".`);
  return { device: result.device, isNew: true };
}

/** The device the saved token belongs to, from `GET /v1/me`, or null when the server refuses it. */
async function currentDevice(client: Client): Promise<Device | null> {
  try {
    return await client.raw<Device>("me");
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthorized") return null;
    throw error instanceof ApiError ? new Failure(`The server refused to say which device this is: ${error.message}`, error.code) : error;
  }
}

/** Pairs with a server that runs elsewhere, without running anything here. */
async function pairElsewhere(ctx: Context, config: Config, values: Values, p: Prompter | null): Promise<void> {
  const server = text(values, "server")!.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(server)) throw new UsageError(`--server takes an address like http://127.0.0.1:8484, not "${server}".`);
  const client = new Client(server, undefined, ctx.fetch);
  if (!(await client.healthy(5_000))) throw new Failure(`Nothing answers at ${server}. Check the address and that the server runs.`, "unreachable");
  const info = await serverInfo(client);
  const base: Config = config.server === server ? { ...config } : withoutToken({ ...config, server });
  if (base.run && config.server !== server) {
    warn(ctx, "The server set up on this machine before keeps running; usual-mail now talks to the one at the new address.");
    delete base.run;
  }
  const dataDir = text(values, "data-dir");
  const paired = await pairIfNeeded(
    ctx,
    base,
    server,
    values,
    async () => {
      const given = text(values, "code") ?? (dataDir ? await readOwnerCode(ctx, absolute(ctx, dataDir), 2) : null);
      if (given) return given;
      needTerminal(ctx, "--code with a pairing code made in an app that is already paired, or the server's --data-dir");
      return askText(p!, "Pairing code (while no app or browser is paired, the owner's code is in owner-pairing-code in the server's data directory)");
    },
    async () => (!text(values, "code") && dataDir ? await readOwnerCode(ctx, absolute(ctx, dataDir), 2) : null),
  );
  if (!paired.isNew && !sameConfig(config, base)) writeConfig(ctx, base);
  if (flag(values, "json")) {
    return printJson(ctx, { server, version: info.version, mode: "elsewhere", device: { id: paired.device.id, name: paired.device.name }, changed: paired.isNew });
  }
  say(ctx, `${paired.isNew ? "This command now talks to" : "This command already talks to"} the Usual Mail server at ${server}.`);
  nextSteps(ctx, paired.device.name);
}

async function serverInfo(client: Client): Promise<ServerInfo> {
  const info = await client.call<ServerInfo>("info");
  if (info?.name !== "usual-mail") throw new Failure(`${client.server} answers, but it isn't a Usual Mail server.`);
  return info;
}

function withoutToken(config: Config): Config {
  const { token: _token, deviceId: _id, deviceName: _name, ...rest } = config;
  return rest;
}

function seconds(value: string | undefined): number {
  if (value === undefined) return 60;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--wait takes a number of seconds, not "${value}".`);
  return n;
}

function nextSteps(ctx: Context, deviceName: string): void {
  say(ctx, `This command is paired as "${deviceName}". Its token is in ${shown(ctx, configFile(ctx))}, readable only by you.`);
  say(ctx, "");
  say(ctx, "Next:");
  say(ctx, "  usual-mail inbox add    connect a mailbox");
  say(ctx, "  usual-mail pair         make a pairing code for the Mac or iPhone app");
  say(ctx, "  usual-mail agent add    give your agent access to chosen inboxes");
  say(ctx, "  usual-mail doctor       check the setup");
}
