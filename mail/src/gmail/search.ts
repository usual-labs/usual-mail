/**
 * Searching the mailbox itself for mail the server doesn't hold (docs/contract-search.md), read-only: the server's
 * search turned into Gmail's own operators, `threads.list` with `q` for a page of conversations, and each one's
 * headers in the metadata form (Subject, From, Date: nothing of the bodies). Opening one reads its messages whole, as
 * a sync does. Gmail leaves out spam and trash unless asked; drafts and chats are left out here.
 */
import type { Address, ProviderMessage, ProviderSearchHit, ProviderSearchPage, ProviderSearchQuery } from "@usualmail/core";
import { addressParser, decodeWords } from "postal-mime";
import { GmailApiError, type GmailClient } from "./client.ts";
import { COST } from "./limits.ts";
import { fetchMessages, isSkipped, type ConvertContext } from "./messages.ts";
import type { Names } from "../names.ts";

interface MetadataMessage {
  id: string;
  labelIds?: string[];
  internalDate?: string;
  sizeEstimate?: number;
  snippet?: string;
  payload?: { mimeType?: string; headers?: Array<{ name?: string; value?: string }> };
}

interface ThreadResource {
  id: string;
  snippet?: string;
  messages?: MetadataMessage[];
}

/** A word as Gmail reads it: bare when it is letters, digits and a few joiners, else in quotes. */
function word(text: string): string {
  const plain = text.replace(/"/g, " ").trim();
  return /^[\p{L}\p{N}._@'-]+$/u.test(plain) ? plain : `"${plain}"`;
}

/** A label as Gmail's search names it: lower case, spaces and slashes as hyphens ("Usual Mail/Receipts" is usual-mail-receipts). */
export function labelTerm(name: string): string {
  return `label:${name.toLowerCase().replace(/[\s/]+/g, "-")}`;
}

/**
 * The search in Gmail's operators: words, "phrases" and -words as typed; from:, to:, subject:(…), has:attachment,
 * after: and before: as Unix seconds, is:unread or is:read, the categories' and Screening's labels, -in:inbox for
 * archived mail; never drafts or chats.
 */
export function gmailQuery(query: ProviderSearchQuery, names: Names): string {
  const terms: string[] = [];
  for (const w of query.words) terms.push(word(w));
  for (const phrase of query.phrases) terms.push(`"${phrase.replace(/"/g, " ").trim()}"`);
  for (const w of query.exclude) terms.push(`-${word(w)}`);
  if (query.from) terms.push(`from:${word(query.from)}`);
  if (query.to) terms.push(`to:${word(query.to)}`);
  if (query.subject) terms.push(`subject:(${query.subject.split(/\s+/).filter(Boolean).map(word).join(" ")})`);
  if (query.hasAttachment !== undefined) terms.push(query.hasAttachment ? "has:attachment" : "-has:attachment");
  if (query.after) terms.push(`after:${Math.floor(Date.parse(query.after) / 1000)}`);
  if (query.before) terms.push(`before:${Math.floor(Date.parse(query.before) / 1000)}`);
  if (query.unread !== undefined) terms.push(query.unread ? "is:unread" : "is:read");
  if (query.categories?.length) {
    const labels = query.categories.map((category) => labelTerm(names[category]));
    terms.push(labels.length === 1 ? labels[0]! : `{${labels.join(" ")}}`);
  }
  if (query.screened) terms.push(labelTerm(names.screening));
  if (query.archived) terms.push("-in:inbox");
  terms.push("-in:drafts", "-in:chats");
  return terms.join(" ");
}

/** One page of conversations: `threads.list` (10 units), then each one's headers (`threads.get`, metadata, 20 units). */
export async function searchGmail(
  client: GmailClient,
  query: ProviderSearchQuery,
  names: Names,
  options: { page?: string; limit: number },
): Promise<ProviderSearchPage> {
  const list = await client.request<{ threads?: Array<{ id: string; snippet?: string }>; nextPageToken?: string }>("GET", "/threads", {
    cost: COST.threadsList,
    query: { q: gmailQuery(query, names), maxResults: options.limit, pageToken: options.page },
  });
  const found = await Promise.all((list.threads ?? []).map(async (item) => {
    try {
      const thread = await client.request<ThreadResource>("GET", `/threads/${encodeURIComponent(item.id)}`, {
        cost: COST.threadsGet,
        query: { format: "metadata", metadataHeaders: ["Subject", "From", "Date"] },
      });
      return hitOf(thread, item.snippet);
    } catch (error) {
      // Gone between the listing and the reading.
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }
  }));
  const page: ProviderSearchPage = { hits: found.filter((hit): hit is ProviderSearchHit => hit !== null) };
  if (list.nextPageToken) page.next = list.nextPageToken;
  return page;
}

function hitOf(thread: ThreadResource, snippet: string | undefined): ProviderSearchHit | null {
  const mail = (thread.messages ?? []).filter((m) => !isSkipped(m.labelIds) && !m.labelIds?.includes("SPAM") && !m.labelIds?.includes("TRASH"));
  if (!mail.length) return null;
  const date = (m: MetadataMessage) => Number(m.internalDate ?? 0);
  const ordered = [...mail].sort((a, b) => date(a) - date(b));
  const newest = ordered.at(-1)!;
  const header = (m: MetadataMessage, name: string) =>
    m.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
  return {
    threadKey: thread.id,
    subject: decodeWords(header(ordered[0]!, "Subject")),
    from: addressOf(header(newest, "From")),
    date: new Date(date(newest)).toISOString(),
    snippet: snippet ?? newest.snippet ?? "",
    // The metadata form carries no parts; mail with an attachment is multipart/mixed at the top.
    hasAttachments: mail.some((m) => m.payload?.mimeType?.toLowerCase() === "multipart/mixed"),
    messageCount: mail.length,
    inInbox: mail.some((m) => m.labelIds?.includes("INBOX")),
  };
}

function addressOf(value: string): Address {
  const first = addressParser(value)[0] as { name?: string; address?: string; group?: Array<{ name?: string; address?: string }> } | undefined;
  const mailbox = first?.group ? first.group[0] : first;
  const email = (mailbox?.address ?? "").toLowerCase();
  const name = mailbox?.name ? decodeWords(mailbox.name).trim() : "";
  return name ? { name, email } : { email };
}

/**
 * Every message of a conversation as a sync sends it, oldest first: `threads.get` in the minimal form for its ids and
 * labels (20 units), then each message whole (60 units each). Spam, trash, drafts and chats are left out.
 */
export async function fetchGmailThread(client: GmailClient, threadKey: string, context: ConvertContext): Promise<ProviderMessage[]> {
  let thread: ThreadResource;
  try {
    thread = await client.request<ThreadResource>("GET", `/threads/${encodeURIComponent(threadKey)}`, {
      cost: COST.threadsGet,
      query: { format: "minimal" },
    });
  } catch (error) {
    if (error instanceof GmailApiError && (error.status === 404 || error.status === 400)) return [];
    throw error;
  }
  const kept = (thread.messages ?? []).filter((m) => !isSkipped(m.labelIds) && !m.labelIds?.includes("SPAM") && !m.labelIds?.includes("TRASH"));
  // The minimal form already carries each message's size, so no message needs its own size check.
  const sizes = new Map(kept.filter((m) => typeof m.sizeEstimate === "number").map((m) => [m.id, m.sizeEstimate!]));
  const { messages } = await fetchMessages(client, kept.map((m) => m.id), context, sizes);
  return messages
    .filter((m) => !m.placement.spam && !m.placement.trashed)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}
