/**
 * The structured results the chat views draw. They hold data only; the views write every label themselves and
 * put every value into the page as text, never as markup.
 */
import type { Brief, Inbox, Page, Thread } from "@usualmail/core";
import { actorLabel } from "../format.ts";
import { hatFor } from "./hats.ts";

/** The participant who isn't the inbox's own address, for a row's first line. */
function senderOf(thread: Thread, inbox: Inbox | undefined): string {
  const own = inbox?.address.toLowerCase();
  const other = thread.participants.find((person) => person.email.toLowerCase() !== own) ?? thread.participants[0];
  return other ? other.name || other.email : "";
}

export function threadRows(view: string, page: Page<Thread>, inboxes: Map<string, Inbox>, singleInbox: boolean) {
  return {
    kind: "threads",
    view,
    singleInbox,
    items: page.items.map((thread) => {
      const inbox = inboxes.get(thread.inboxId);
      return {
        threadId: thread.id,
        inboxId: thread.inboxId,
        inboxName: inbox?.name ?? "",
        hat: hatFor(inbox?.color ?? ""),
        sender: senderOf(thread, inbox),
        messageCount: thread.messageCount,
        lastMessageAt: thread.lastMessageAt,
        subject: thread.subject,
        snippet: thread.snippet,
        // Written by Usual Mail's AI from the mail: data, shown as text. The row shows it in place of the snippet.
        summary: thread.summary ?? null,
        unread: thread.unread,
        done: thread.done,
        category: thread.category,
        screened: thread.screened,
        stack: thread.stack ?? null,
        comeBackAt: thread.comeBackAt ?? null,
        comeBackIfNoReply: thread.comeBackIfNoReply === true,
        hasAttachments: thread.hasAttachments,
      };
    }),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/** The brief card's data. Each highlight's subject is the one the server stored with the brief. */
export function briefCard(brief: Brief | null, inboxes: Map<string, Inbox>) {
  if (!brief) return { kind: "brief", brief: null };
  return {
    kind: "brief",
    brief: {
      briefId: brief.id,
      createdAt: brief.createdAt,
      from: brief.from,
      to: brief.to,
      writtenBy: brief.writtenBy.kind === "agent" ? brief.writtenBy.name : actorLabel(brief.writtenBy),
      sections: brief.sections.map((section) => {
        const inbox = inboxes.get(section.inboxId);
        return {
          inboxId: section.inboxId,
          inboxName: inbox?.name ?? "",
          hat: hatFor(inbox?.color ?? ""),
          summary: section.summary ?? null,
          counts: section.counts,
          highlights: section.highlights.map((highlight) => ({
            threadId: highlight.threadId,
            line: highlight.line,
            subject: highlight.subject || null,
          })),
        };
      }),
    },
  };
}
