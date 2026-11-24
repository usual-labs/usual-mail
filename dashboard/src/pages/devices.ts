// Devices and agents: what holds a token for this server, pairing codes for a new app or agent, and removing one.
import type { Device, Inbox, PairingCode } from "@usualmail/core";
import { html, type Html } from "../html.ts";
import { alert, href, icon, notice, ownerCodeWhere, page, pageHead, postForm, type View } from "../view/layout.ts";
import { checkbox, confirmStep, hatLabel } from "../view/parts.ts";
import { clockTime, fullTime } from "../view/words.ts";

/** `lastPerson` is true when this is the only app or browser paired: removing it makes the server a new owner's code. */
function deviceCard(view: View, device: Device, inboxes: Map<string, Inbox>, ownId: string, lastPerson: boolean): Html {
  const own = device.id === ownId;
  const isAgent = device.kind === "agent";
  const given = (device.inboxIds ?? []).map((id) => inboxes.get(id)).filter((inbox): inbox is Inbox => Boolean(inbox));
  const blocked = given.filter((inbox) => !inbox.agentAccess);
  return html`<li class="card">
<p class="device-name">${icon(view, isAgent ? "agent" : "person")}${device.name}${own ? html` <span class="badge">This browser</span>` : ""}</p>
<p class="meta">${isAgent ? "Agent" : "App"} · paired ${fullTime(device.createdAt)}${device.lastSeenAt ? html` · last seen ${fullTime(device.lastSeenAt)}` : ""}</p>
${isAgent
  ? html`<div class="chips">${given.length ? given.map((inbox) => hatLabel(inbox, "small")) : html`<span class="meta">No inboxes</span>`}</div>
${blocked.length
  ? html`<p class="hint">Agent access is off for ${blocked.map((inbox) => inbox.name).join(", ")}, so it can't read ${blocked.length === 1 ? "that inbox" : "those inboxes"} yet.</p>`
  : ""}`
  : ""}
${confirmStep(view, {
  open: own ? "Sign out and remove…" : "Remove…",
  explain: lastPerson
    ? `${own ? "This browser's token stops working at once and you are signed out." : "Its token stops working at once."} No app or browser will be left paired, so the server makes a new owner's code at once: it ${ownerCodeWhere(view)}. Sign in with that code.`
    : own
      ? "This browser's token stops working at once and you are signed out. To use it again, sign in with a new code."
      : `Its token stops working at once. To use ${isAgent ? "this agent" : "this app"} again, pair it with a new code.`,
  action: `/devices/${encodeURIComponent(device.id)}/revoke`,
  confirm: own ? "Sign out and remove" : `Remove ${device.name}`,
})}
</li>`;
}

export function devicesPage(
  view: View,
  devices: Device[],
  inboxes: Inbox[],
  ownId: string,
  o: { done?: string; error?: string; chosen?: string[] } = {},
): Html {
  const byId = new Map(inboxes.map((inbox) => [inbox.id, inbox]));
  const apps = devices.filter((device) => device.kind === "person");
  const agents = devices.filter((device) => device.kind === "agent");
  const chosen = new Set(o.chosen ?? []);
  return page(view, {
    title: "Devices and agents",
    section: "devices",
    signedIn: true,
    body: html`${pageHead(view, {
      title: "Devices and agents",
      lede: "Everything that can reach your mail on this server. Each holds its own token; removing one ends it at once.",
    })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
<section class="block" aria-labelledby="apps-title"><h2 id="apps-title">Apps and browsers</h2>
${apps.length ? html`<ul class="list">${apps.map((device) => deviceCard(view, device, byId, ownId, apps.length === 1))}</ul>` : html`<p class="empty">None.</p>`}
${postForm(
  view,
  "/devices/pair-app",
  html`<h2>Pair an app</h2><p class="note">Make a code, then type it into the Usual Mail app on your Mac or iPhone, or on this dashboard's sign-in page in another browser.</p><div class="actions"><button class="button primary" type="submit">Make a code for an app</button></div>`,
  "card form",
)}
</section>
<section class="block" aria-labelledby="agents-title"><h2 id="agents-title">Agents</h2>
${agents.length ? html`<ul class="list">${agents.map((device) => deviceCard(view, device, byId, ownId, false))}</ul>` : html`<p class="empty">No agents yet.</p>`}
${postForm(
  view,
  "/devices/pair-agent",
  html`<h2>Connect an agent</h2>
<p class="note">An agent sees only the inboxes you give it here, and only while their agent access is on. It can propose and act under each inbox's trust; it can't connect or remove inboxes, change settings other than the guide, approve its own proposals or send mail.</p>
${inboxes.length
  ? html`<fieldset><legend>Inboxes it may see</legend>${inboxes.map((inbox, index) =>
      checkbox({
        id: `agent-inbox-${index}`,
        name: "inboxIds",
        value: inbox.id,
        checked: chosen.has(inbox.id),
        label: html`${hatLabel(inbox)}${inbox.agentAccess ? "" : html` <span class="meta">(agent access is off)</span>`}`,
      }),
    )}</fieldset>
<div class="actions"><button class="button primary" type="submit">Make a code for an agent</button></div>`
  : html`<p class="empty">Connect an inbox first.</p>`}`,
  "card form",
)}
</section>`,
  });
}

export function pairingCodePage(view: View, code: PairingCode, kind: "person" | "agent", inboxes: Inbox[]): Html {
  const forAgent = kind === "agent";
  const blocked = inboxes.filter((inbox) => !inbox.agentAccess);
  return page(view, {
    title: "Pairing code",
    section: "devices",
    signedIn: true,
    narrow: true,
    body: html`${pageHead(view, {
      title: forAgent ? "A code for your agent" : "A code for your app",
      back: { path: "/devices", label: "Devices and agents" },
    })}
<div class="card">
<p class="code">${code.code}</p>
<p>${forAgent ? "Give it to the agent you are connecting." : "Type it into the app, or on the sign-in page of another browser."} It works once and expires at ${clockTime(code.expiresAt)}.</p>
${forAgent
  ? html`<p>It will see ${inboxes.map((inbox, i) => html`${i ? (i === inboxes.length - 1 ? " and " : ", ") : ""}${hatLabel(inbox)}`)}.</p>
${blocked.length ? alert(view, "attention", html`Agent access is off for ${blocked.map((inbox) => inbox.name).join(", ")}. Turn it on in the inbox's settings, or the agent can't read it.`) : ""}`
  : ""}
<p class="meta">This page shows the code once. Leave it and it isn't shown again; make a new one if you need it.</p>
</div>
<div class="actions"><a class="button large" href="${href(view, "/devices")}">Done</a></div>`,
  });
}
