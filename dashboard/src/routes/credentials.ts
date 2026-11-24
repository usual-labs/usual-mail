// Reading a mailbox's connection details from a form, for connecting an inbox and for changing a connected
// inbox's credentials. Both take the same shape (docs/contract.md, "Inboxes"). Secrets are returned separately,
// so they can be kept out of anything shown again.
import type { GmailCredentials, ImapCredentials, ProviderKind } from "@usualmail/core";
import { text, texts, type Form } from "../http/context.ts";
import type { CredentialValues, FieldErrors } from "../pages/connect.ts";

const checked = (form: Form, name: string) => texts(form, name).includes("on");

function port(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 65535 ? n : null;
}

export interface ReadCredentials {
  /** What to show again: never a password, secret or token. */
  values: CredentialValues;
  errors: FieldErrors;
  /** Present when every field needed is there. */
  credentials?: ImapCredentials | GmailCredentials;
  /** Every secret typed, to scrub from messages before they are shown. */
  secrets: string[];
}

export function readCredentials(form: Form, provider: ProviderKind): ReadCredentials {
  const values: CredentialValues = {
    imapHost: text(form, "imapHost").trim(),
    imapPort: text(form, "imapPort").trim(),
    imapSecure: checked(form, "imapSecure"),
    imapUser: text(form, "imapUser").trim(),
    smtpHost: text(form, "smtpHost").trim(),
    smtpPort: text(form, "smtpPort").trim(),
    smtpSecure: checked(form, "smtpSecure"),
    smtpUser: text(form, "smtpUser").trim(),
    address: text(form, "address").trim(),
    saveSent: checked(form, "saveSent"),
    clientId: text(form, "clientId").trim(),
  };
  const imapPassword = text(form, "imapPassword");
  const smtpPassword = text(form, "smtpPassword");
  const clientSecret = text(form, "clientSecret").trim();
  const refreshToken = text(form, "refreshToken").trim();
  const secrets = [imapPassword, smtpPassword, clientSecret, refreshToken].filter((secret) => secret.length >= 4);

  const errors: FieldErrors = {};
  const need = (ok: boolean, field: string, message: string) => {
    if (!ok) errors[field] = message;
  };

  let credentials: ImapCredentials | GmailCredentials | undefined;
  if (provider === "imap") {
    const imapPort = port(values.imapPort);
    const smtpPort = port(values.smtpPort);
    need(values.imapHost.length > 0, "imapHost", "Type the IMAP server's name.");
    need(imapPort !== null, "imapPort", "The port is a number from 1 to 65535.");
    need(values.imapUser.length > 0, "imapUser", "Type the user name.");
    need(imapPassword.length > 0, "imapPassword", "Type the password.");
    need(values.smtpHost.length > 0, "smtpHost", "Type the SMTP server's name.");
    need(smtpPort !== null, "smtpPort", "The port is a number from 1 to 65535.");
    need(!values.address || /^[^\s@]+@[^\s@]+$/.test(values.address), "address", "This doesn't look like an email address.");
    if (imapPort !== null && smtpPort !== null) {
      credentials = {
        imap: { host: values.imapHost, port: imapPort, secure: values.imapSecure, user: values.imapUser, password: imapPassword },
        smtp: {
          host: values.smtpHost,
          port: smtpPort,
          secure: values.smtpSecure,
          user: values.smtpUser || values.imapUser,
          password: smtpPassword || imapPassword,
        },
        ...(values.address ? { address: values.address } : {}),
        saveSent: values.saveSent,
      };
    }
  } else {
    need(values.clientId.length > 0, "clientId", "Type the client ID.");
    need(clientSecret.length > 0, "clientSecret", "Type the client secret.");
    need(refreshToken.length > 0, "refreshToken", "Type the refresh token.");
    credentials = { clientId: values.clientId, clientSecret, refreshToken };
  }

  const complete = Object.keys(errors).length === 0;
  return { values, errors, secrets, ...(complete && credentials ? { credentials } : {}) };
}

/** Never let a secret the person typed come back in a message, whatever the provider said. */
export const scrub = (message: string, secrets: string[]) =>
  secrets.reduce((out, secret) => out.split(secret).join("•••"), message);
