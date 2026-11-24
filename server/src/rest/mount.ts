// Interfaces the server mounts beside the REST routes: each gets the service and the server's own
// `authenticate`, and every request under its base path, unchanged. The REST routes always come first.

import type { Hono } from "hono";
import { checkInterfaces, type MountedInterface } from "../parts.ts";
import type { MailServer } from "../service/server.ts";

/** Paths that stay with REST even when an interface is mounted at the root, so they keep REST's errors. */
function isRest(path: string): boolean {
  return path === "/healthz" || path === "/v1" || path.startsWith("/v1/");
}

// Hono's generic environment differs per app; the mount needs none of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountInterfaces(app: Hono<any>, server: MailServer, interfaces: readonly MountedInterface[]): void {
  checkInterfaces(interfaces);
  // Longer base paths first, so "/mcp" is tried before the root.
  const ordered = [...interfaces].sort((a, b) => b.basePath.length - a.basePath.length);
  for (const part of ordered) {
    const handler = part.create({
      service: server,
      authenticate: (token) => server.authenticate(token),
      basePath: part.basePath,
    });
    if (part.basePath === "") {
      app.all("*", async (c, next) => {
        if (isRest(c.req.path)) return next();
        return handler(c.req.raw);
      });
    } else {
      app.all(part.basePath, (c) => handler(c.req.raw));
      app.all(`${part.basePath}/*`, (c) => handler(c.req.raw));
    }
  }
}
