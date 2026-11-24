// Input shapes, checked by the service itself so every interface (REST now, the chat connector later) gets
// the same answers. Valibot strips nothing silently: unknown fields in bodies are refused.

import { CATEGORIES, INBOX_ICONS, RULE_ACTIONS, SEARCH_ASK_MAX, SEARCH_KINDS, ServiceError, STACKS, TRUST_LEVELS } from "@usualmail/core";
import * as v from "valibot";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const time = v.pipe(v.string(), v.minLength(1), v.maxLength(40));
/** A category someone can decide: any but `unknown`, which nobody chooses. */
const decidedCategory = v.picklist(CATEGORIES.filter((category) => category !== "unknown"), "A category is conversation, newsletter, invoice, receipt, notification or otp; nobody chooses unknown");
const stack = v.picklist(STACKS);
/** Control characters (C0, DEL, C1) and the line and paragraph separators: never part of a single line. */
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const EVERY_CONTROL_CHARACTER = new RegExp(CONTROL_CHARACTERS.source, "g");

/** `text` as one line: control characters and line separators as spaces, then every run of white space one space, trimmed. */
export function asOneLine(text: string): string {
  return text.replace(EVERY_CONTROL_CHARACTER, " ").replace(/\s+/g, " ").trim();
}

/**
 * One line of text that names something (a device, an inbox) or matches mail: trimmed, then refused when anything in it
 * would break a line. A device's name reaches the log, where a newline could forge a line of its own; a rule's list id or
 * subject words changed quietly would match other mail.
 */
export const line = (max: number) => v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(max),
  v.check((text) => !CONTROL_CHARACTERS.test(text), "Can't hold line breaks, tabs or other control characters"),
);

/**
 * One line of prose an agent or a person writes (a decision's or an action's reason, a brief's highlight, a rule's
 * text): made one line (`asOneLine`) rather than refused, so one reason with a line break doesn't refuse a whole batch
 * of 200 decisions, and a teach prompt stored before names were cleaned still makes its rule. None of these reaches the
 * log.
 */
export const prose = (max: number) => v.pipe(v.string(), v.transform(asOneLine), v.minLength(1), v.maxLength(max));

const address = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.maxLength(300))),
  email: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320)),
});
const addresses = v.pipe(v.array(address), v.maxLength(100));

export const ActionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("categorize"), category: decidedCategory }),
  v.strictObject({ kind: v.literal("done") }),
  v.strictObject({ kind: v.literal("not_done") }),
  v.strictObject({ kind: v.literal("read") }),
  v.strictObject({ kind: v.literal("unread") }),
  v.strictObject({ kind: v.literal("stack"), stack }),
  v.strictObject({ kind: v.literal("unstack") }),
  v.strictObject({ kind: v.literal("come_back"), at: time, ifNoReply: v.optional(v.boolean()) }),
  v.strictObject({ kind: v.literal("cancel_come_back") }),
  v.strictObject({ kind: v.literal("allow_sender") }),
  v.strictObject({ kind: v.literal("block_sender") }),
  v.strictObject({ kind: v.literal("trash") }),
]);

export const ActInputSchema = v.strictObject({
  threadIds: v.pipe(v.array(id), v.minLength(1), v.maxLength(200)),
  action: ActionSchema,
  reason: v.optional(prose(500)),
});

/** Actions a rule may take (core's `RULE_ACTIONS`). The others change nothing on brand-new mail or need a time. */
const ruleAction = v.pipe(
  ActionSchema,
  v.check((action) => RULE_ACTIONS.includes(action.kind), `A rule's actions can only be ${RULE_ACTIONS.join(", ")}`),
);

export const RuleMatchSchema = v.pipe(
  v.strictObject({
    from: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email())),
    domain: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^[a-z0-9.-]+\.[a-z0-9-]+$/, "A domain looks like example.com, without @"))),
    listId: v.optional(line(300)),
    subjectContains: v.optional(line(300)),
    to: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email())),
    automated: v.optional(v.boolean()),
  }),
  v.check((match) => Object.values(match).some((value) => value !== undefined), "A rule must match on at least one field"),
);

const ruleThen = v.pipe(v.array(ruleAction), v.minLength(1), v.maxLength(10));

export const RuleDraftSchema = v.strictObject({
  inboxId: id,
  text: prose(500),
  match: RuleMatchSchema,
  then: ruleThen,
});

export const RulePatchSchema = v.strictObject({
  text: v.optional(prose(500)),
  match: v.optional(RuleMatchSchema),
  then: v.optional(ruleThen),
  enabled: v.optional(v.boolean()),
});

