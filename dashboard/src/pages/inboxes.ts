// The Inboxes section: every inbox with its hat and state, one inbox's settings, and removing one.
import type { Device, Inbox } from "@usualmail/core";
import { html, type Html } from "../html.ts";
import { alert, href, icon, notice, page, pageHead, postForm, type View } from "../view/layout.ts";
import { checkbox, colourPicker, hatLabel, textArea, textField, trustChoices } from "../view/parts.ts";
import { hatFor } from "../hats.ts";
import { fullTime, PROVIDER_NAMES, statusName, TRUST } from "../view/words.ts";
import { DEFAULT_CREDENTIAL_VALUES, gmailFields, imapFields, type CredentialValues, type FieldErrors } from "./connect.ts";
import { googleReconnectForm } from "./google.ts";
import { placeSection } from "./inbox-ai.ts";

const inboxPath = (inbox: Inbox, rest = "") => `/inboxes/${encodeURIComponent(inbox.id)}${rest}`;

/** Status, trust and agent access, as a short list of facts. */
export function inboxFacts(view: View, inbox: Inbox): Html {
  const statusClass = inbox.status === "needs_attention" ? "status-attention" : inbox.status === "ok" ? "status-ok" : "";
  return html`<dl class="facts">
<div><dt>Status</dt><dd class="${statusClass}">${statusName(inbox)}</dd></div>
<div><dt>Trust</dt><dd>${icon(view, TRUST[inbox.trust].icon)}${TRUST[inbox.trust].label}</dd></div>
<div><dt>Agents</dt><dd>${inbox.agentAccess ? "May read it" : "Can't read it"}</dd></div>
<div><dt>Last sync</dt><dd>${inbox.lastSyncedAt ? fullTime(inbox.lastSyncedAt) : "Not yet"}</dd></div>
</dl>`;
}

/** Why an inbox needs attention, in the hat's attention style. */
export function statusDetail(inbox: Inbox): Html | "" {
  if (inbox.status !== "needs_attention" && !(inbox.statusDetail && inbox.status !== "ok")) return "";
  return html`<p class="hat-attention">${inbox.statusDetail || "Something is wrong with this inbox."}</p>`;
}

export function inboxListPage(view: View, inboxes: Inbox[], o: { done?: string; error?: string } = {}): Html {
  const items = inboxes.map(
    (inbox) => html`<li class="card inbox">
<div class="inbox-head"><h2><a href="${href(view, inboxPath(inbox))}">${hatLabel(inbox, "large")}</a></h2><span class="meta">${inbox.address} · ${PROVIDER_NAMES[inbox.provider] ?? inbox.provider}</span></div>
${statusDetail(inbox)}
${inboxFacts(view, inbox)}
<div class="actions"><a class="button" href="${href(view, inboxPath(inbox))}">${icon(view, "settings")}Settings<span class="visually-hidden"> for ${inbox.name}</span></a><a class="button" href="${href(view, inboxPath(inbox, "/rules"))}">${icon(view, "rule")}Rules<span class="visually-hidden"> for ${inbox.name}</span></a></div>
</li>`,
  );
  return page(view, {
    title: "Inboxes",
    section: "inboxes",
    signedIn: true,
    body: html`${pageHead(view, {
      title: "Inboxes",
      lede: "Each inbox wears its company's hat. Choose how much rules and agents may do in each.",
    })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
<div class="actions"><a class="button primary large" href="${href(view, "/inboxes/new")}">${icon(view, "compose")}Connect an inbox</a></div>
${inboxes.length
  ? html`<ul class="list">${items}</ul>`
  : html`<p class="empty">No inboxes yet. Connect one to start.</p>`}`,
  });
}

export interface InboxPageOptions {
  done?: string;
  error?: string;
  /** Values the person typed, kept when saving failed. */
  values?: { name?: string; color?: string; guide?: string };
  /** The connection form sent back: what was typed (never a secret) and what went wrong. Opens the form. */
  reconnect?: { values: CredentialValues; errors: FieldErrors; error?: string };
}

/**
 * The form's starting values from what the server stored of the connection (`Inbox.connection`), so the person
 * types only the secrets and whatever changed. The address is filled in only when the login differs from it.
 */
export function connectionValues(inbox: Inbox): CredentialValues {
  const c = inbox.connection;
  if (c.kind === "gmail") return { ...DEFAULT_CREDENTIAL_VALUES, clientId: c.clientId };
  return {
    ...DEFAULT_CREDENTIAL_VALUES,
    imapHost: c.imap.host,
    imapPort: c.imap.port ? String(c.imap.port) : DEFAULT_CREDENTIAL_VALUES.imapPort,
    imapSecure: c.imap.secure,
    imapUser: c.imap.user || inbox.address,
    smtpHost: c.smtp.host,
    smtpPort: c.smtp.port ? String(c.smtp.port) : DEFAULT_CREDENTIAL_VALUES.smtpPort,
    smtpSecure: c.smtp.secure,
    smtpUser: c.smtp.user && c.smtp.user !== c.imap.user ? c.smtp.user : "",
    address: c.imap.user && c.imap.user.toLowerCase() !== inbox.address ? inbox.address : "",
    saveSent: c.saveSent,
  };
}

