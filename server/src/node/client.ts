// Who sent the request the Node server is answering (`Host.clientAddress`): the connection's own address, or, when that
// is a reverse proxy named in USUAL_MAIL_TRUSTED_PROXIES, the client its X-Forwarded-For names (client-address.ts).
// Without that setting X-Forwarded-For is ignored, so a client can't pick the address its wrong passwords count against.
// Kept for each request's whole run, the REST routes and every interface mounted beside them alike.

import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import { forwardedClient, type AddressRange } from "../client-address.ts";

const current = new AsyncLocalStorage<string | null>();

/** The client address of the request being answered, or null outside one. */
export function requestClient(): string | null {
  return current.getStore() ?? null;
}

/** Node's request handler, as `serve` calls it: the request, and the connection it came on. */
type NodeFetch<E> = (request: Request, env: E) => Response | Promise<Response>;

/** `fetch`, run with each request's client address known (`requestClient`). */
export function withRequestClient<E extends { incoming?: Pick<IncomingMessage, "socket"> }>(
  trusted: readonly AddressRange[],
  fetch: NodeFetch<E>,
): NodeFetch<E> {
  return (request, env) => {
    const peer = env?.incoming?.socket?.remoteAddress ?? null;
    return current.run(forwardedClient(peer, request.headers.get("x-forwarded-for"), trusted), () => fetch(request, env));
  };
}