const color = v.pipe(v.string(), v.regex(/^#[0-9A-Fa-f]{6}$/, "A colour is #RRGGBB"), v.toUpperCase());

export const ConnectInboxSchema = v.strictObject({
  name: line(100),
  color,
  provider: v.picklist(["imap", "gmail"]),
  credentials: v.unknown(),
  trust: v.optional(v.picklist(TRUST_LEVELS)),
  icon: v.optional(v.picklist(INBOX_ICONS)),
});

export const InboxPatchSchema = v.strictObject({
  name: v.optional(line(100)),
  color: v.optional(color),
  icon: v.optional(v.picklist(INBOX_ICONS)),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  trust: v.optional(v.picklist(TRUST_LEVELS)),
  guide: v.optional(v.pipe(v.string(), v.maxLength(20_000))),
  agentAccess: v.optional(v.boolean()),
  paused: v.optional(v.boolean()),
  credentials: v.optional(v.unknown()),
});

export const ListQuerySchema = v.strictObject({
  inboxId: v.optional(id),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(500))),
  limit: v.optional(v.number()),
});

export const SendersQuerySchema = v.strictObject({
  inboxId: v.optional(id),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(500))),
  limit: v.optional(v.number()),
  state: v.optional(v.literal("blocked")),
});

export const AllowSenderSchema = v.strictObject({
  inboxId: id,
  address: v.pipe(v.string(), v.minLength(3), v.maxLength(320)),
});

export const HandledQuerySchema = v.strictObject({
  inboxId: v.optional(id),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(500))),
  limit: v.optional(v.number()),
  states: v.optional(v.pipe(v.array(v.picklist(["proposed", "applied", "undone", "rejected", "failed"])), v.minLength(1))),
  includeSilent: v.optional(v.boolean()),
  attentionOnly: v.optional(v.boolean()),
});

/** A search (core's `SearchQuery`, docs/contract-search.md). Whether it says enough to search is the search's own check. */
export const SearchQuerySchema = v.strictObject({
  q: v.optional(v.pipe(v.string(), v.maxLength(200))),
  inboxIds: v.optional(v.pipe(v.array(id), v.maxLength(50))),
  kinds: v.optional(v.pipe(v.array(v.picklist(SEARCH_KINDS, `A kind is one of ${SEARCH_KINDS.join(", ")}`)), v.maxLength(SEARCH_KINDS.length))),
  from: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(320))),
  to: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(320))),
  subject: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
  hasAttachment: v.optional(v.boolean()),
  after: v.optional(time),
  before: v.optional(time),
  unread: v.optional(v.boolean()),
  tz: v.optional(v.pipe(v.string(), v.maxLength(64))),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(500))),
  limit: v.optional(v.number()),
});

export const SearchAskSchema = v.strictObject({
  question: v.pipe(v.string(), v.maxLength(SEARCH_ASK_MAX, `A sentence is at most ${SEARCH_ASK_MAX} characters`)),
  inboxIds: v.optional(v.pipe(v.array(id), v.maxLength(50))),
  tz: v.optional(v.pipe(v.string(), v.maxLength(64))),
});

export const TriageQuerySchema = v.strictObject({
  inboxId: v.optional(id),
  limit: v.optional(v.number()),
});

export const DecisionsSchema = v.pipe(
  v.array(v.strictObject({
    threadId: id,
    category: decidedCategory,
    done: v.optional(v.boolean()),
    need: v.optional(v.picklist(["reply", "decide", "pay", "read"])),
    reason: prose(500),
  })),
  v.minLength(1),
  v.maxLength(200),
);

export const DraftInputSchema = v.strictObject({
  id: v.optional(id),
  inboxId: id,
  threadId: v.optional(id),
  inReplyToMessageId: v.optional(id),
  to: addresses,
  cc: v.optional(addresses),
  bcc: v.optional(addresses),
  subject: v.pipe(v.string(), v.maxLength(1000)),
  body: v.pipe(v.string(), v.maxLength(1_000_000)),
});

export const BriefInputSchema = v.strictObject({
  from: time,
  to: time,
  sections: v.pipe(
    v.array(v.strictObject({
      inboxId: id,
      summary: v.optional(v.pipe(v.string(), v.maxLength(10_000))),
      highlights: v.pipe(v.array(v.strictObject({ threadId: id, line: prose(1000) })), v.maxLength(50)),
    })),
    v.maxLength(100),
  ),
});

export const PairingCodeInputSchema = v.strictObject({
  kind: v.picklist(["person", "agent"]),
  inboxIds: v.optional(v.pipe(v.array(id), v.maxLength(100))),
});

export const PairInputSchema = v.strictObject({
  code: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  name: line(100),
});

export const IdsSchema = v.pipe(v.array(id), v.minLength(1), v.maxLength(200));

/** Checks a value against a schema; anything else is `invalid` with a readable list of problems. */
export function check<const S extends v.GenericSchema>(schema: S, value: unknown, what: string): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (result.success) return result.output;
  const problems = result.issues.map((issue) => {
    const path = issue.path?.map((item) => String(item.key)).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw new ServiceError("invalid", `${what}: ${problems.join("; ")}`);
}