/** What the server stored of the connection, as facts. Never a secret: the server never has one to show. */
function connectionFacts(inbox: Inbox): Html {
  const c = inbox.connection;
  if (c.kind === "gmail" && c.signIn === "google") {
    return html`<dl class="facts"><div><dt>Gmail</dt><dd>Signed in with Google, through the client ${c.clientId}</dd></div></dl>`;
  }
  if (c.kind === "gmail") return html`<dl class="facts"><div><dt>Google client ID</dt><dd>${c.clientId || "Not known"}</dd></div></dl>`;
  const server = (login: typeof c.imap) =>
    login.host ? `${login.host}:${login.port}, ${login.secure ? "TLS" : "STARTTLS"}, as ${login.user}` : "Not known";
  return html`<dl class="facts">
<div><dt>Incoming (IMAP)</dt><dd>${server(c.imap)}</dd></div>
<div><dt>Outgoing (SMTP)</dt><dd>${server(c.smtp)}</dd></div>
<div><dt>Sent mail</dt><dd>${c.saveSent ? "A copy is saved in Sent" : "No copy is saved (the server does it)"}</dd></div>
</dl>`;
}

/**
 * Changing a connected inbox's password or other details, in place: rules and history stay. The form starts
 * with what the server stored, so only the secrets need typing. New details replace the stored ones whole, so
 * everything is sent again. The server checks them with the provider before it keeps them. A disclosure, so it
 * works without scripts; it is open when the inbox needs attention or the form came back with a problem.
 */
function connectionSection(view: View, inbox: Inbox, o: InboxPageOptions["reconnect"], google: boolean): Html {
  const values: CredentialValues = o?.values ?? connectionValues(inbox);
  const errors = o?.errors ?? {};
  const open = Boolean(o) || inbox.status === "needs_attention";
  const fields =
    inbox.provider === "imap"
      ? imapFields(values, errors, {
          idPrefix: "new-",
          addressHint: "This inbox's address. The new details must be for the same mailbox.",
        })
      : gmailFields(values, errors, { idPrefix: "new-" });
  return html`<section class="card" aria-labelledby="connection-title">
<h2 id="connection-title">Connection</h2>
${connectionFacts(inbox)}
${google && inbox.provider === "gmail" ? googleReconnectForm(view, inbox) : ""}
<p class="note">${PROVIDER_NAMES[inbox.provider] ?? inbox.provider}. The server keeps the password${inbox.provider === "gmail" ? ", client secret and refresh token" : ""} sealed and never shows ${inbox.provider === "gmail" ? "them" : "it"}. If ${inbox.provider === "gmail" ? "they" : "it"} changed at the provider, give the new ${inbox.provider === "gmail" ? "ones" : "one"} here, and change any detail that changed: the form starts with what the server stored, and the inbox keeps its rules and history. The server checks everything with the provider first, and nothing changes if the provider refuses it.</p>
<details class="reconnect"${open ? html` open` : ""}><summary class="button">${inbox.provider === "gmail" ? "Give a new client secret and token" : "Give a new password"}…</summary>
<div class="reconnect-body">
${o?.error ? alert(view, "error", o.error) : ""}
${postForm(
  view,
  `/inboxes/${encodeURIComponent(inbox.id)}/reconnect`,
  html`${fields}
<div class="actions"><button class="button primary" type="submit">Check and save</button></div>`,
  "form",
)}
</div>
</details>
</section>`;
}

/** What one inbox's page needs beyond the inbox: who may read it, how many inboxes there are, and Google sign-in. */
export interface InboxPageData {
  agents: Device[];
  /** How many inboxes there are, for the places to choose from. */
  total: number;
  /** Whether the server can connect Gmail by signing in with Google. */
  google?: boolean;
}

