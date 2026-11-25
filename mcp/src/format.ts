/** Short, structured shapes of core's types for tool results. Everything here ends up inside the data block. */
import type {
  ActionInput,
  ActionRecord,
  Actor,
  Address,
  Draft,
  Inbox,
  Message,
  Rule,
  Thread,
} from "@usualmail/core";
import { skippedScreeningLine } from "@usualmail/core";

/** How much of a message's text a result carries. */
export const TEXT_LIMITS = { triage: 2000, thread: 4000 } as const;

export function address(value: Address): { name?: string; email: string } {
  return value.name ? { name: value.name, email: value.email } : { email: value.email };
}

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case "person":
      return "person";
    case "rule":
      return `rule ${actor.ruleId}`;
    case "agent":
      return `agent ${actor.name}`;
    case "ai":
      return `Usual Mail's AI (${actor.job} with ${actor.model})`;
    case "system":
      return "Usual Mail";
  }
}

/** A short plain description of an action, for example "categorize as newsletter". */
export function actionLabel(action: ActionInput): string {
  switch (action.kind) {
    case "categorize":
      return `categorize as ${action.category}`;
    case "stack":
      return `stack on ${action.stack}`;
    case "come_back":
      return `come back at ${action.at}${action.ifNoReply ? " if no reply" : ""}`;
    default:
      return action.kind;
  }
}

export function inboxItem(inbox: Inbox) {
  return {
    inboxId: inbox.id,
    name: inbox.name,
    address: inbox.address,
    trust: inbox.trust,
    status: inbox.status,
    ...(inbox.statusDetail ? { statusDetail: inbox.statusDetail } : {}),
    // Why it needs attention (a refused sign-in, the host's setup, a failing provider, no sync finishing), so an agent
    // can say what fixes it rather than guess from the words.
    ...(inbox.statusReason ? { statusReason: inbox.statusReason } : {}),
    // While its first sync runs: messages fetched of the window's total, so more of its mail is still to come.
    ...(inbox.firstSync ? { firstSync: { fetched: inbox.firstSync.fetched, total: inbox.firstSync.total } } : {}),
    guide: inbox.guide,
  };
}

/** Where a thread is now and why, without its text: its category, who decided it, and whether it is screened. */
export function threadState(thread: Thread) {
  return {
    threadId: thread.id,
    inboxId: thread.inboxId,
    category: thread.category,
    ...(thread.categorizedBy ? { categorizedBy: thread.categorizedBy } : {}),
    screened: thread.screened,
    done: thread.done,
    ...(thread.stack ? { stack: thread.stack } : {}),
    ...(thread.comeBackAt ? { comeBackAt: thread.comeBackAt, comeBackIfNoReply: thread.comeBackIfNoReply === true } : {}),
    ...(thread.trashed ? { trashed: true } : {}),
    ...(thread.need ? { need: thread.need } : {}),
    ...(thread.reason ? { reason: thread.reason } : {}),
    // Out of Screening though its sender isn't let in: the kind of mail the server's own check let through.
    ...(thread.skippedScreening ? { skippedScreening: skippedScreeningLine(thread.skippedScreening) } : {}),
  };
}

/**
 * One row of a list: who, what, when, where it is. `summary` is what Usual Mail's AI wrote from the mail, and
 * `payment` what it read in a receipt or an invoice (who, how much in minor units, paid, scheduled or due, what for;
 * checked by the server), and `event` what it read in a notification (status, about, when, and the opaque `group` it
 * shares with notifications about the same thing; checked too):
 * a model's words made from untrusted text, so they are data like the mail itself.
 */
export function threadSummary(thread: Thread) {
  return {
    ...threadState(thread),
    subject: thread.subject,
    ...(thread.summary ? { summary: thread.summary } : {}),
    ...(thread.payment ? { payment: thread.payment } : {}),
    ...(thread.event ? { event: thread.event } : {}),
    snippet: thread.snippet,
    participants: thread.participants.slice(0, 6).map(address),
    lastMessageAt: thread.lastMessageAt,
    messageCount: thread.messageCount,
    unread: thread.unread,
    hasAttachments: thread.hasAttachments,
  };
}

/** A message's text, from its plain text or else its HTML, cut to `limit` characters. */
export function messageText(message: Message, limit: number): { text: string; truncated: boolean } {
  const full = message.text?.trim() ? message.text : message.html ? htmlToText(message.html) : "";
  return full.length > limit ? { text: full.slice(0, limit), truncated: true } : { text: full, truncated: false };
}

export function messageItem(message: Message, limit: number) {
  const { text, truncated } = messageText(message, limit);
  return {
    messageId: message.id,
    date: message.date,
    from: address(message.from),
    to: message.to.map(address),
    ...(message.cc.length ? { cc: message.cc.map(address) } : {}),
    subject: message.subject,
    outgoing: message.outgoing,
    unread: message.unread,
    attachments: message.attachments
      .filter((attachment) => !attachment.inline)
      .map((attachment) => ({ filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size })),
    text,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * One action record. `error` (why it failed, or why its undo was refused) and `note` (what the provider said about a
 * change that worked) are the provider's words: data, like everything else here.
 */
export function recordItem(record: ActionRecord) {
  return {
    actionId: record.id,
    threadId: record.threadId,
    inboxId: record.inboxId,
    action: actionLabel(record.action),
    actor: actorLabel(record.actor),
    state: record.state,
    undoable: record.undoable,
    ...(record.silent ? { silent: true } : {}),
    at: record.at,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.note ? { note: record.note } : {}),
  };
}

export function ruleItem(rule: Rule) {
  return {
    ruleId: rule.id,
    inboxId: rule.inboxId,
    text: rule.text,
    match: rule.match,
    then: rule.then.map(actionLabel),
    source: rule.source,
    createdBy: actorLabel(rule.createdBy),
    enabled: rule.enabled,
    hits: rule.hits,
  };
}

export function draftItem(draft: Draft) {
  return {
    draftId: draft.id,
    inboxId: draft.inboxId,
    ...(draft.threadId ? { threadId: draft.threadId } : {}),
    to: draft.to.map(address),
    ...(draft.cc.length ? { cc: draft.cc.map(address) } : {}),
    subject: draft.subject,
    body: draft.body,
    state: draft.state,
    createdBy: actorLabel(draft.createdBy),
    updatedAt: draft.updatedAt,
    ...(draft.error ? { error: draft.error } : {}),
    ...(draft.note ? { note: draft.note } : {}),
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text from sanitized HTML: drops tags, keeps paragraph breaks, decodes common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A time as the contract writes it: UTC, whole seconds, `Z`. Undefined when it isn't a time. */
export function contractTime(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Reads `cursor` for list tools whose paging the connector does itself. */
export function offsetCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return 0;
  return /^\d{1,6}$/.test(cursor) ? Number(cursor) : undefined;
}
