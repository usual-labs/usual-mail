// Agents: a token that sees chosen inboxes, for an agent to use with the connector at /mcp.

import type { Device, Inbox, PairingCode, PairResult } from "@usualmail/core";
import { clientFor, type Client } from "../client.ts";
import { flag, list, needTerminal, type Command } from "../command.ts";
import { printJson, say } from "../context.ts";
import { Failure, UsageError } from "../errors.ts";
import { isLoopback, table, utc } from "../format.ts";
import { pick } from "../lookup.ts";
import { askText, chooseMany, confirm } from "../prompt.ts";

export const agentAdd: Command = {
  name: "agent add",
  summary: "give an agent access to chosen inboxes",
  usage: "usual-mail agent add [<name>] [--inbox INBOX]... [--all] [--json]",
  details: `
<name>          what the agent is called in the device list, for example "Claude Code"
--inbox INBOX   an inbox it may see: its id, name or address. Repeat it, or separate several with commas
--all           every inbox there is now
--json          print the agent, the connector's address and the token as JSON

An agent sees an inbox only when it was given the inbox and the inbox's agent access is on. This command turns
agent access on for the inboxes it gives, and says so.

The token is shown once. Give it to the agent with the connector's address; the agent sends it as
"Authorization: Bearer <token>". \`usual-mail agent remove\` ends its access.`,
  options: { inbox: { type: "string", multiple: true }, all: { type: "boolean" }, json: { type: "boolean" } },
  maxPositionals: 1,
  async run(ctx, { values, positionals }) {
    const client = clientFor(ctx);
    const inboxes = await client.call<Inbox[]>("listInboxes");
    if (!inboxes.length) throw new Failure("There are no inboxes to give yet. `usual-mail inbox add` connects one.", "invalid");
    let name = positionals[0];
    let chosen = flag(values, "all")
      ? inboxes
      : list(values, "inbox").map((ref) =>
          pick(inboxes, ref, "inbox", "usual-mail inbox list", (inbox) => [inbox.name, inbox.address]),
        );
    if (!name || !chosen.length) {
      needTerminal(ctx, "the agent's name and --inbox (or --all), as in `usual-mail agent add \"My agent\" --inbox Acme`");
      const prompter = ctx.prompter();
      try {
        name ??= await askText(prompter, "The agent's name (shown in the device list)");
        if (!chosen.length) {
          chosen = await chooseMany(
            prompter,
            (line) => ctx.stdout.write(line),
            "Which inboxes may it see?",
            inboxes.map((inbox) => ({ label: `${inbox.name} (${inbox.address})`, value: inbox })),
          );
        }
      } finally {
        prompter.close();
      }
    }
    chosen = [...new Map(chosen.map((inbox) => [inbox.id, inbox])).values()];
    const turnedOn = await giveAccess(client, chosen);
    const code = await client.call<PairingCode>("createPairingCode", {
      body: { kind: "agent", inboxIds: chosen.map((inbox) => inbox.id) },
    });
    const paired = await client.call<PairResult>("pair", { body: { code: code.code, name } });
    const connector = `${client.server}/mcp`;
    if (flag(values, "json")) {
      return printJson(ctx, { agent: paired.device, connector, token: paired.token, agentAccessTurnedOn: turnedOn.map((i) => i.id) });
    }
    say(ctx, `Added the agent "${paired.device.name}". It may see: ${chosen.map((inbox) => inbox.name).join(", ")}.`);
    if (turnedOn.length) say(ctx, `Turned on agent access for: ${turnedOn.map((inbox) => inbox.name).join(", ")}.`);
    say(ctx, "");
    say(ctx, "Give the agent these to connect. The token is shown only now:");
    say(ctx, `  Connector  ${connector}`);
    say(ctx, `  Token      ${paired.token}`);
    say(ctx, 'It sends the token as "Authorization: Bearer <token>".');
    if (isLoopback(client.server)) say(ctx, "That address works for agents on this machine.");
  },
};

/** Turns on agent access where it is off. Returns the inboxes it changed. */
async function giveAccess(client: Client, inboxes: Inbox[]): Promise<Inbox[]> {
  const changed: Inbox[] = [];
  for (const inbox of inboxes) {
    if (inbox.agentAccess) continue;
    changed.push(
      await client.call<Inbox>("updateInbox", {
        params: { id: inbox.id },
        body: { agentAccess: true },
        scene: { listCommand: "usual-mail inbox list" },
      }),
    );
  }
  return changed;
}

