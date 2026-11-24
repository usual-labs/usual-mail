// Turns core/fixtures/sample.json into the content both galleries show, with every label already written, so the
// HTML and SwiftUI galleries show exactly the same words. Times are shown in UTC.
import { readFileSync } from "node:fs";
import { distance } from "./color.mjs";

/** The seven categories in the contract's order, as lists name them. */
const CATEGORIES = {
  conversation: "Conversations",
  newsletter: "Newsletters",
  invoice: "Invoices",
  receipt: "Receipts",
  notification: "Notifications",
  otp: "One-time codes",
  unknown: "Not sorted yet",
};
const STACKS = { reply_later: { label: "Reply later", icon: "reply-later" }, set_aside: { label: "Set aside", icon: "set-aside" } };
const TRUST = {
  suggest: { label: "Suggest", icon: "trust-suggest" },
  act_with_undo: { label: "Act with undo", icon: "trust-act-with-undo" },
  act_silently: { label: "Act silently", icon: "trust-act-silently" },
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Picks the hat whose light fill is nearest the stored colour. An exact key wins by distance 0. */
export function matchHat(hats, stored) {
  const hex = String(stored).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return hats.find((hat) => hat.name === "slate") ?? hats[0];
  return hats.reduce((best, hat) => (distance(hex, hat.fill.light.hex) < distance(hex, best.fill.light.hex) ? hat : best));
}

const clock = (date) => `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
const dayStart = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
const days = (from, to) => Math.round((dayStart(to) - dayStart(from)) / 86_400_000);

/** A list time: 08:52 today, Yesterday, a weekday within the week, or 13 Nov. */
export function listTime(iso, nowIso) {
  const [date, now] = [new Date(iso), new Date(nowIso)];
  const ago = days(date, now);
  if (ago === 0) return clock(date);
  if (ago === 1) return "Yesterday";
  if (ago > 1 && ago < 7) return WEEKDAYS[date.getUTCDay()];
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** A time ahead: today 18:00, tomorrow 08:00, Thu 08:00, or 30 Nov 08:00. */
export function aheadTime(iso, nowIso) {
  const [date, now] = [new Date(iso), new Date(nowIso)];
  const ahead = days(now, date);
  const day = ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : ahead < 7 ? WEEKDAYS[date.getUTCDay()] : `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return `${day} ${clock(date)}`;
}

/** What an action did, or would do, in words. */
export function actionPhrase(action, proposed) {
  const phrases = {
    categorize: [`put it in ${CATEGORIES[action.category]}`, `wants to put it in ${CATEGORIES[action.category]}`],
    done: ["marked it done", "wants to mark it done"],
    not_done: ["marked it not done", "wants to mark it not done"],
    read: ["marked it read", "wants to mark it read"],
    unread: ["marked it unread", "wants to mark it unread"],
    stack: [`put it on ${STACKS[action.stack]?.label}`, `wants to put it on ${STACKS[action.stack]?.label}`],
    unstack: ["took it off its stack", "wants to take it off its stack"],
    come_back: ["set it to come back", "wants it to come back"],
    cancel_come_back: ["cancelled its come back", "wants to cancel its come back"],
    allow_sender: ["let the sender in", "wants to let the sender in"],
    block_sender: ["blocked the sender", "wants to block the sender"],
    trash: ["moved it to the trash", "wants to move it to the trash"],
  };
  const phrase = phrases[action.kind];
  if (!phrase) throw new Error(`The gallery has no words for the action "${action.kind}" in core/fixtures/sample.json`);
  return phrase[proposed ? 1 : 0];
}

/** The server's own AI has no icon of its own; it is Usual Mail's, so it takes Usual Mail's. */
const ACTOR_ICON = { rule: "rule", agent: "agent", person: "person", ai: "inboxes", system: "inboxes" };
const actorName = (actor) =>
  ({ rule: "A rule", agent: actor.name, person: "You", ai: "Usual Mail's AI", system: "Usual Mail" })[actor.kind];

/** Thread rows shown in the galleries, chosen to cover a row's states. The second is shown selected. */
const ROWS = ["thr_1", "thr_2", "thr_6", "thr_12", "thr_5", "thr_15", "thr_7", "thr_9", "thr_10", "thr_13"];
const SELECTED = "thr_2";
/**
 * Handled threads shown with their reason line: a rule, a proposal, the server's AI, an agent, an undone action and
 * your own.
 */
