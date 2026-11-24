/**
 * Writing Usual Mail's changes back to Gmail with labels: INBOX for "in the inbox", one label per filed category,
 * one for Screening and one per stack under "Usual Mail/", UNREAD for seen, and Gmail's own trash. Gmail keeps every
 * label on a message, so a screened message carries its category's label too. Refs never change in Gmail.
 */
import { FILED_CATEGORIES, STACKS, type OutgoingMessage, type ProviderOp, type ProviderOpResult, type SendResult } from "@usualmail/core";
import { GmailApiError, type GmailClient } from "./client.ts";
import type { LabelBook } from "./labels.ts";
import { COST } from "./limits.ts";
import { composeMessage } from "../message/compose.ts";
import { IN_INBOX_ONLY_UNFILED } from "../names.ts";

export async function applyGmail(client: GmailClient, labels: LabelBook, ops: ProviderOp[]): Promise<ProviderOpResult[]> {
  labels.reset();
  const results: ProviderOpResult[] = [];
  for (const op of ops) {
    try {
      await applyOne(client, labels, op);
      results.push({ ok: true, ref: op.ref });
    } catch (error) {
      results.push({ ok: false, error: describe(error) });
    }
  }
  return results;
}

async function applyOne(client: GmailClient, labels: LabelBook, op: ProviderOp): Promise<void> {
  const path = `/messages/${encodeURIComponent(op.ref)}`;
  // The server never asks for both (docs/contract-sync.md, "Providers"); IMAP can't express it, so neither does Gmail.
  if ((op.op === "place" || op.op === "untrash") && op.inInbox && (op.category !== null || op.screened)) throw new Error(IN_INBOX_ONLY_UNFILED);
  if (op.op === "trash") {
    await client.request("POST", `${path}/trash`, { cost: COST.messagesTrash });
    return;
  }
  if (op.op === "untrash") {
    // Google doesn't say which labels untrashing restores, so the destination is set right after it.
    await client.request("POST", `${path}/untrash`, { cost: COST.messagesUntrash });
  }
  const add: string[] = [];
  const remove: string[] = [];
  if (op.op === "seen") {
    (op.seen ? remove : add).push("UNREAD");
  } else {
    // A placed message is where Usual Mail sorted it, so not spam; as with IMAP, where it leaves Junk.
    remove.push("SPAM");
    (op.inInbox ? add : remove).push("INBOX");
    const existing = await labels.ids();
    for (const category of FILED_CATEGORIES) {
      if (category === op.category) add.push(await labels.ensure(category));
      else if (existing[category]) remove.push(existing[category]!);
    }
    if (op.screened) add.push(await labels.ensure("screening"));
    else if (existing.screening) remove.push(existing.screening);
    for (const stack of STACKS) {
      if (stack === op.stack) add.push(await labels.ensure(stack));
      else if (existing[stack]) remove.push(existing[stack]!);
    }
  }
  await client.request("POST", `${path}/modify`, { cost: COST.messagesModify, body: { addLabelIds: add, removeLabelIds: remove } });
}

/**
 * Sends through Gmail. A reply goes into its thread: Gmail wants the thread id, the References and
 * In-Reply-To headers, and a matching subject. The thread id is the reply's `threadKey`; without one, it is
 * looked up from the parent's Message-ID.
 */
export async function sendGmail(client: GmailClient, message: OutgoingMessage): Promise<SendResult> {
  const composed = await composeMessage(message);
  let threadId = message.threadKey;
  if (!threadId && message.inReplyTo) {
    const found = await client.request<{ messages?: { id: string; threadId: string }[] }>("GET", "/messages", {
      cost: COST.messagesList,
      query: { q: `rfc822msgid:${message.inReplyTo}`, includeSpamTrash: true, maxResults: 1 },
    });
    threadId = found.messages?.[0]?.threadId;
  }
  const body: { raw: string; threadId?: string } = { raw: composed.rawWithBcc.toString("base64url") };
  if (threadId) body.threadId = threadId;
  const sent = await client.request<{ id: string }>("POST", "/messages/send", { cost: COST.messagesSend, body });
  // Gmail may put its own Message-ID on the sent message; report the one it kept.
  try {
    const meta = await client.request<{ payload?: { headers?: { name: string; value: string }[] } }>("GET", `/messages/${encodeURIComponent(sent.id)}`, {
      cost: COST.messagesGet,
      query: { format: "metadata", metadataHeaders: ["Message-ID"] },
    });
    const header = meta.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id")?.value;
    const kept = header?.trim().replace(/^<|>$/g, "");
    if (kept) return { messageId: kept };
  } catch {
    // The message is sent; fall back to the id it was sent with.
  }
  return { messageId: composed.messageId };
}

function describe(error: unknown): string {
  if (error instanceof GmailApiError && error.status === 404) return "Gmail no longer has this message.";
  return (error as Error)?.message ?? String(error);
}
