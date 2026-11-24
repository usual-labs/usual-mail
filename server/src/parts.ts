// The shape of the parts a host joins to the server: mail providers by kind, and interfaces (the dashboard,
// the chat connector) mounted under a base path. `src/node/parts.ts` is the one list the Node server uses.

import type { FetchHandler, InterfaceDeps, ProviderFactory, ProviderKind } from "@usualmail/core";
import { ProviderRegistry } from "./providers.ts";

/** An interface the server mounts: its base path and the function its package exports. */
export interface MountedInterface {
  /** Where it is mounted, for example "/mcp", or "" for the root. No trailing slash. */
  basePath: string;
  create: (deps: InterfaceDeps) => FetchHandler;
}

export interface Parts {
  providers: Partial<Record<ProviderKind, ProviderFactory>>;
  interfaces: MountedInterface[];
}

/** Paths the REST surface owns. An interface may not be mounted on or under them. */
const RESERVED = ["/v1", "/healthz"];

/** Throws with a readable message when two interfaces share a base path or one sits on a REST path. */
export function checkInterfaces(interfaces: readonly MountedInterface[]): void {
  const seen = new Set<string>();
  for (const { basePath } of interfaces) {
    if (basePath !== "" && !/^(\/[A-Za-z0-9._~-]+)+$/.test(basePath)) {
      throw new Error(`An interface's base path is "" or like "/mcp", without a trailing slash, not "${basePath}"`);
    }
    if (RESERVED.some((path) => basePath === path || basePath.startsWith(`${path}/`))) {
      throw new Error(`${basePath} belongs to the REST routes, so no interface can be mounted there`);
    }
    if (seen.has(basePath)) throw new Error(`Two interfaces are mounted at "${basePath}"`);
    seen.add(basePath);
  }
}

/** A registry holding the providers the parts list. */
export function providerRegistry(parts: Pick<Parts, "providers">): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const [kind, factory] of Object.entries(parts.providers) as Array<[ProviderKind, ProviderFactory | undefined]>) {
    if (factory) registry.register(kind, factory);
  }
  return registry;
}
