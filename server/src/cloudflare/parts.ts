// The one place the Cloudflare server is joined to its parts, as src/node/parts.ts is for Node: Gmail only (no IMAP:
// it would need ImapFlow on Workers' sockets), through mail's `./gmail` entry so neither ImapFlow nor an SMTP client is
// bundled, with the limits for a 128 MB isolate (`GMAIL_SMALL_MEMORY`); the connector at /mcp and the dashboard at the
// root, as on Node.

import { createDashboard } from "@usualmail/dashboard";
import { createGate, createGmailProvider, GMAIL_SMALL_MEMORY, type GmailProviderOptions } from "@usualmail/mail/gmail";
import { createMcp } from "@usualmail/mcp";
import type { Parts } from "../parts.ts";
import { OWNER_CODE_WHERE_DASHBOARD } from "./owner-code.ts";

/** The Gmail provider's limits on Cloudflare: messages over 2 MiB come without their attachments' bytes, two at once. */
export const CLOUDFLARE_GMAIL: GmailProviderOptions = GMAIL_SMALL_MEMORY;

/**
 * The parts, made once per object instance. Every inbox syncs at once in the one object, so every Gmail provider shares
 * one gate of `messageConcurrency` turns: the bound on messages held in memory is the object's, not each inbox's. Made
 * here rather than at module scope, so a reset object never inherits turns its predecessor's work still held.
 */
export function cloudflareParts(gmail: GmailProviderOptions = CLOUDFLARE_GMAIL): Parts {
  const { messageConcurrency = GMAIL_SMALL_MEMORY.messageConcurrency, ...limits } = gmail;
  const gate = createGate(messageConcurrency);
  return {
    providers: {
      gmail: (credentials, options) => createGmailProvider(credentials, { ...options, ...limits, gate }),
    },
    interfaces: [
      { basePath: "/mcp", create: createMcp },
      // Its sign-in page says the owner's code waits in Data Studio, not in a log or a data folder.
      { basePath: "", create: (deps) => createDashboard(deps, { ownerCodeWhere: OWNER_CODE_WHERE_DASHBOARD }) },
    ],
  };
}
