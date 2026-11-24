// The dashboard's words for the contract's values, in the same words as docs/contract.md ("Words").
// Times are shown in UTC: a server-rendered page doesn't know the reader's time zone.
import {
  firstSyncWords,
  type ActionInput,
  type Actor,
  type Category,
  type DecidedCategory,
  type Inbox,
  type InboxIcon,
  type InboxStatus,
  type ProviderKind,
  type Rule,
  type RuleMatch,
  type RuleSource,
  type Stack,
  type TrustLevel,
} from "@usualmail/core";

/** The seven categories, as their lists are named. */
export const CATEGORY_NAMES: Record<Category, string> = {
  conversation: "Conversations",
  newsletter: "Newsletters",
  invoice: "Invoices",
  receipt: "Receipts",
  notification: "Notifications",
  otp: "One-time codes",
  unknown: "Not sorted yet",
};

/** The categories a person, a rule or an agent can choose: every one but `unknown`. */
export const DECIDED_CATEGORIES: DecidedCategory[] = ["conversation", "newsletter", "invoice", "receipt", "notification", "otp"];

export const ICON_NAMES: Record<InboxIcon, string> = {
  person: "Person",
  building: "Building",
  briefcase: "Briefcase",
  house: "House",
  shop: "Shop",
  globe: "Globe",
  plane: "Plane",
  wallet: "Wallet",
  family: "Family",
  rocket: "Rocket",
  school: "School",
  heart: "Heart",
  star: "Star",
  leaf: "Leaf",
};

export const STACK_NAMES: Record<Stack, string> = { reply_later: "Reply later", set_aside: "Set aside" };

/** The three trust levels, in the words of the contract's trust table: what happens, and what Handled shows. */
export const TRUST: Record<TrustLevel, { label: string; icon: string; explain: string }> = {
  suggest: {
    label: "Suggest",
    icon: "trust-suggest",
    explain: "Rules and agents only propose. Nothing moves until you approve it in Handled.",
  },
  act_with_undo: {
    label: "Act with undo",
    icon: "trust-act-with-undo",
    explain: "Rules and agents act, and every change shows in Handled, where you can undo it.",
  },
  act_silently: {
    label: "Act silently",
    icon: "trust-act-silently",
    explain:
      "Rules and agents act quietly. Handled lists their changes only when you ask, and you can still undo them. Anything that goes wrong is always shown.",
  },
};

export const STATUS_NAMES: Record<InboxStatus, string> = {
  connecting: "Connecting",
  ok: "Connected",
  needs_attention: "Needs attention",
  paused: "Paused",
};

/**
 * An inbox's status in a word or two; while its first sync runs and nothing is wrong, how far it has got, in core's
 * words: "Fetching your mail · 120 of 340".
 */
export function statusName(inbox: Inbox): string {
  if (inbox.firstSync && (inbox.status === "connecting" || inbox.status === "ok")) return firstSyncWords(inbox.firstSync);
  return STATUS_NAMES[inbox.status] ?? inbox.status;
}

export const PROVIDER_NAMES: Record<ProviderKind, string> = { imap: "IMAP", gmail: "Gmail" };

/**
 * Who made a rule, from its `createdBy`: the agent by name, or the person. A rule from before rules recorded who
 * made them (`system`) falls back to its source.
 */
export function ruleMaker(rule: Rule): string {
  if (rule.createdBy.kind === "agent") return `${rule.createdBy.name} suggested it`;
  if (rule.createdBy.kind === "person") return rule.source === "correction" ? RULE_SOURCE.correction : RULE_SOURCE.person;
  return RULE_SOURCE[rule.source];
}

export const RULE_SOURCE: Record<RuleSource, string> = {
  person: "You made it",
  correction: "You taught it by correcting",
  agent: "An agent suggested it",
};

export function hits(count: number): string {
  if (count === 0) return "Not used yet";
  if (count === 1) return "Used once";
  return `Used ${count} times`;
}

