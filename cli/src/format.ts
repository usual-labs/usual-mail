// Plain-text output: tables, times and the words for statuses.

import { FIRST_SYNC_FETCHING, firstSyncCount, type Inbox, type InboxStatus, type ProviderKind } from "@usualmail/core";

/** Columns padded to line up. The last column is never padded. */
export function table(header: string[], rows: string[][]): string {
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => visible(row[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell + " ".repeat(widths[i]! - visible(cell).length)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n") + "\n";
}

/** Text without terminal colour codes, for measuring. */
const visible = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** "2026-11-16 09:30 UTC". */
export function utc(iso: string | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "in 15 minutes", "in 2 hours", "in 3 days", or "now". */
export function fromNow(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 30_000) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hours`;
  return `in ${Math.round(hours / 24)} days`;
}

export const STATUS_WORDS: Record<InboxStatus, string> = {
  connecting: "connecting",
  ok: "ok",
  needs_attention: "needs attention",
  paused: "paused",
};

/**
 * The status, with the reason when something is wrong; while a first sync runs and nothing is wrong, how far it has
 * got, in core's words: "fetching your mail · 120 of 340".
 */
export function statusLine(inbox: Inbox): string {
  const fetching = firstSyncLine(inbox);
  if (fetching) return fetching;
  const words = STATUS_WORDS[inbox.status] ?? inbox.status;
  return inbox.statusDetail && inbox.status !== "ok" ? `${words}: ${inbox.statusDetail}` : words;
}

/** "fetching your mail · 120 of 340" while the inbox's first sync runs and it is connecting or ok, else undefined. */
export function firstSyncLine(inbox: Inbox): string | undefined {
  if (!inbox.firstSync || (inbox.status !== "connecting" && inbox.status !== "ok")) return undefined;
  return `${FIRST_SYNC_FETCHING.toLowerCase()} · ${firstSyncCount(inbox.firstSync)}`;
}

export const PROVIDER_WORDS: Record<ProviderKind, string> = { imap: "IMAP", gmail: "Gmail" };

/** True for addresses only this machine can reach. */
export function isLoopback(server: string): boolean {
  try {
    const host = new URL(server).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}