const REASONS = ["act_1", "act_4", "act_10", "act_8", "act_15", "act_6"];

/** Looks an id up, or says which id the sample no longer has (instead of failing on `undefined` later). */
function find(map, id, what) {
  const found = map.get(id);
  if (!found) throw new Error(`core/fixtures/sample.json has no ${what} "${id}", which the gallery shows`);
  return found;
}

export function galleryContent(sample, model) {
  const inboxes = new Map(sample.inboxes.map((inbox) => [inbox.id, inbox]));
  const threads = new Map(sample.threads.map((thread) => [thread.id, thread]));
  const hatOf = (inboxId) => matchHat(model.hats, inboxes.get(inboxId).color).name;

  const hats = sample.inboxes.map((inbox) => ({
    id: inbox.id,
    name: inbox.name,
    address: inbox.address,
    stored: inbox.color,
    hat: hatOf(inbox.id),
    icon: inbox.icon,
    trust: TRUST[inbox.trust].label,
    trustIcon: TRUST[inbox.trust].icon,
    attention: inbox.status === "needs_attention" ? inbox.statusDetail ?? "Needs attention" : null,
  }));

  const brief = sample.brief;
  const from = new Date(brief.from);
  const briefContent = {
    title: "Brief",
    period: `Since ${days(from, new Date(brief.to)) === 1 ? "yesterday" : WEEKDAYS[from.getUTCDay()]} ${clock(from)}`,
    writtenBy: actorName(brief.writtenBy),
    sections: brief.sections.map((section) => ({
      hat: hatOf(section.inboxId),
      inbox: inboxes.get(section.inboxId).name,
      summary: section.summary ?? null,
      highlights: section.highlights.map((h) => ({ line: h.line, subject: h.subject })),
      counts: [...Object.keys(CATEGORIES), "done", "trash"]
        .filter((key) => section.counts?.[key])
        .map((key) => `${CATEGORIES[key] ?? (key === "done" ? "Done" : "Trash")} ${section.counts[key]}`)
        .join(" · "),
    })),
  };

  const rows = ROWS.map((id) => {
    const t = find(threads, id, "thread");
    const own = inboxes.get(t.inboxId).address;
    const sender = t.participants.find((p) => p.email !== own) ?? t.participants[0];
    return {
      id,
      hat: hatOf(t.inboxId),
      inbox: inboxes.get(t.inboxId).name,
      sender: sender.name ?? sender.email,
      subject: t.subject,
      // Interfaces show the server's summary, and the snippet while there is none.
      snippet: t.summary ?? t.snippet,
      time: listTime(t.lastMessageAt, sample.now),
      messageCount: t.messageCount,
      unread: t.unread,
      attachment: t.hasAttachments,
      done: t.done,
      category: CATEGORIES[t.category],
      stack: t.stack ? STACKS[t.stack].label : null,
      stackIcon: t.stack ? STACKS[t.stack].icon : null,
      comeBack: t.comeBackAt ? `Comes back ${aheadTime(t.comeBackAt, sample.now)}${t.comeBackIfNoReply ? " if no reply" : ""}` : null,
      selected: id === SELECTED,
    };
  });

  const actions = new Map(sample.actions.map((a) => [a.id, a]));
  const reasons = REASONS.map((id) => {
    const a = find(actions, id, "action record");
    const proposed = a.state === "proposed";
    return {
      id,
      hat: hatOf(a.inboxId),
      inbox: inboxes.get(a.inboxId).name,
      subject: threads.get(a.threadId).subject,
      icon: ACTOR_ICON[a.actor.kind],
      actor: actorName(a.actor),
      action: actionPhrase(a.action, proposed),
      reason: a.reason ?? null,
      time: listTime(a.at, sample.now),
      state: a.state,
      undoable: a.undoable,
    };
  });

  const first = find(threads, ROWS[0], "thread");
  const typeSamples = {
    display: briefContent.title,
    title: sample.inboxes[0].name,
    heading: first.subject,
    reading: briefContent.sections[0].summary,
    body: first.snippet,
    label: rows[0].sender,
    caption: rows.find((r) => r.comeBack)?.comeBack ?? rows[0].time,
    mono: "7KQ2ZP",
    wordmark: "Usual|mail",
  };

  return { hats, brief: briefContent, rows, reasons, typeSamples };
}

export function readSample(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