export const agentList: Command = {
  name: "agent list",
  summary: "list agents and the inboxes each may see",
  usage: "usual-mail agent list [--json]",
  details: `
--json   print the agents as the server gives them

An agent sees an inbox only while the inbox's agent access is on; an inbox where it is off is marked.`,
  options: { json: { type: "boolean" } },
  maxPositionals: 0,
  async run(ctx, { values }) {
    const client = clientFor(ctx);
    const agents = (await client.call<Device[]>("listDevices")).filter((device) => device.kind === "agent");
    if (flag(values, "json")) return printJson(ctx, agents);
    if (!agents.length) return say(ctx, "No agents yet. `usual-mail agent add` adds one.");
    const inboxes = new Map((await client.call<Inbox[]>("listInboxes")).map((inbox) => [inbox.id, inbox]));
    const names = (ids: string[] | undefined) =>
      (ids ?? [])
        .map((id) => {
          const inbox = inboxes.get(id);
          if (!inbox) return `${id} (removed)`;
          return inbox.agentAccess ? inbox.name : `${inbox.name} (agent access off)`;
        })
        .join(", ") || "none";
    const rows = agents.map((agent) => [
      agent.name,
      names(agent.inboxIds),
      agent.lastSeenAt ? utc(agent.lastSeenAt) : "never",
      agent.id,
    ]);
    ctx.stdout.write(table(["NAME", "INBOXES", "LAST SEEN", "ID"], rows));
  },
};

export const agentRemove: Command = {
  name: "agent remove",
  summary: "end an agent's access",
  usage: "usual-mail agent remove <agent> [--access-off | --keep-access] [--json]",
  details: `
<agent>         the agent's id or name, as \`usual-mail agent list\` shows them
--access-off    also turn agent access off for its inboxes that no other agent uses, without asking
--keep-access   leave agent access as it is, without asking
--json          print the agent removed and the inboxes whose agent access was turned off

Its token stops working at once. \`usual-mail agent add\` turned on agent access for the inboxes it gave; when no
other agent uses one of them, this offers to turn it off again. Without a terminal, or with --json, pass
--access-off or --keep-access when there are such inboxes; nothing is asked.`,
  options: { "access-off": { type: "boolean" }, "keep-access": { type: "boolean" }, json: { type: "boolean" } },
  maxPositionals: 1,
  async run(ctx, { values, positionals }) {
    const ref = positionals[0];
    if (!ref) throw new UsageError("`usual-mail agent remove` needs the agent: its id or name. `usual-mail agent list` shows them.");
    if (flag(values, "access-off") && flag(values, "keep-access")) {
      throw new UsageError("Pass --access-off or --keep-access, not both.");
    }
    const client = clientFor(ctx);
    const devices = await client.call<Device[]>("listDevices");
    const agent = pick(
      devices.filter((device) => device.kind === "agent"),
      ref,
      "agent",
      "usual-mail agent list",
      (device) => [device.name],
    );
    const lonely = await onlyThisAgent(client, agent, devices);
    let turnOff = flag(values, "access-off");
    if (lonely.length && !turnOff && !flag(values, "keep-access")) {
      needTerminal(ctx, "--access-off to turn agent access off for its inboxes no other agent uses, or --keep-access");
      const prompter = ctx.prompter();
      try {
        say(ctx, `No other agent uses ${names(lonely)}, and agent access is on for ${lonely.length === 1 ? "it" : "them"}.`);
        turnOff = await confirm(prompter, `Turn agent access off for ${lonely.length === 1 ? "it" : "them"} too?`, true);
      } finally {
        prompter.close();
      }
    }
    await client.call("revokeDevice", { params: { id: agent.id }, scene: { listCommand: "usual-mail agent list" } });
    const turnedOff: Inbox[] = [];
    if (turnOff) {
      for (const inbox of lonely) {
        turnedOff.push(
          await client.call<Inbox>("updateInbox", {
            params: { id: inbox.id },
            body: { agentAccess: false },
            scene: { listCommand: "usual-mail inbox list" },
          }),
        );
      }
    }
    if (flag(values, "json")) {
      return printJson(ctx, { agent: { id: agent.id, name: agent.name }, agentAccessTurnedOff: turnedOff.map((inbox) => inbox.id) });
    }
    say(ctx, `Removed the agent "${agent.name}". Its token no longer works.`);
    if (turnedOff.length) say(ctx, `Turned off agent access for: ${names(turnedOff)}.`);
    else if (lonely.length) say(ctx, `Agent access stays on for: ${names(lonely)}. A new agent given ${lonely.length === 1 ? "it" : "them"} can read ${lonely.length === 1 ? "it" : "them"} at once.`);
  },
};

const names = (inboxes: Inbox[]) => inboxes.map((inbox) => inbox.name).join(", ");

/** The agent's inboxes whose agent access is on and that no other agent was given. */
async function onlyThisAgent(client: Client, agent: Device, devices: Device[]): Promise<Inbox[]> {
  const ids = new Set(agent.inboxIds ?? []);
  if (!ids.size) return [];
  const others = new Set(
    devices.filter((device) => device.kind === "agent" && device.id !== agent.id).flatMap((device) => device.inboxIds ?? []),
  );
  const inboxes = await client.call<Inbox[]>("listInboxes");
  return inboxes.filter((inbox) => ids.has(inbox.id) && inbox.agentAccess && !others.has(inbox.id));
}