/** What an action did, or would do, in words: "put it in Receipts", "wants to put it in Receipts". */
export function actionPhrase(action: ActionInput, proposed: boolean): string {
  const [did, wants] = ((): [string, string] => {
    switch (action.kind) {
      case "categorize":
        return [`put it in ${CATEGORY_NAMES[action.category]}`, `wants to put it in ${CATEGORY_NAMES[action.category]}`];
      case "done":
        return ["marked it done", "wants to mark it done"];
      case "not_done":
        return ["marked it not done", "wants to mark it not done"];
      case "read":
        return ["marked it read", "wants to mark it read"];
      case "unread":
        return ["marked it unread", "wants to mark it unread"];
      case "stack":
        return [`put it on ${STACK_NAMES[action.stack]}`, `wants to put it on ${STACK_NAMES[action.stack]}`];
      case "unstack":
        return ["took it off its stack", "wants to take it off its stack"];
      case "come_back":
        return ["set it to come back", "wants it to come back"];
      case "cancel_come_back":
        return ["cancelled its come back", "wants to cancel its come back"];
      case "allow_sender":
        return ["let the sender in", "wants to let the sender in"];
      case "block_sender":
        return ["blocked the sender", "wants to block the sender"];
      case "trash":
        return ["moved it to the trash", "wants to move it to the trash"];
    }
  })();
  return proposed ? wants : did;
}

/** One rule action as an instruction: "Put in Receipts", "Mark done". */
export function ruleAction(action: ActionInput): string {
  switch (action.kind) {
    case "categorize":
      return `Put in ${CATEGORY_NAMES[action.category]}`;
    case "done":
      return "Mark done";
    case "read":
      return "Mark read";
    case "stack":
      return `Put on ${STACK_NAMES[action.stack]}`;
    case "allow_sender":
      return "Let the sender in";
    case "block_sender":
      return "Block the sender";
    case "trash":
      return "Move to the trash";
    default:
      return actionPhrase(action, false);
  }
}

/** A rule's conditions in words, one per set field. */
export function matchWords(match: RuleMatch): string[] {
  const words: string[] = [];
  if (match.from) words.push(`From ${match.from}`);
  if (match.domain) words.push(`From ${match.domain} or its subdomains`);
  if (match.listId) words.push(`Mailing list ${match.listId}`);
  if (match.subjectContains) words.push(`Subject contains “${match.subjectContains}”`);
  if (match.to) words.push(`Sent to ${match.to}`);
  if (match.automated === true) words.push("Sent by a machine");
  if (match.automated === false) words.push("Sent by a person");
  return words;
}

export function actorName(actor: Actor): string {
  switch (actor.kind) {
    case "rule":
      return "A rule";
    case "agent":
      return actor.name;
    case "person":
      return "You";
    case "ai":
      return "Usual Mail's AI";
    case "system":
      return "Usual Mail";
  }
}

/** The server's own AI has no icon of its own: it is Usual Mail's, so it takes Usual Mail's. */
export const ACTOR_ICON: Record<Actor["kind"], string> = { rule: "rule", agent: "agent", person: "person", ai: "inboxes", system: "inboxes" };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (date: Date) => `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
const dayStart = (date: Date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
const daysBetween = (from: Date, to: Date) => Math.round((dayStart(to) - dayStart(from)) / 86_400_000);

/** A past time in a list, in UTC: 08:52 today, Yesterday, a weekday within the week, or 13 Nov. */
export function listTime(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const ago = daysBetween(date, now);
  if (ago <= 0) return clock(date);
  if (ago === 1) return "Yesterday";
  if (ago < 7) return WEEKDAYS[date.getUTCDay()]!;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** A full time in UTC: "16 Nov 2026, 09:30 UTC". */
export function fullTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${clock(date)} UTC`;
}

/** A clock time in UTC for something soon, such as when a pairing code expires: "09:45 UTC". */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${clock(date)} UTC`;
}

/**
 * How long to wait, from a `rate_limited` answer's `retryAfter` (whole seconds): "45 seconds", "10 minutes".
 * Minutes are rounded up, so the person doesn't try again too early. Undefined when the service gave no time.
 */
export function waitWords(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const whole = Math.ceil(seconds);
  if (whole < 60) return `${whole} second${whole === 1 ? "" : "s"}`;
  const minutes = Math.ceil(whole / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** "1 inbox", "3 inboxes". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
