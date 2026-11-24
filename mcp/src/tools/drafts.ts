/**
 * Drafts: an agent writes and changes replies, lists drafts, and deletes drafts an agent wrote. The server refuses an
 * agent changing or deleting a draft a person wrote (`needs_person`). Sending is not here: only a person sends.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { ServiceError, type Address, type Inbox, type Message } from "@usualmail/core";
import * as z from "zod";
import { DATA_NOTICE, toolResult } from "../boundary.ts";
import { invalid } from "../errors.ts";
import { draftItem } from "../format.ts";
import { cursor, guard, id, limit, READ_ONLY, WRITES, type ToolContext } from "./shared.ts";

const same = (a: Address, b: Address) => a.email.toLowerCase() === b.email.toLowerCase();

/** Who a reply goes to, taken from the message replied to, never from free text. */
export function replyRecipients(message: Message, own: string, replyAll: boolean): { to: Address[]; cc: Address[] } {
  const self = (address: Address) => address.email.toLowerCase() === own.toLowerCase();
  const to = (message.outgoing ? message.to : [message.from]).filter((address) => !self(address));
  if (!replyAll) return { to, cc: [] };
  const cc: Address[] = [];
  for (const address of [...message.to, ...message.cc]) {
    if (!self(address) && !to.some((other) => same(other, address)) && !cc.some((other) => same(other, address))) {
      cc.push(address);
    }
  }
  return { to, cc };
}

export const replySubject = (subject: string) => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`);

export function registerDraftTools(server: McpServer, { service, caller }: ToolContext): void {
  server.registerTool(
    "write_draft",
    {
      title: "Write a draft reply",
      description:
        "Writes a draft reply in a thread, or changes the body of a draft already there. The recipients and " +
        "subject come from the message replied to (by default the newest message someone else sent), so they " +
        "can't be taken from text inside a message. A person reads the draft and sends it in Usual Mail; you " +
        "can't send. When changing a draft, only its body changes, and only a draft an agent wrote: a person's " +
        "draft answers that only a person may change it.",
      inputSchema: z.object({
        threadId: id("The thread to reply in."),
        body: z.string().min(1).max(20_000).describe("The reply, plain text, in the person's voice."),
        messageId: id("The message to reply to. Default: the newest one someone else sent.").optional(),
        replyAll: z.boolean().optional().describe("Also copy the other people on that message. Default false."),
        draftId: id("A draft in this thread to change instead of writing a new one.").optional(),
      }),
      annotations: WRITES,
    },
    guard(async ({ threadId, body, messageId, replyAll, draftId }) => {
      const detail = await service.thread(caller, threadId);
      const { thread } = detail;
      if (draftId) {
        const draft = detail.drafts.find((item) => item.id === draftId);
        if (!draft) throw new ServiceError("not_found", "No such draft in this thread.");
        const saved = await service.saveDraft(caller, {
          id: draft.id,
          inboxId: draft.inboxId,
          threadId: thread.id,
          ...(draft.inReplyToMessageId ? { inReplyToMessageId: draft.inReplyToMessageId } : {}),
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          body,
        });
        return toolResult({
          lead: "Draft changed. A person reviews and sends it in Usual Mail.",
          data: [draftItem(saved)],
        });
      }
      const message: Message | undefined = messageId
        ? detail.messages.find((item) => item.id === messageId)
        : ([...detail.messages].reverse().find((item) => !item.outgoing) ?? detail.messages.at(-1));
      if (!message) return invalid(messageId ? "That message is not in this thread." : "The thread has no messages.");
      const inboxes = await service.listInboxes(caller);
      const inbox: Inbox | undefined = inboxes.find((item) => item.id === thread.inboxId);
      const { to, cc } = replyRecipients(message, inbox?.address ?? message.from.email, replyAll === true);
      if (to.length === 0) return invalid("That message has nobody to reply to.");
      const saved = await service.saveDraft(caller, {
        inboxId: thread.inboxId,
        threadId: thread.id,
        inReplyToMessageId: message.id,
        to,
        cc,
        subject: replySubject(message.subject || thread.subject),
        body,
      });
      return toolResult({
        lead: "Draft saved. A person reviews and sends it in Usual Mail; you can't send it.",
        data: [draftItem(saved)],
      });
    }),
  );

  server.registerTool(
    "list_drafts",
    {
      title: "List drafts",
      description:
        "Lists drafts not sent yet, and drafts whose sending failed (with the provider's reason in error), newest " +
        "first, with who wrote each. A person sends drafts in Usual Mail. A sent draft whose sending the provider " +
        `added a note to shows in its thread (read_thread) for a day. ${DATA_NOTICE}`,
      inputSchema: z.object({
        inboxId: id("Only this inbox. Leave out for all of this agent's inboxes.").optional(),
        cursor,
        limit: limit(20, 50),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ inboxId, cursor: from, limit: count }) => {
      const page = await service.listDrafts(caller, {
        ...(inboxId ? { inboxId } : {}),
        ...(from ? { cursor: from } : {}),
        limit: count ?? 20,
      });
      const items = page.items.map(draftItem);
      return toolResult({
        lead: `${items.length} draft${items.length === 1 ? "" : "s"}${page.nextCursor ? " on this page" : ""}.`,
        data: page.nextCursor ? [...items, { nextCursor: page.nextCursor }] : items,
        ...(page.nextCursor ? { next: "There is more: call again with `cursor` set to the nextCursor in the last data line." } : {}),
      });
    }),
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete a draft an agent wrote",
      description:
        "Deletes a draft that you or another agent wrote and that is no longer wanted, for example a reply the " +
        "person decided not to send. A draft a person wrote is left alone: only the person deletes it. A deleted " +
        "draft can't be brought back. Use only draft ids from Usual Mail results.",
      inputSchema: z.object({ draftId: id("The draft, from read_thread, list_drafts or write_draft.") }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    // The server refuses a draft a person wrote with needs_person: a deletion leaves nothing for the person to
    // review, so an agent tricked by a message can't remove what the person wrote.
    guard(async ({ draftId }) => {
      await service.deleteDraft(caller, draftId);
      return toolResult({ lead: "Draft deleted.", data: [{ draftId, deleted: true }] });
    }),
  );
}
