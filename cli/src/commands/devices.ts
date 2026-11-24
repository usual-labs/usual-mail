// Pairing a new app, and the list of paired apps and agents.

import type { Device, PairingCode } from "@usualmail/core";
import { clientFor, whoAmI } from "../client.ts";
import { flag, needTerminal, type Command } from "../command.ts";
import { printJson, say } from "../context.ts";
import { UsageError } from "../errors.ts";
import { fromNow, isLoopback, table, utc } from "../format.ts";
import { pick } from "../lookup.ts";
import { confirm } from "../prompt.ts";

export const pair: Command = {
  name: "pair",
  summary: "make a pairing code for a new app",
  usage: "usual-mail pair [--json]",
  details: `
--json   print the code, its expiry and the server's address as JSON

Type the server's address and the code into the app. The code works once, and only until it expires.`,
  options: { json: { type: "boolean" } },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const client = clientFor(ctx);
    const code = await client.call<PairingCode>("createPairingCode", { body: { kind: "person" } });
    if (flag(values, "json")) return printJson(ctx, { ...code, server: client.server });
    say(ctx, `Pairing code  ${code.code}`);
    say(ctx, `Server        ${client.server}`);
    say(ctx, `Valid until   ${utc(code.expiresAt)} (${fromNow(code.expiresAt, ctx.now())}), once`);
    if (isLoopback(client.server)) {
      say(ctx, "");
      say(ctx, "That address works only on this machine. An app on another device needs an address it can reach;");
      say(ctx, "see the comments in compose.yaml for safe ways to offer one.");
    }
  },
};

export const devicesList: Command = {
  name: "devices",
  summary: "list the apps and agents paired with the server",
  usage: "usual-mail devices [--json]",
  details: `
--json   print the devices as the server gives them

\`usual-mail devices revoke <device>\` ends one's access.`,
  options: { json: { type: "boolean" } },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const client = clientFor(ctx);
    const devices = await client.call<Device[]>("listDevices");
    if (flag(values, "json")) return printJson(ctx, devices);
    // The device the token in use belongs to, as the server says: the saved one, or USUAL_MAIL_TOKEN's.
    const own = (await whoAmI(client))?.id;
    const rows = devices.map((device) => [
      device.id === own ? `${device.name} (this command)` : device.name,
      device.kind === "agent" ? "agent" : "app",
      utc(device.createdAt),
      device.lastSeenAt ? utc(device.lastSeenAt) : "never",
      device.id,
    ]);
    ctx.stdout.write(table(["NAME", "KIND", "PAIRED", "LAST SEEN", "ID"], rows));
  },
};

export const devicesRevoke: Command = {
  name: "devices revoke",
  summary: "end a paired app's or agent's access",
  usage: "usual-mail devices revoke <device> [--yes]",
  details: `
<device>  the device's id or name, as \`usual-mail devices\` shows them
--yes     needed to revoke this command's own device without a terminal

Its token stops working at once. Revoking this command's own device asks first, because the command then
can't reach the server until it is paired again. When no person's device is left, the server makes a new owner's
pairing code at once, and \`usual-mail init\` pairs this command again with it.`,
  options: { yes: { type: "boolean", short: "y" } },
  maxPositionals: 1,
  async run(ctx, { values, positionals }) {
    const ref = positionals[0];
    if (!ref) throw new UsageError("`usual-mail devices revoke` needs the device: its id or name. `usual-mail devices` shows them.");
    const client = clientFor(ctx);
    const devices = await client.call<Device[]>("listDevices");
    const device = pick(devices, ref, "device", "usual-mail devices", (item) => [item.name]);
    const own = device.id === (await whoAmI(client))?.id;
    const lastPerson = device.kind === "person" && !devices.some((item) => item.kind === "person" && item.id !== device.id);
    if (own && !flag(values, "yes")) {
      needTerminal(ctx, "--yes to revoke this command's own device");
      const prompter = ctx.prompter();
      try {
        say(ctx, "That is this command's own device. Afterwards it can't reach the server until it is paired again.");
        if (!(await confirm(prompter, "Revoke it anyway?", false))) return say(ctx, "Nothing was revoked.");
      } finally {
        prompter.close();
      }
    }
    await client.call("revokeDevice", { params: { id: device.id }, scene: { listCommand: "usual-mail devices" } });
    say(ctx, `Revoked ${device.name}. Its token no longer works.`);
    if (lastPerson) {
      // docs/contract.md, "Pairing and sign-in": with no person's device left, the server makes a new owner's code.
      say(ctx, "No app or browser is paired any more, so the server made a new owner's pairing code.");
      say(ctx, "It is in owner-pairing-code in its data directory; `usual-mail init` pairs this command with it.");
    }
  },
};
