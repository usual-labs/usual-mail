// The one place where the Node server is joined to its parts: the mail providers it can connect, and the
// interfaces it mounts beside the REST routes.
//
// A provider package exports a core `ProviderFactory`; add it under its kind:
//   providers: { imap: imapProvider, gmail: gmailProvider }
// An interface package exports a function that takes `InterfaceDeps` and returns a `FetchHandler`; add it with
// its base path ("" for the root, "/mcp" and the like otherwise, never under /v1 or /healthz).
// The server hands each interface its own `MailService` and `authenticate`, and passes it every request under
// its base path unchanged. Each package is added to package.json as "file:../<folder>".
//
// Joined: the IMAP and Gmail providers from `mail/`, the connector at /mcp and the dashboard at the root.

import { createDashboard } from "@usualmail/dashboard";
import { providers } from "@usualmail/mail";
import { createMcp } from "@usualmail/mcp";
import type { Parts } from "../parts.ts";

export const parts: Parts = {
  providers: {
    imap: (credentials, options) => providers.imap(credentials, options),
    gmail: (credentials, options) => providers.gmail(credentials, options),
  },
  interfaces: [
    { basePath: "/mcp", create: createMcp },
    { basePath: "", create: (deps) => createDashboard(deps) },
  ],
};
