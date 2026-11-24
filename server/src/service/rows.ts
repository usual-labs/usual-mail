// Turning database rows into core's shapes. Optional fields are left out rather than set to null.

import type {
  ActionRecord,
  AttachmentMeta,
  Brief,
  Device,
  Draft,
  Inbox,
  InboxConnection,
  Message,
  Rule,
  TeachPrompt,
  Thread,
} from "@usualmail/core";
import type {
  ActionRow,
  AttachmentRow,
  BriefRow,
  DeviceRow,
  DraftRow,
  InboxRow,
  MessageRow,
  RuleRow,
  TeachRow,
  ThreadRow,
} from "../db/index.ts";
import { PAYMENT_CATEGORIES } from "@usualmail/core";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { servedPayment } from "../ai/payment.ts";
import { iso, isoOrUndefined } from "../util.ts";
import { normalizeListId } from "./match.ts";

/**
 * The whole second a stored time (Unix milliseconds) is published as, in SQL: `iso` drops the milliseconds. Lists
 * order by it, then by id, descending, so their order is one a client can reproduce from what it is given
 * (docs/contract.md, "Lists"). Cursors hold the same second.
 */
export function publishedSecond(time: SQL | AnyColumn): SQL<number> {
  return sql<number>`cast((${time}) / 1000 as integer)`;
}

/** `publishedSecond` for a time already read: the whole second a cursor holds. */
export function wholeSecond(ms: number): number {
  return Math.floor(ms / 1000);
}

export function toInbox(row: InboxRow): Inbox {
  const inbox: Inbox = {
    id: row.id,
    name: row.name,
    address: row.address,
    color: row.color,
    icon: row.icon,
    position: row.position,
    provider: row.provider,
    connection: row.connection ?? unknownConnection(row.provider),
    trust: row.trust,
    guide: row.guide,
    agentAccess: row.agentAccess,
    status: row.paused ? "paused" : row.status,
    createdAt: iso(row.createdAt),
    version: row.version,
  };
  if (row.statusDetail && !row.paused) inbox.statusDetail = row.statusDetail;
  // Only while the first sync runs: a count left on a row whose first sync is done is never shown.
  if (!row.historyDone && row.firstSyncTotal !== null) {
    const fetched = row.firstSyncFetched ?? 0;
    inbox.firstSync = { fetched, total: Math.max(row.firstSyncTotal, fetched) };
  }
  if (row.lastSyncedAt !== null) inbox.lastSyncedAt = iso(row.lastSyncedAt);
  return inbox;
}

/**
 * Only for a store from before the fourth revision whose credentials the server couldn't describe at start (no
 * provider for its kind): the shape with nothing filled in, so the inbox still lists and can be given new
 * credentials.
 */
function unknownConnection(kind: InboxRow["provider"]): InboxConnection {
  const blank = { host: "", port: kind === "imap" ? 993 : 0, secure: true, user: "" };
  return kind === "gmail" ? { kind, clientId: "" } : { kind: "imap", imap: blank, smtp: { ...blank, port: 465 }, saveSent: true };
}

export function toThread(row: ThreadRow): Thread {
  const thread: Thread = {
    id: row.id,
    inboxId: row.inboxId,
    subject: row.subject,
    snippet: row.snippet,
    participants: row.participants,
    lastMessageAt: iso(row.lastMessageAt),
    messageCount: row.messageCount,
    unread: row.unread,
    hasAttachments: row.hasAttachments,
    category: row.category,
    screened: row.screened,
    done: row.done,
    trashed: row.trashed,
    version: row.version,
  };
  if (row.categorizedBy) thread.categorizedBy = row.categorizedBy;
  if (row.categorizedBy && row.categorizedBy !== "mailbox" && row.categorizedByActor) thread.categorizedByActor = row.categorizedByActor;
  if (row.sender) thread.sender = row.sender;
  if (row.stack) thread.stack = row.stack;
  if (row.comeBackAt !== null) {
    thread.comeBackAt = iso(row.comeBackAt);
    if (row.comeBackIfNoReply) thread.comeBackIfNoReply = true;
  }
  if (row.need) thread.need = row.need;
  if (row.reason) thread.reason = row.reason;
  if (row.summary) thread.summary = row.summary;
  if (row.payment && (PAYMENT_CATEGORIES as readonly string[]).includes(row.category)) thread.payment = servedPayment(row.payment)!;
  if (row.event && row.category === "notification") thread.event = row.event;
  // Kept on the row with its version (`avatars/settle.ts`); never on a screened thread, whatever the row holds.
  if (row.avatar && !row.screened) thread.avatar = row.avatar;
  return thread;
}

export function toAttachment(row: AttachmentRow): AttachmentMeta {
  const meta: AttachmentMeta = { id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size, inline: row.inline };
  if (row.contentId) meta.contentId = row.contentId;
  return meta;
}

export function toMessage(row: MessageRow, attachments: AttachmentRow[]): Message {
  const message: Message = {
    id: row.id,
    threadId: row.threadId,
    inboxId: row.inboxId,
    from: row.from,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    date: iso(row.date),
    subject: row.subject,
    attachments: attachments.map(toAttachment),
    unread: row.unread,
    outgoing: row.outgoing,
  };
  if (row.text !== null) message.text = row.text;
  if (row.html !== null) message.html = row.html;
  const listId = normalizeListId(row.listId);
  if (listId) message.listId = listId;
  return message;
}

export function toRecord(row: ActionRow): ActionRecord {
  const record: ActionRecord = {
    id: row.id,
    threadId: row.threadId,
    inboxId: row.inboxId,
    action: row.action,
    actor: row.actor,
    state: row.state,
    at: iso(row.at),
    undoable: row.undoable,
    silent: row.silent,
    version: row.version,
  };
  if (row.reason) record.reason = row.reason;
  if (row.undoneAt !== null) record.undoneAt = iso(row.undoneAt);
  if (row.error) record.error = row.error;
  if (row.note) record.note = row.note;
  return record;
}

export function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    inboxId: row.inboxId,
    text: row.text,
    match: row.match,
    then: row.then,
    source: row.source,
    enabled: row.enabled,
    hits: row.hits,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    version: row.version,
  };
}

export function toTeach(row: TeachRow): TeachPrompt {
  return {
    id: row.id,
    question: row.question,
    rule: row.rule,
    fromActionId: row.fromActionId,
    expiresAt: iso(row.expiresAt),
  };
}

export function toDraft(row: DraftRow): Draft {
  const draft: Draft = {
    id: row.id,
    inboxId: row.inboxId,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    body: row.body,
    createdBy: row.createdBy,
    state: row.state,
    updatedAt: iso(row.updatedAt),
    version: row.version,
  };
  if (row.threadId) draft.threadId = row.threadId;
  if (row.inReplyToMessageId) draft.inReplyToMessageId = row.inReplyToMessageId;
  if (row.error) draft.error = row.error;
  if (row.note) draft.note = row.note;
  return draft;
}

export function toBrief(row: BriefRow): Brief {
  return {
    id: row.id,
    createdAt: iso(row.createdAt),
    from: iso(row.from),
    to: iso(row.to),
    sections: row.sections,
    writtenBy: row.writtenBy,
  };
}

export function toDevice(row: DeviceRow): Device {
  const device: Device = { id: row.id, name: row.name, kind: row.kind, createdAt: iso(row.createdAt) };
  if (row.kind === "agent") device.inboxIds = row.inboxIds ?? [];
  const lastSeen = isoOrUndefined(row.lastSeenAt);
  if (lastSeen) device.lastSeenAt = lastSeen;
  return device;
}
