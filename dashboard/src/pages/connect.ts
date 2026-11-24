// Connecting an inbox: IMAP with SMTP, or Gmail with the person's own Google client. One form per provider, so
// it works without scripts. Passwords and secrets are never written back into the page. The connection fields
// are shared with the form that changes a connected inbox's credentials (pages/inboxes.ts).
import type { ProviderKind, TrustLevel } from "@usualmail/core";
import { html, type Html } from "../html.ts";
import { alert, href, page, pageHead, postForm, type View } from "../view/layout.ts";
import { checkbox, colourPicker, hidden, textField, trustChoices } from "../view/parts.ts";
import { googleConnectCard } from "./google.ts";

export type ConnectProvider = ProviderKind;

/** The connection details the person typed, minus every password and secret. */
export interface CredentialValues {
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  imapUser: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  address: string;
  saveSent: boolean;
  clientId: string;
}

/** What the connect form sent, minus every password and secret. */
export interface ConnectValues extends CredentialValues {
  name: string;
  color: string;
  trust: TrustLevel;
}

export const DEFAULT_CREDENTIAL_VALUES: CredentialValues = {
  imapHost: "",
  imapPort: "993",
  imapSecure: true,
  imapUser: "",
  smtpHost: "",
  smtpPort: "465",
  smtpSecure: true,
  smtpUser: "",
  address: "",
  saveSent: true,
  clientId: "",
};

export const DEFAULT_CONNECT_VALUES: ConnectValues = { name: "", color: "", trust: "suggest", ...DEFAULT_CREDENTIAL_VALUES };

export type FieldErrors = Partial<Record<string, string>>;

/** How the connection fields differ between connecting an inbox and changing a connected one's credentials. */
export interface CredentialFieldOptions {
  /** Put before every id, so the fields can share a page with others. */
  idPrefix?: string;
  /** The hint under the mailbox address. */
  addressHint?: string;
}

function providerTabs(view: View, provider: ConnectProvider): Html {
  const tab = (key: ConnectProvider, label: string) =>
    html`<a class="chip-all" href="${href(view, `/inboxes/new?provider=${key}`)}"${key === provider ? html` aria-current="page"` : ""}>${label}</a>`;
  return html`<nav class="chips" aria-label="Kind of mailbox">${tab("imap", "IMAP and SMTP")}${tab("gmail", "Gmail")}</nav>`;
}

export function imapFields(v: CredentialValues, errors: FieldErrors, o: CredentialFieldOptions = {}): Html {
  const id = (name: string) => `${o.idPrefix ?? ""}${name}`;
  return html`<fieldset><legend>Incoming mail (IMAP)</legend>
<div class="row-fields">${textField({ id: id("imap-host"), name: "imapHost", label: "Server", value: v.imapHost, required: true, autocomplete: "off", placeholder: "imap.example.com", error: errors.imapHost })}${textField({ id: id("imap-port"), name: "imapPort", label: "Port", value: v.imapPort, required: true, inputmode: "numeric", className: "short", error: errors.imapPort })}</div>
${checkbox({ id: id("imap-secure"), name: "imapSecure", label: "Use TLS from the start (usually port 993)", checked: v.imapSecure })}
${textField({ id: id("imap-user"), name: "imapUser", label: "User name", value: v.imapUser, required: true, autocomplete: "username", error: errors.imapUser })}
${textField({ id: id("imap-password"), name: "imapPassword", label: "Password", type: "password", required: true, autocomplete: "current-password", hint: "An app password if your provider offers them. It is sent to the server once and stored encrypted; this page never shows it again.", error: errors.imapPassword })}
</fieldset>
<fieldset><legend>Outgoing mail (SMTP)</legend>
<div class="row-fields">${textField({ id: id("smtp-host"), name: "smtpHost", label: "Server", value: v.smtpHost, required: true, autocomplete: "off", placeholder: "smtp.example.com", error: errors.smtpHost })}${textField({ id: id("smtp-port"), name: "smtpPort", label: "Port", value: v.smtpPort, required: true, inputmode: "numeric", className: "short", error: errors.smtpPort })}</div>
${checkbox({ id: id("smtp-secure"), name: "smtpSecure", label: "Use TLS from the start (usually port 465; leave off for 587)", checked: v.smtpSecure })}
${textField({ id: id("smtp-user"), name: "smtpUser", label: "User name", value: v.smtpUser, autocomplete: "off", hint: "Leave empty to use the IMAP user name." })}
${textField({ id: id("smtp-password"), name: "smtpPassword", label: "Password", type: "password", autocomplete: "off", hint: "Leave empty to use the IMAP password." })}
</fieldset>
<fieldset><legend>Address</legend>
${textField({ id: id("address"), name: "address", label: "Mailbox address", type: "email", value: v.address, autocomplete: "off", hint: o.addressHint ?? "Only when it differs from the IMAP user name.", error: errors.address })}
${checkbox({ id: id("save-sent"), name: "saveSent", label: "Save a copy of sent mail in the Sent folder", checked: v.saveSent })}
<p class="hint">Turn this off if your mail server saves sent mail itself, or each message is kept twice.</p>
</fieldset>`;
}