export function inboxPage(view: View, inbox: Inbox, data: InboxPageData, o: InboxPageOptions = {}): Html {
  const { agents } = data;
  const paused = inbox.status === "paused";
  const values = o.values ?? {};
  const agentNames = agents.map((agent) => agent.name).join(", ");
  return page(view, {
    title: inbox.name,
    section: "inboxes",
    signedIn: true,
    hat: hatFor(inbox.color).name,
    body: html`${pageHead(view, {
      title: hatLabel(inbox, "large"),
      back: { path: "/inboxes", label: "Inboxes" },
      lede: html`${inbox.address} · ${PROVIDER_NAMES[inbox.provider] ?? inbox.provider}`,
    })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
${inbox.status === "needs_attention"
  ? alert(
      view,
      "attention",
      html`<p>${inbox.statusDetail || "Something is wrong with this inbox."}</p><p class="meta">Sync now tries again. If the password or other details changed, give the new ones under Connection below; the inbox keeps its rules and history.</p>`,
    )
  : ""}
<section class="card" aria-labelledby="state-title">
<h2 id="state-title">State</h2>
${inboxFacts(view, inbox)}
<div class="actions">
${postForm(view, inboxPath(inbox, "/sync"), html`<button class="button" type="submit"${paused ? html` disabled` : ""}>${icon(view, "down")}Sync now</button>`, "inline-form")}
${postForm(
  view,
  inboxPath(inbox, "/pause"),
  html`<input type="hidden" name="paused" value="${paused ? "no" : "yes"}"><button class="button" type="submit">${paused ? "Resume" : "Pause"}</button>`,
  "inline-form",
)}
<a class="button" href="${href(view, inboxPath(inbox, "/rules"))}">${icon(view, "rule")}Rules</a>
</div>
<p class="note">${paused ? "Paused: nothing syncs and nothing is written back until you resume." : "Pause stops syncing and writing back until you resume."}</p>
</section>
${connectionSection(view, inbox, o.reconnect, data.google === true)}
${postForm(
  view,
  inboxPath(inbox, "/name"),
  html`<h2>Name and colour</h2>
${textField({ id: "inbox-name", name: "name", label: "Name", value: values.name ?? inbox.name, required: true, maxlength: 80 })}
${colourPicker("inbox-color", values.color ?? inbox.color)}
<div class="actions"><button class="button primary" type="submit">Save name and colour</button></div>`,
  "card form",
)}
${placeSection(view, inbox, data.total)}
${postForm(
  view,
  inboxPath(inbox, "/trust"),
  html`<h2>What rules and agents may do</h2>
${trustChoices(view, "inbox-trust", inbox.trust)}
<p class="hint">A change applies from now on. What was done before stays as it was recorded.</p>
<div class="actions"><button class="button primary" type="submit">Save trust</button></div>`,
  "card form",
)}
${postForm(
  view,
  inboxPath(inbox, "/agents"),
  html`<h2>Agents</h2>
<input type="hidden" name="agentAccess" value="off">
${checkbox({ id: "agent-access", name: "agentAccess", label: "Agents may read this inbox", checked: inbox.agentAccess })}
<p class="hint">An agent also needs this inbox in its pairing. ${agents.length
    ? html`Agents paired with it: ${agentNames}.`
    : html`No agent is paired with it. <a href="${href(view, "/devices")}">Connect an agent</a>.`}</p>
<div class="actions"><button class="button primary" type="submit">Save agent access</button></div>`,
  "card form",
)}
${postForm(
  view,
  inboxPath(inbox, "/guide"),
  html`<h2>Guide</h2>
${textArea({
  id: "inbox-guide",
  name: "guide",
  label: "How to handle this inbox",
  value: values.guide ?? inbox.guide,
  hint: "Plain notes that you and your agents read and edit, such as who matters and what can wait. Markdown is fine.",
  rows: 8,
  maxlength: 20000,
})}
<div class="actions"><button class="button primary" type="submit">Save guide</button></div>`,
  "card form",
)}
<section class="card" aria-labelledby="remove-title">
<h2 id="remove-title">Remove</h2>
<p class="note">Removing an inbox makes this server forget it. Nothing changes at the provider. You'll be asked to confirm.</p>
<div class="actions"><a class="button danger" href="${href(view, inboxPath(inbox, "/remove"))}">${icon(view, "trash")}Remove this inbox</a></div>
</section>`,
  });
}

export function removeInboxPage(view: View, inbox: Inbox, error?: string): Html {
  return page(view, {
    title: `Remove ${inbox.name}`,
    section: "inboxes",
    signedIn: true,
    hat: hatFor(inbox.color).name,
    narrow: true,
    body: html`${pageHead(view, {
      title: html`Remove ${inbox.name}?`,
      back: { path: inboxPath(inbox), label: inbox.name },
    })}
${error ? alert(view, "error", error) : ""}
<div class="card prose">
<p>This server deletes everything it holds for ${inbox.address}: its copy of the mail, its rules, its history in Handled, its drafts and its guide.</p>
<p>Agents lose access to it, and briefs no longer show its section.</p>
<p>Nothing changes at the provider: your mail stays where it is, and the labels or folders Usual Mail made there (under “Usual Mail/”) stay too.</p>
<p><strong>This can't be undone.</strong> To use the inbox again, you connect it again and it starts over.</p>
${postForm(
  view,
  inboxPath(inbox, "/remove"),
  html`<div class="actions"><button class="button danger large" type="submit">${icon(view, "trash")}Remove ${inbox.name}</button><a class="button large" href="${href(view, inboxPath(inbox))}">Keep it</a></div>`,
)}
</div>`,
  });
}
