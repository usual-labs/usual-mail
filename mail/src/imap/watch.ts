/**
 * Watching INBOX with IMAP IDLE on a connection of its own, so syncs and moves never interrupt it.
 * ImapFlow restarts IDLE every few minutes and falls back to polling with NOOP on servers without IDLE.
 * When the connection drops it comes back with growing pauses, and reports a change once it is back,
 * since mail may have arrived meanwhile. Only INBOX is watched; the server should still sync on a timer.
 */
import { ImapFlow } from "imapflow";
import type { ImapCredentials } from "@usualmail/core";
import { clientOptions, closeClient, readableError, type ConnectionTimeouts } from "./connection.ts";

const DEBOUNCE_MS = 250;
const IDLE_RESTART_MS = 4 * 60_000;
const MAX_BACKOFF_MS = 60_000;

export async function watchInbox(
  imap: ImapCredentials["imap"],
  timeouts: ConnectionTimeouts,
  onChange: () => void,
): Promise<() => Promise<void>> {
  let stopped = false;
  let client: ImapFlow | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  let failures = 0;

  const notify = () => {
    if (stopped) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (stopped) return;
      try {
        onChange();
      } catch {
        // The listener's own failure is not the watcher's to handle.
      }
    }, DEBOUNCE_MS);
  };

  const connect = async (): Promise<void> => {
    const next = new ImapFlow(
      clientOptions(imap, timeouts, {
        disableAutoIdle: false,
        autoIdleDelay: 500,
        maxIdleTime: IDLE_RESTART_MS,
        socketTimeout: Math.max(timeouts.socketMs, IDLE_RESTART_MS + 60_000),
      }),
    );
    next.on("error", () => {});
    next.on("exists", notify);
    next.on("expunge", notify);
    next.on("flags", notify);
    next.on("close", () => {
      // Only a connection that was up comes back by itself; a failed attempt is retried by its caller.
      if (client !== next) return;
      client = undefined;
      if (!stopped) reconnectLater();
    });
    try {
      await next.connect();
      await next.mailboxOpen("INBOX");
    } catch (error) {
      next.close();
      throw readableError(error, imap.host);
    }
    if (stopped) {
      await closeClient(next, timeouts.logoutMs);
      return;
    }
    client = next;
    failures = 0;
  };

  const reconnectLater = () => {
    if (stopped || retry) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures);
    failures++;
    retry = setTimeout(async () => {
      retry = undefined;
      if (stopped) return;
      try {
        await connect();
        notify();
      } catch {
        reconnectLater();
      }
    }, delay);
  };

  await connect();

  return async () => {
    stopped = true;
    clearTimeout(debounce);
    clearTimeout(retry);
    retry = undefined;
    const current = client;
    client = undefined;
    if (current) await closeClient(current, timeouts.logoutMs);
  };
}
