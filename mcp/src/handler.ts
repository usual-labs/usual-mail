/**
 * The connector as a standard request handler: MCP's Streamable HTTP transport at `basePath`, signed in with an
 * agent's bearer token. It serves protocol revision 2026-07-28 statelessly and, through the SDK's fallback,
 * 2025-era clients that open with `initialize`, one request at a time with no sessions.
 */
import { createMcpHandler, originValidationResponse, type AuthInfo } from "@modelcontextprotocol/server";
import type { Caller, FetchHandler, InterfaceDeps } from "@usualmail/core";
import { buildServer } from "./server.ts";

const MAX_BODY_BYTES = 1_048_576;

/** A JSON-RPC error with no id, the shape the transport uses for errors outside a request. */
function httpError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const CHALLENGE = 'Bearer realm="usual-mail"';

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer[ ]+([^\s]+)\s*$/i);
  return match?.[1];
}

function callerFrom(authInfo: AuthInfo | undefined): Caller {
  const caller = authInfo?.extra?.["caller"] as Caller | undefined;
  if (!caller) throw new Error("The connector built a server without a caller.");
  return caller;
}

/** The connector. Mount it so that requests to `basePath` reach it with their full URL. */
export function createMcp(deps: InterfaceDeps): FetchHandler {
  const endpoint = deps.basePath === "" ? "/" : deps.basePath;
  const mcp = createMcpHandler(({ authInfo }) => buildServer(deps.service, callerFrom(authInfo)), {
    maxRequestBodySize: MAX_BODY_BYTES,
  });

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== endpoint && url.pathname !== `${endpoint.replace(/\/$/, "")}/`) {
      return httpError(404, -32601, "Not found. The Usual Mail connector answers at its endpoint only.");
    }

    // Browsers send Origin; agents and chat apps' servers don't. A page on another site may not use this.
    const rejected = originValidationResponse(request, [url.hostname]);
    if (rejected) return rejected;

    const token = bearerToken(request);
    if (!token) {
      return httpError(
        401,
        -32001,
        "Sign-in needed: send this agent's token as Authorization: Bearer <token>. A person creates an agent token in Usual Mail.",
        { "www-authenticate": CHALLENGE },
      );
    }
    let caller: Caller | null;
    try {
      caller = await deps.authenticate(token);
    } catch {
      return httpError(500, -32603, "Usual Mail couldn't check the token. Try again later.");
    }
    if (!caller) {
      return httpError(401, -32001, "This token is unknown or was revoked. A person can give this agent a new one.", {
        "www-authenticate": `${CHALLENGE}, error="invalid_token"`,
      });
    }
    if (caller.actor.kind !== "agent") {
      return httpError(
        403,
        -32003,
        "This is a person's token. The connector is for agents, so that what they do is shown as theirs and the " +
          "inbox's trust applies. Give the agent its own token: in Usual Mail, add an agent and choose its inboxes.",
      );
    }

    const authInfo: AuthInfo = { token, clientId: caller.actor.agentId, scopes: [], extra: { caller } };
    return mcp.fetch(request, { authInfo });
  };
}