export function gmailFields(v: CredentialValues, errors: FieldErrors, o: CredentialFieldOptions = {}): Html {
  const id = (name: string) => `${o.idPrefix ?? ""}${name}`;
  return html`<fieldset><legend>Your Google client</legend>
<p class="hint">Usual Mail talks to Gmail through an OAuth client you create in your own Google Cloud project, and a refresh token for this mailbox.</p>
${textField({ id: id("client-id"), name: "clientId", label: "Client ID", value: v.clientId, required: true, autocomplete: "off", error: errors.clientId })}
${textField({ id: id("client-secret"), name: "clientSecret", label: "Client secret", type: "password", required: true, autocomplete: "off", error: errors.clientSecret })}
${textField({ id: id("refresh-token"), name: "refreshToken", label: "Refresh token", type: "password", required: true, autocomplete: "off", hint: "Sent to the server once and stored encrypted; this page never shows the secret or the token again.", error: errors.refreshToken })}
</fieldset>`;
}

export function connectPage(
  view: View,
  provider: ConnectProvider,
  o: {
    values?: ConnectValues;
    error?: string;
    errors?: FieldErrors;
    /** Gmail on a server with Google sign-in: the choice to sign in, with what was typed into it. */
    google?: { name?: string; color?: string; error?: string };
  } = {},
): Html {
  const v = o.values ?? DEFAULT_CONNECT_VALUES;
  const errors = o.errors ?? {};
  return page(view, {
    title: "Connect an inbox",
    section: "inboxes",
    signedIn: true,
    body: html`${pageHead(view, {
      title: "Connect an inbox",
      back: { path: "/inboxes", label: "Inboxes" },
      lede: "Usual Mail works with the mailbox you already have. The server checks the connection before it keeps anything.",
    })}
${providerTabs(view, provider)}
${provider === "gmail" && o.google ? googleConnectCard(view, o.google) : ""}
${o.error ? alert(view, "error", o.error) : ""}
${postForm(
  view,
  "/inboxes",
  html`${hidden("provider", provider)}
<h2>${provider === "imap" ? "IMAP and SMTP" : "Gmail"}</h2>
${textField({ id: "name", name: "name", label: "Name", value: v.name, required: true, maxlength: 80, hint: "The company or person this inbox is for.", error: errors.name })}
${colourPicker("color", v.color || undefined)}
${errors.color ? html`<p class="field-error">${errors.color}</p>` : ""}
${provider === "imap" ? imapFields(v, errors) : gmailFields(v, errors)}
${trustChoices(view, "trust", v.trust)}
<p class="hint">Agents can't read a new inbox until you turn on agent access in its settings.</p>
<div class="actions"><button class="button primary large" type="submit">Connect</button><a class="button large" href="${href(view, "/inboxes")}">Cancel</a></div>`,
  "card form",
)}`,
  });
}
