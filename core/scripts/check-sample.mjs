// Checks that fixtures/sample.json uses only values the types allow, that its ids point at real things, and that it
// is a state the server could produce under the contract (lists and counts, screening, the AI's records and status).
// TypeScript can't check a JSON file against union types, so this does it at run time.
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("../fixtures/sample.json", import.meta.url), "utf8"));
const problems = [];
const need = (ok, message) => {
  if (!ok) problems.push(message);
};
const oneOf = (value, allowed, where) =>
  need(allowed.includes(value), `${where}: "${value}" is not one of ${allowed.join(", ")}`);

const CATEGORIES = ["conversation", "newsletter", "invoice", "receipt", "notification", "otp", "unknown"];
// Home: conversations and what nobody has categorized yet. Notifications have their own tab (the owner's decision of
// 2026-11-19, replacing that of 2026-11-18).
const HOME_CATEGORIES = ["conversation", "unknown"];
const SOURCES = ["ai", "rule", "agent", "person", "mailbox"];
const PROVIDERS = ["imap", "gmail"];
const STACKS = ["reply_later", "set_aside"];
const TRUST = ["suggest", "act_with_undo", "act_silently"];
const ICONS = ["person", "building", "briefcase", "house", "shop", "globe"];
const AI_JOBS = ["categorize", "summarize"];
const AI_STATES = ["not_set_up", "paused", "working", "key_refused", "model_not_found", "out_of_credit", "unavailable"];
const ACTIONS = [
  "categorize", "done", "not_done", "read", "unread", "stack", "unstack",
  "come_back", "cancel_come_back", "allow_sender", "block_sender", "trash",
];
const RULE_ACTIONS = ["categorize", "done", "read", "stack", "allow_sender", "block_sender", "trash"];
const SECRET_KEYS = ["apiKey", "password", "clientSecret", "refreshToken", "token", "secret"];
const DAY = 24 * 60 * 60 * 1000;
const LINE_BREAK_OR_CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]");
const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isTime = (value, where) => need(time.test(value ?? ""), `${where}: "${value}" is not a UTC time`);
const isVersion = (value, where) =>
  need(Number.isInteger(value) && value >= 1, `${where}: version ${value} is not a whole number from 1`);
const isText = (value, where) =>
  need(value === undefined || (typeof value === "string" && value.length > 0), `${where}: not a non-empty string`);
const isCount = (value, where) => need(Number.isInteger(value) && value >= 0, `${where}: ${value} is not a count`);
const sameKeys = (value, keys, where) =>
  need(value !== null && typeof value === "object" && Object.keys(value).sort().join() === [...keys].sort().join(),
    `${where}: has ${Object.keys(value ?? {}).join(", ")}, not exactly ${keys.join(", ")}`);

const inboxIds = new Set(data.inboxes.map((inbox) => inbox.id));
const threadIds = new Set(data.threads.map((thread) => thread.id));
const messageIds = new Set(data.messages.map((message) => message.id));
const ruleIds = new Set(data.rules.map((rule) => rule.id));
const inboxById = new Map(data.inboxes.map((inbox) => [inbox.id, inbox]));
const threadById = new Map(data.threads.map((thread) => [thread.id, thread]));
const ruleById = new Map(data.rules.map((rule) => [rule.id, rule]));
const messagesIn = (threadId) => data.messages.filter((message) => message.threadId === threadId);
const firstIncoming = (threadId) =>
  messagesIn(threadId).filter((message) => !message.outgoing).sort((a, b) => a.date.localeCompare(b.date))[0];
const recordsOf = (threadId) => data.actions.filter((record) => record.threadId === threadId);

const checkAction = (action, where) => {
  oneOf(action.kind, ACTIONS, `${where}.kind`);
  if (action.kind === "categorize") oneOf(action.category, CATEGORIES.filter((c) => c !== "unknown"), `${where}.category`);
  if (action.kind === "stack") oneOf(action.stack, STACKS, `${where}.stack`);
  if (action.kind === "come_back") isTime(action.at, `${where}.at`);
};
const checkActor = (actor, where) => {
  oneOf(actor.kind, ["person", "rule", "agent", "ai", "system"], `${where}.kind`);
  if (actor.kind === "rule") need(ruleIds.has(actor.ruleId), `${where}: no rule ${actor.ruleId}`);
  if (actor.kind === "ai") {
    sameKeys(actor, ["kind", "job", "model"], where);
    oneOf(actor.job, AI_JOBS, `${where}.job`);
    need(typeof actor.model === "string" && actor.model.length > 0, `${where}.model`);
  }
};

// Nothing secret anywhere: no key, password, client secret or token, at any depth.
const scanSecrets = (value, where) => {
  if (Array.isArray(value)) value.forEach((item, index) => scanSecrets(item, `${where}[${index}]`));
  else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      need(!SECRET_KEYS.includes(key), `${where}.${key}: a secret's field in the sample`);
      scanSecrets(inner, `${where}.${key}`);
    }
  }
};
scanSecrets(data, "sample");

// How an inbox is connected, without secrets: exactly these fields, so no password, secret or token can hide in it.
const checkLogin = (login, where) => {
  sameKeys(login, ["host", "port", "secure", "user"], where);
  need(typeof login?.host === "string" && login.host.length > 0, `${where}.host`);
  need(Number.isInteger(login?.port) && login.port >= 1 && login.port <= 65535, `${where}.port`);
  need(typeof login?.secure === "boolean", `${where}.secure`);
  need(typeof login?.user === "string" && login.user.length > 0, `${where}.user`);
};
const checkConnection = (connection, provider, where) => {
  need(connection?.kind === provider, `${where}.kind: "${connection?.kind}" isn't the inbox's provider "${provider}"`);
  if (connection?.kind === "imap") {
    sameKeys(connection, ["kind", "imap", "smtp", "saveSent"], where);
    checkLogin(connection.imap, `${where}.imap`);
    checkLogin(connection.smtp, `${where}.smtp`);
    need(typeof connection.saveSent === "boolean", `${where}.saveSent`);
  } else if (connection?.kind === "gmail") {
    sameKeys(connection, "signIn" in connection ? ["kind", "clientId", "signIn"] : ["kind", "clientId"], where);
    need(typeof connection.clientId === "string" && connection.clientId.length > 0, `${where}.clientId`);
    if ("signIn" in connection) oneOf(connection.signIn, ["google"], `${where}.signIn`);
  }
};

isTime(data.now, "now");
const now = Date.parse(data.now);

// Inboxes: the list is in position order, positions from 0 with no gaps.
data.inboxes.forEach((inbox, index) => {
  const where = `inbox ${inbox.id}`;
  need(inbox.position === index, `${where}: position ${inbox.position}, but it is number ${index} in the list`);
  oneOf(inbox.icon, ICONS, `${where}.icon`);
  oneOf(inbox.provider, PROVIDERS, `${where}.provider`);
  oneOf(inbox.trust, TRUST, `${where}.trust`);
  oneOf(inbox.status, ["connecting", "ok", "needs_attention", "paused"], `${where}.status`);
  // A reason only with needs_attention (docs/contract-sync.md, "When an inbox needs attention").
  if (inbox.statusReason !== undefined) {
    oneOf(inbox.statusReason, ["needs_sign_in", "host_setup", "provider_error", "not_syncing"], `${where}.statusReason`);
    need(inbox.status === "needs_attention", `${where}.statusReason: only with needs_attention`);
  }
  need(/^#[0-9A-F]{6}$/.test(inbox.color), `${where}.color: "${inbox.color}" is not #RRGGBB`);
  need(typeof inbox.guide === "string" && typeof inbox.agentAccess === "boolean", `${where}: guide or agentAccess`);
  // No per-inbox AI switch since 2026-11-17: with AI credentials set, every inbox's mail is processed.
  need(!("aiProcessing" in inbox), `${where}: aiProcessing is gone from the contract`);
  isTime(inbox.createdAt, `${where}.createdAt`);
  isVersion(inbox.version, where);
  checkConnection(inbox.connection, inbox.provider, `${where}.connection`);
  // How far a first sync has got, while it runs: whole numbers, never more fetched than the window holds.
  if (inbox.firstSync !== undefined) {
    sameKeys(inbox.firstSync, ["fetched", "total"], `${where}.firstSync`);
    const { fetched, total } = inbox.firstSync;
    need(Number.isSafeInteger(fetched) && fetched >= 0 && Number.isSafeInteger(total) && total >= fetched, `${where}.firstSync: ${fetched} of ${total}`);
  }
});

// The AI's settings: the connection without the key, one setting per job, and the effective model of each job.
const ai = data.ai;
if (ai.connection !== undefined) {
  if (ai.connection.kind === "gateway") {
    sameKeys(ai.connection, ["kind", "gateway"], "ai.connection");
    oneOf(ai.connection.gateway, ["vercel"], "ai.connection.gateway");
  } else {
    sameKeys(ai.connection, ["kind", "provider"], "ai.connection");
    oneOf(ai.connection.provider, ["openai", "anthropic"], "ai.connection.provider");
  }
}
need(typeof ai.credentialsSet === "boolean", "ai.credentialsSet");
need((ai.connection !== undefined) === ai.credentialsSet, "ai: a connection without credentials, or credentials without one");
need(ai.jobs.map((job) => job.job).join() === AI_JOBS.join(), `ai.jobs: not one per job in order (${AI_JOBS.join(", ")})`);
const modelOf = new Map();
for (const job of ai.jobs) {
  const where = `ai.jobs ${job.job}`;
  sameKeys(job, ["job", "model", "defaultModel"], where);
  need(job.model === null || (typeof job.model === "string" && job.model.length > 0), `${where}.model`);
  need(typeof job.defaultModel === "string" && (job.defaultModel.length > 0) === ai.credentialsSet,
    `${where}.defaultModel: set exactly while a connection is`);
  modelOf.set(job.job, job.model ?? job.defaultModel);
}
// No history setting since 2026-11-18: the AI works through all synced mail; the first sync's window decides how much.
need(!("historyDays" in ai) && !("maxHistoryDays" in ai), "ai: historyDays and maxHistoryDays are gone from the contract");
need(typeof ai.paused === "boolean", "ai.paused");

// The first sync's window: 1 to 36,500 days, where it came from, and whether a person may change it here.
const firstSync = data.firstSync;
sameKeys(firstSync, ["days", "setBy", "changeable"], "firstSync");
need(Number.isInteger(firstSync.days) && firstSync.days >= 1 && firstSync.days <= 36_500, "firstSync.days: not 1 to 36,500");
oneOf(firstSync.setBy, ["environment", "settings", "default"], "firstSync.setBy");
need(typeof firstSync.changeable === "boolean" && !(firstSync.setBy === "environment" && firstSync.changeable),
  "firstSync.changeable: a boolean, and false while the environment sets it");
need(firstSync.setBy !== "default" || firstSync.days === 30, "firstSync: the default is 30 days");

// The AI's usage (GET /v1/ai/usage): since when it is kept, the time zone the periods were cut in, and per period one
// row per job and model, in job order then by model, each counting only what the service reported.
const usage = data.aiUsage;
sameKeys(usage, ["since", "timeZone", "periods"], "aiUsage");
isTime(usage.since, "aiUsage.since");
need(Date.parse(usage.since) <= Date.parse(data.now), "aiUsage.since: after the sample's now");
need(typeof usage.timeZone === "string" && (() => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: usage.timeZone });
    return true;
  } catch {
    return false;
  }
})(), `aiUsage.timeZone: "${usage.timeZone}" is not an IANA time zone`);
sameKeys(usage.periods, ["today", "last7Days", "last30Days"], "aiUsage.periods");
const usageKey = (row) => `${row.job} ${row.model}`;
const tokenCount = (value) => value === null || (Number.isInteger(value) && value >= 0);
for (const [period, rows] of Object.entries(usage.periods)) {
  need(Array.isArray(rows), `aiUsage.periods.${period}: not a list`);
  rows.forEach((row, index) => {
    const where = `aiUsage.periods.${period}[${index}]`;
    sameKeys(row, ["job", "model", "requests", "failed", "inputTokens", "outputTokens", "tokensPartial", "cost", "costPartial"], where);
    oneOf(row.job, AI_JOBS, `${where}.job`);
    need(typeof row.model === "string" && row.model.length > 0, `${where}.model`);
    need(Number.isInteger(row.requests) && row.requests >= 1, `${where}.requests: a row has requests`);
    need(Number.isInteger(row.failed) && row.failed >= 0 && row.failed <= row.requests, `${where}.failed: 0 to requests`);
    need(tokenCount(row.inputTokens) && tokenCount(row.outputTokens), `${where}: tokens are whole numbers or null`);
    need(typeof row.tokensPartial === "boolean" && !(row.tokensPartial && row.inputTokens === null && row.outputTokens === null),
      `${where}.tokensPartial: only with tokens`);
    if (row.cost !== null) {
      sameKeys(row.cost, ["amount", "currency"], `${where}.cost`);
      need(Number.isFinite(row.cost.amount) && row.cost.amount >= 0 && row.cost.currency === "USD", `${where}.cost: an amount in USD`);
    }
    need(typeof row.costPartial === "boolean" && !(row.costPartial && row.cost === null), `${where}.costPartial: only with a cost`);
    // A failed request reports nothing, so tokens or a cost with failures are partial.
    if (row.failed > 0 && (row.inputTokens !== null || row.outputTokens !== null)) need(row.tokensPartial, `${where}: failures, so its tokens are partial`);
    if (row.failed > 0 && row.cost !== null) need(row.costPartial, `${where}: failures, so its cost is partial`);
    if (index > 0) {
      const before = rows[index - 1];
      const order = AI_JOBS.indexOf(before.job) - AI_JOBS.indexOf(row.job) || (before.model < row.model ? -1 : before.model > row.model ? 1 : 0);
      need(order < 0, `${where}: not in job order, then by model`);
    }
  });
}
// A shorter period is inside a longer one: each of its rows is there, with no more of anything.
for (const [inner, outer] of [["today", "last7Days"], ["last7Days", "last30Days"]]) {
  for (const row of usage.periods[inner]) {
    const wider = usage.periods[outer].find((other) => usageKey(other) === usageKey(row));
    need(wider !== undefined, `aiUsage: ${usageKey(row)} is in ${inner} but not in ${outer}`);
    if (!wider) continue;
    need(wider.requests >= row.requests && wider.failed >= row.failed, `aiUsage: ${usageKey(row)} has more in ${inner} than in ${outer}`);
    for (const field of ["inputTokens", "outputTokens"]) {
      if (row[field] !== null) need(wider[field] !== null && wider[field] >= row[field], `aiUsage: ${usageKey(row)}'s ${field} in ${outer}`);
    }
    if (row.cost !== null) need(wider.cost !== null && wider.cost.amount >= row.cost.amount, `aiUsage: ${usageKey(row)}'s cost in ${outer}`);
  }
}
isVersion(ai.version, "ai");

// Sender pictures (docs/contract-avatars.md): the picture route's path, how to draw it, its size; never on a screened
// thread, a thread without a sender, or the inbox's own mail.
const isAvatar = (avatar, where) => {
  sameKeys(avatar, ["picture", "fit", "size"], where);
  need(/^\/v1\/avatars\/[0-9a-f]{32}$/.test(avatar.picture), `${where}.picture: "${avatar.picture}" isn't an avatar path`);
  oneOf(avatar.fit, ["fill", "inset"], `${where}.fit`);
  need(Number.isSafeInteger(avatar.size) && avatar.size >= 16, `${where}.size: not a whole number from 16`);
};

// Threads.
for (const thread of data.threads) {
  const where = `thread ${thread.id}`;
  if (thread.avatar !== undefined) {
    isAvatar(thread.avatar, `${where}.avatar`);
    need(!thread.screened, `${where}: a picture on a screened thread`);
    need(thread.sender !== undefined, `${where}: a picture without a sender`);
  }
  const inbox = inboxById.get(thread.inboxId);
  need(inbox !== undefined, `${where}: no inbox ${thread.inboxId}`);
  oneOf(thread.category, CATEGORIES, `${where}.category`);
  if (thread.categorizedBy !== undefined) oneOf(thread.categorizedBy, SOURCES, `${where}.categorizedBy`);
  // Nobody decides `unknown`, so a decided category always says who decided it. An unknown thread names someone only
  // when a rule or an agent proposed a category, or a person or an agent undid one; never the AI or the mailbox.
  if (thread.category !== "unknown") need(thread.categorizedBy !== undefined, `${where}: a category nobody decided`);
  else need(!["ai", "mailbox"].includes(thread.categorizedBy), `${where}: unknown, decided by ${thread.categorizedBy}`);
  need(typeof thread.screened === "boolean", `${where}.screened`);
  if (thread.stack !== undefined) oneOf(thread.stack, STACKS, `${where}.stack`);
  if (thread.need !== undefined) oneOf(thread.need, ["reply", "decide", "pay", "read"], `${where}.need`);
  if (thread.comeBackAt !== undefined) isTime(thread.comeBackAt, `${where}.comeBackAt`);
  isTime(thread.lastMessageAt, `${where}.lastMessageAt`);
  need(thread.participants.length > 0, `${where}: no participants`);
  need(typeof thread.trashed === "boolean", `${where}.trashed`);
  isVersion(thread.version, where);
  need(!(thread.stack !== undefined && thread.done), `${where}: on a stack and done`);
  const messages = messagesIn(thread.id);
  need(
    messages.length === thread.messageCount,
    `${where}: messageCount is ${thread.messageCount} but the sample has ${messages.length} messages`,
  );
  const newest = messages.map((message) => message.date).sort().at(-1);
  need(newest === thread.lastMessageAt, `${where}: lastMessageAt isn't its newest message's date`);

  // A summary: the AI's, so only while AI credentials are set; plain text, one line, at most 200 characters,
  // without the sender's name.
  if (thread.summary !== undefined) {
    need(data.ai.credentialsSet, `${where}: a summary without AI credentials`);
    need(typeof thread.summary === "string" && thread.summary.length > 0 && thread.summary.length <= 200,
      `${where}.summary: not 1 to 200 characters`);
    need(!LINE_BREAK_OR_CONTROL.test(thread.summary), `${where}.summary: a line break or control character`);
    const sender = firstIncoming(thread.id)?.from.name;
    if (sender) need(!thread.summary.includes(sender), `${where}.summary: names the sender "${sender}"`);
  }

  // A receipt's or an invoice's details: only on those, only from the AI (credentials set), each fact as the server
  // keeps it after its checks, and the summary is the details' `what`.
  if (thread.payment !== undefined) {
    const payment = thread.payment;
    need(["receipt", "invoice"].includes(thread.category), `${where}.payment: on a ${thread.category} thread`);
    need(data.ai.credentialsSet, `${where}: payment details without AI credentials`);
    sameKeys(payment, ["party", "amount", "refund", "state", "dueDate", "what"], `${where}.payment`);
    need(payment.state === null || ["paid", "scheduled", "due"].includes(payment.state), `${where}.payment.state: not paid, scheduled, due or null`);
    need(!payment.refund || payment.state === "paid", `${where}.payment: a refund that isn't paid`);
    // A date only while money is still to move: never when paid, or on a receipt whose state is unknown.
    const effective = payment.state ?? (thread.category === "invoice" ? "due" : "paid");
    need(payment.dueDate === null || effective !== "paid", `${where}.payment.dueDate: a date on what is paid`);
    for (const [field, limit] of [["party", 60], ["what", 100]]) {
      const text = payment[field];
      need(text === null || (typeof text === "string" && text.length > 0 && text.length <= limit
        && !LINE_BREAK_OR_CONTROL.test(text) && !/[<>@]/.test(text)), `${where}.payment.${field}: not null or 1 to ${limit} plain characters`);
    }
    if (payment.amount !== null) {
      sameKeys(payment.amount, ["minor", "currency"], `${where}.payment.amount`);
      need(Number.isSafeInteger(payment.amount.minor) && payment.amount.minor >= 0, `${where}.payment.amount.minor: not a whole number from 0`);
      need(/^[A-Z]{3}$/.test(payment.amount.currency), `${where}.payment.amount.currency: not an ISO 4217 code`);
    }
    need(typeof payment.refund === "boolean", `${where}.payment.refund: not true or false`);
    need(payment.dueDate === null || (/^\d{4}-\d{2}-\d{2}$/.test(payment.dueDate)
      && new Date(`${payment.dueDate}T00:00:00Z`).toISOString().startsWith(payment.dueDate)), `${where}.payment.dueDate: not a calendar date`);
    need(thread.summary === (payment.what ?? undefined), `${where}: the summary isn't payment.what`);
  }

  // A notification's event: only on a notification, only from the AI, each fact as the server keeps it.
  if (thread.event !== undefined) {
    const event = thread.event;
    need(thread.category === "notification", `${where}.event: on a ${thread.category} thread`);
    need(data.ai.credentialsSet, `${where}: an event without AI credentials`);
    sameKeys(event, "group" in event ? ["status", "about", "when", "group"] : ["status", "about", "when"], `${where}.event`);
    // A group is opaque: threads that share one are notifications of one inbox about the same thing.
    if ("group" in event) {
      need(event.group === null || (typeof event.group === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(event.group)), `${where}.event.group: not null or an opaque string`);
      for (const other of data.threads) {
        if (other.id !== thread.id && other.event?.group != null && other.event.group === event.group) {
          need(other.inboxId === thread.inboxId, `${where}.event.group: shared with ${other.id} of another inbox`);
        }
      }
    }
    for (const [field, limit] of [["status", 40], ["about", 80]]) {
      const text = event[field];
      need(text === null || (typeof text === "string" && text.length > 0 && text.length <= limit
        && !LINE_BREAK_OR_CONTROL.test(text) && !/[<>@]/.test(text)), `${where}.event.${field}: not null or 1 to ${limit} plain characters`);
    }
    if (event.when !== null) {
      sameKeys(event.when, ["date", "time", "endTime"], `${where}.event.when`);
      need(/^\d{4}-\d{2}-\d{2}$/.test(event.when.date) && new Date(`${event.when.date}T00:00:00Z`).toISOString().startsWith(event.when.date),
        `${where}.event.when.date: not a calendar date`);
      const clock = (time) => time === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
      need(clock(event.when.time) && clock(event.when.endTime), `${where}.event.when: a time that isn't HH:MM`);
      need(event.when.endTime === null || (event.when.time !== null && event.when.endTime > event.when.time), `${where}.event.when: an end without a start before it`);
    }
  }

  // A one-time code is never summarized. It is held at the screening gate only when the mailbox filed it under
  // Screening, or when the AI called it a code and the server's own check didn't hold (machine-sent, with a code).
  if (thread.category === "otp") {
    need(thread.summary === undefined, `${where}: a one-time code with a summary`);
    if (!["mailbox", "ai"].includes(thread.categorizedBy)) need(!thread.screened, `${where}: a one-time code held back by screening`);
  }

  // The thread's sender: the sender of its oldest message someone else sent, lower case; absent when it holds only the
  // mailbox's own mail.
  const oldest = firstIncoming(thread.id);
  need(thread.sender === oldest?.from.email.toLowerCase(),
    `${where}.sender is "${thread.sender}", but its oldest incoming message is from "${oldest?.from.email}"`);

  // Who decided, by name: an actor of the kind `categorizedBy` names, for every source but the mailbox.
  if (thread.categorizedByActor !== undefined) {
    checkActor(thread.categorizedByActor, `${where}.categorizedByActor`);
    need(["ai", "rule", "agent", "person"].includes(thread.categorizedBy) && thread.categorizedByActor.kind === thread.categorizedBy,
      `${where}: categorizedByActor is ${thread.categorizedByActor.kind}, but categorizedBy is ${thread.categorizedBy}`);
  } else {
    need(thread.categorizedBy === undefined || thread.categorizedBy === "mailbox",
      `${where}: categorized by ${thread.categorizedBy} without categorizedByActor`);
  }

  // Who decided the category: the AI's or a rule's newest applied categorize record names this category. A person,
  // an agent (a decision that changed nothing records nothing) and the mailbox need no record.
  const categorized = recordsOf(thread.id)
    .filter((record) => record.action.kind === "categorize" && record.state === "applied")
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  // The AI never takes a conversation out of Home by itself: no AI record files a thread elsewhere after anyone made
  // it a conversation.
  categorized.forEach((record, index) => {
    if (record.actor.kind !== "ai" || record.action.category === "conversation") return;
    need(!categorized.slice(0, index).some((earlier) => earlier.action.category === "conversation"),
      `${where}: ${record.id} has the AI take a conversation out of Home`);
  });
  if (thread.categorizedBy === "ai" || thread.categorizedBy === "rule") {
    const latest = categorized.at(-1);
    need(latest?.actor.kind === thread.categorizedBy && latest?.action.category === thread.category,
      `${where}: categorized by ${thread.categorizedBy}, but its newest applied categorize record says otherwise`);
    need(JSON.stringify(latest?.actor) === JSON.stringify(thread.categorizedByActor),
      `${where}: categorizedByActor isn't the actor of its newest applied categorize record`);
  }
}

for (const message of data.messages) {
  const where = `message ${message.id}`;
  need(threadIds.has(message.threadId), `${where}: no thread ${message.threadId}`);
  if (message.avatar !== undefined) {
    isAvatar(message.avatar, `${where}.avatar`);
    need(!message.outgoing, `${where}: a picture on the inbox's own mail`);
    const thread = threadById.get(message.threadId);
    need(!thread?.screened, `${where}: a picture in a screened thread`);
    // The thread's sender's own message shows the thread's picture.
    if (thread?.avatar && message.from.email === thread.sender) need(message.avatar.picture === thread.avatar.picture, `${where}: not its thread's picture`);
  }
  need(inboxIds.has(message.inboxId), `${where}: no inbox ${message.inboxId}`);
  isTime(message.date, `${where}.date`);
  for (const list of ["to", "cc", "bcc", "attachments"]) need(Array.isArray(message[list]), `${where}.${list}`);
  if (message.listId !== undefined) {
    need(/^[^<>\s]+$/.test(message.listId) && message.listId === message.listId.toLowerCase(),
      `${where}.listId: "${message.listId}" isn't a list id in lower case without angle brackets`);
  }
  for (const attachment of message.attachments) {
    if (attachment.contentId === undefined) continue;
    need(/^[^<>\s]+$/.test(attachment.contentId), `${where}: contentId "${attachment.contentId}" has angle brackets`);
    if (attachment.inline && message.html) {
      need(message.html.includes(`cid:${attachment.contentId}`), `${where}: no cid:${attachment.contentId} in HTML`);
    }
  }
}

for (const draft of data.drafts) {
  const where = `draft ${draft.id}`;
  need(inboxIds.has(draft.inboxId), `${where}: no inbox ${draft.inboxId}`);
  if (draft.threadId) need(threadIds.has(draft.threadId), `${where}: no thread ${draft.threadId}`);
  if (draft.inReplyToMessageId) need(messageIds.has(draft.inReplyToMessageId), `${where}: no message`);
  oneOf(draft.state, ["draft", "sending", "sent", "failed"], `${where}.state`);
  checkActor(draft.createdBy, `${where}.createdBy`);
  isVersion(draft.version, where);
  isText(draft.note, `${where}.note`);
  // A note comes with a send that worked.
  if (draft.note !== undefined) need(draft.state === "sent", `${where}: a note on a draft that wasn't sent`);
  // A sent draft is kept only with a note, for a day after it was sent, so its thread can show the note.
  if (draft.state === "sent") {
    need(draft.note !== undefined, `${where}: a sent draft without a note isn't kept`);
    const age = now - Date.parse(draft.updatedAt);
    need(age >= 0 && age < DAY, `${where}: a sent draft is kept for a day only`);
  }
}

for (const record of data.actions) {
  const where = `action ${record.id}`;
  need(threadIds.has(record.threadId), `${where}: no thread ${record.threadId}`);
  need(threadById.get(record.threadId)?.inboxId === record.inboxId, `${where}: its thread is in another inbox`);
  oneOf(record.state, ["proposed", "applied", "undone", "rejected", "failed"], `${where}.state`);
  checkAction(record.action, `${where}.action`);
  checkActor(record.actor, `${where}.actor`);
  isTime(record.at, `${where}.at`);
  need(typeof record.undoable === "boolean", `${where}.undoable`);
  isVersion(record.version, where);
  need(typeof record.silent === "boolean", `${where}.silent`);
  isText(record.note, `${where}.note`);
  // A note comes with a write-back that worked.
  if (record.note !== undefined) {
    need(record.state === "applied" || record.state === "undone", `${where}: a note on a record never written back`);
  }
  const clean = record.state !== "failed" && record.error === undefined && record.note === undefined;
  if (record.actor.kind === "ai") {
    // The server's AI always applies, isn't governed by trust, and is silent unless something went wrong. Only
    // categorizing is recorded, with the model that job used.
    need(!["proposed", "rejected"].includes(record.state), `${where}: the AI's record is ${record.state}`);
    need(record.action.kind === "categorize" && record.actor.job === "categorize",
      `${where}: the AI records only categorizing`);
    need(record.silent === clean, `${where}: silent should be ${clean}`);
    need(record.actor.model === modelOf.get(record.actor.job),
      `${where}: model ${record.actor.model} isn't the ${record.actor.job} job's model`);
    need(record.reason === undefined, `${where}: the AI gives no reason`);
    continue;
  }
  // A rule a person taught always applies, whatever the inbox's trust: it is the person's own instruction, so it never
  // proposes (trash and block_sender included). Agents and rules an agent made stay under the trust table.
  const rule = record.actor.kind === "rule" ? ruleById.get(record.actor.ruleId) : undefined;
  const taught = rule !== undefined && rule.source !== "agent";
  if (taught) need(!["proposed", "rejected"].includes(record.state), `${where}: a rule the person taught only proposed`);
  // Silent: what a rule or an agent applied alone and cleanly in an "act_silently" inbox. Proposals and a
  // person's own actions never are, and silence never hides trouble: a record that failed, whose undo was
  // refused or that carries a note isn't silent. No inbox in the sample has changed its trust, so the rule holds
  // both ways here.
  const byRuleOrAgent = record.actor.kind === "rule" || record.actor.kind === "agent";
  const appliedAlone = byRuleOrAgent && !["proposed", "rejected"].includes(record.state)
    && (taught || !["trash", "block_sender"].includes(record.action.kind));
  const silent = appliedAlone && clean && inboxById.get(record.inboxId)?.trust === "act_silently";
  need(record.silent === silent, `${where}: silent should be ${silent}`);
  // A record a rule made is on a thread whose first incoming message the rule matches (`automated` can't be
  // checked: a message doesn't say whether a machine sent it).
  const first = firstIncoming(record.threadId);
  if (rule && first) {
    const { match } = rule;
    const from = first.from.email.toLowerCase();
    const domain = from.split("@")[1] ?? "";
    const matches = (match.from === undefined || match.from === from)
      && (match.domain === undefined || domain === match.domain || domain.endsWith(`.${match.domain}`))
      && (match.listId === undefined || match.listId === first.listId)
      && (match.subjectContains === undefined
        || first.subject.toLowerCase().includes(match.subjectContains.toLowerCase()))
      && (match.to === undefined || first.to.some((address) => address.email.toLowerCase() === match.to));
    need(matches, `${where}: rule ${rule.id} doesn't match ${first.id}`);
    need(rule.inboxId === record.inboxId, `${where}: rule ${rule.id} is another inbox's`);
  }
}

for (const rule of data.rules) {
  const where = `rule ${rule.id}`;
  need(inboxIds.has(rule.inboxId), `${where}: no inbox ${rule.inboxId}`);
  oneOf(rule.source, ["person", "correction", "agent"], `${where}.source`);
  rule.then.forEach((action, index) => {
    checkAction(action, `${where}.then[${index}]`);
    oneOf(action.kind, RULE_ACTIONS, `${where}.then[${index}].kind`);
  });
  need(Object.keys(rule.match).length > 0, `${where}: empty match`);
  isVersion(rule.version, where);
  isTime(rule.createdAt, `${where}.createdAt`);
  // Sorting mail raises the version with the hits, so a rule that has sorted anything has changed since it was made.
  if (rule.hits > 0) need(rule.version > 1, `${where}: ${rule.hits} hits but still version 1`);
  checkActor(rule.createdBy, `${where}.createdBy`);
  // An agent's rule says which agent; a rule a person made or taught says which device.
  need((rule.source === "agent") === (rule.createdBy?.kind === "agent"), `${where}: source ${rule.source} made by ${rule.createdBy?.kind}`);
  if (rule.source !== "agent") need(rule.createdBy?.kind === "person", `${where}: a ${rule.source} rule made by ${rule.createdBy?.kind}`);
}

for (const section of data.brief.sections) {
  need(inboxIds.has(section.inboxId), `brief: no inbox ${section.inboxId}`);
  for (const key of Object.keys(section.counts)) oneOf(key, [...CATEGORIES, "done", "trash"], `brief ${section.inboxId} counts`);
  // The server drops sections for inboxes the writer can't see; an agent sees none whose agentAccess is off.
  if (data.brief.writtenBy.kind === "agent") {
    need(inboxById.get(section.inboxId)?.agentAccess === true, `brief: an agent wrote ${section.inboxId}'s section`);
  }
  for (const highlight of section.highlights) {
    const thread = threadById.get(highlight.threadId);
    need(thread !== undefined, `brief: no thread ${highlight.threadId}`);
    need(thread?.inboxId === section.inboxId, `brief: ${highlight.threadId} isn't in ${section.inboxId}`);
    need(highlight.subject === thread?.subject, `brief: ${highlight.threadId}'s subject isn't its thread's`);
  }
  // Silent records don't count. In an act_silently inbox only approved proposals could, and where the period
  // has none, the counts are empty.
  const silentInbox = inboxById.get(section.inboxId)?.trust === "act_silently";
  const counted = data.actions.some((record) => record.inboxId === section.inboxId && !record.silent
    && record.state === "applied" && (record.actor.kind === "rule" || record.actor.kind === "agent")
    && record.at >= data.brief.from && record.at <= data.brief.to);
  if (silentInbox && !counted) {
    need(Object.keys(section.counts).length === 0, `brief: ${section.inboxId} counts what only silent records did`);
  }
}
checkActor(data.brief.writtenBy, "brief.writtenBy");

// Screening: a thread is screened while its sender isn't let in. Mail the inbox sent to someone lets them in, so do
// allow_sender and writing in a thread that isn't screened, so a screened thread's sender has done none of these.
for (const thread of data.threads.filter((t) => t.screened)) {
  const sender = firstIncoming(thread.id)?.from.email.toLowerCase();
  const sentTo = data.messages.some((message) => message.inboxId === thread.inboxId && message.outgoing
    && [...message.to, ...message.cc, ...message.bcc].some((address) => address.email.toLowerCase() === sender));
  const allowed = data.actions.some((record) => record.inboxId === thread.inboxId && record.state === "applied"
    && record.action.kind === "allow_sender" && firstIncoming(record.threadId)?.from.email.toLowerCase() === sender);
  const wroteIn = data.messages.some((message) => message.inboxId === thread.inboxId && !message.outgoing
    && message.from.email.toLowerCase() === sender && threadById.get(message.threadId)?.screened === false
    && messagesIn(message.threadId).some((other) => other.date < message.date));
  need(sender !== undefined && !sentTo && !allowed && !wroteIn, `thread ${thread.id}: screened, but its sender was let in`);
}

// The AI's status: its state follows the settings, and `pending` counts what it would process now: threads not done
// or trashed, however old (history is all synced mail), that need a category or a summary.
const status = data.aiStatus;
oneOf(status.state, AI_STATES, "aiStatus.state");
need((status.state === "not_set_up") === !ai.credentialsSet, "aiStatus: not_set_up exactly while no credentials are set");
if (ai.credentialsSet) need((status.state === "paused") === ai.paused, "aiStatus: paused exactly while the settings say so");
need((status.job !== undefined) === (status.state === "model_not_found"), "aiStatus.job: only with model_not_found");
if (status.job !== undefined) oneOf(status.job, AI_JOBS, "aiStatus.job");
if (status.lastRunAt !== undefined) isTime(status.lastRunAt, "aiStatus.lastRunAt");
isText(status.detail, "aiStatus.detail");
isVersion(status.version, "aiStatus");
// Every synced thread that isn't done counts, however old. A one-time code needs no summary; a receipt or an
// invoice needs its details until it has them.
const needsWork = (thread) => ai.credentialsSet && !thread.done && !thread.trashed
  && ((thread.category === "unknown" && thread.categorizedBy === undefined)
    || (thread.summary === undefined && thread.category !== "otp")
    || (["receipt", "invoice"].includes(thread.category) && thread.payment === undefined)
    || (thread.category === "notification" && thread.event === undefined));
const pending = data.threads.filter(needsWork);
need(status.pending === pending.length,
  `aiStatus.pending is ${status.pending}, but ${pending.length} threads wait (${pending.map((t) => t.id).join(", ")})`);
need(!("beyondHistory" in status), "aiStatus.beyondHistory is gone from the contract");

// Counts: each is the length of its list, per inbox in the inbox list's order, and `all` is their sum. Every list but
// search and the screening list leaves out screened threads, and every list leaves out trashed ones.
const waiting = (thread) => thread.comeBackAt !== undefined && Date.parse(thread.comeBackAt) > now;
const countsOf = (threads) => {
  const live = threads.filter((thread) => !thread.trashed);
  const listed = live.filter((thread) => !thread.screened && !thread.done);
  const home = listed.filter((thread) => HOME_CATEGORIES.includes(thread.category)
    && thread.stack === undefined && !waiting(thread));
  return {
    home: home.length,
    unread: home.filter((thread) => thread.unread).length,
    // A waiting thread is out of sight until it comes back (the owner's decision of 2026-11-20): not in its category's list.
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, listed.filter((thread) => thread.category === c && !waiting(thread)).length])),
    stacks: Object.fromEntries(STACKS.map((s) => [s, live.filter((thread) => !thread.screened && thread.stack === s).length])),
    waiting: listed.filter(waiting).length,
    screened: live.filter((thread) => thread.screened && !thread.done).length,
  };
};
const checkCounts = (given, expected, where) => {
  const keys = ["home", "unread", "categories", "stacks", "waiting", "screened"];
  sameKeys(Object.fromEntries(Object.entries(given ?? {}).filter(([key]) => key !== "inboxId")), keys, where);
  sameKeys(given?.categories, CATEGORIES, `${where}.categories`);
  sameKeys(given?.stacks, STACKS, `${where}.stacks`);
  for (const key of keys) {
    if (typeof expected[key] === "number") {
      isCount(given?.[key], `${where}.${key}`);
      need(given?.[key] === expected[key], `${where}.${key} is ${given?.[key]}, but the list holds ${expected[key]}`);
    } else {
      for (const [inner, value] of Object.entries(expected[key])) {
        need(given?.[key]?.[inner] === value, `${where}.${key}.${inner} is ${given?.[key]?.[inner]}, but the list holds ${value}`);
      }
    }
  }
};
need(data.counts.inboxes.map((entry) => entry.inboxId).join() === data.inboxes.map((inbox) => inbox.id).join(),
  "counts.inboxes: not one per inbox in the inbox list's order");
for (const entry of data.counts.inboxes) {
  checkCounts(entry, countsOf(data.threads.filter((thread) => thread.inboxId === entry.inboxId)), `counts ${entry.inboxId}`);
}
checkCounts(data.counts.all, countsOf(data.threads), "counts.all");
isVersion(data.counts.version, "counts");

// Blocked senders: what `GET /v1/senders?state=blocked` answers, the newest block first. Each is blocked by an applied
// `block_sender` record on a thread of theirs (whose actor is `blockedBy`, at `blockedAt`), their threads are done, and
// the count is the stored messages from that address in that inbox dated after the block.
need(Array.isArray(data.blockedSenders), "blockedSenders: missing");
const blockedList = data.blockedSenders ?? [];
for (const [i, sender] of blockedList.entries()) {
  const where = `blockedSenders[${i}]`;
  const allowed = ["inboxId", "address", "name", "blockedAt", "blockedBy", "messagesSinceBlocked", "lastMessageAt"];
  for (const key of Object.keys(sender)) oneOf(key, allowed, `${where} keys`);
  need(inboxById.has(sender.inboxId), `${where}: no inbox ${sender.inboxId}`);
  need(typeof sender.address === "string" && /^[^@\s]+@[^@\s]+$/.test(sender.address) && sender.address === sender.address.toLowerCase(),
    `${where}.address: not a lower-case address`);
  need(blockedList.filter((other) => other.inboxId === sender.inboxId && other.address === sender.address).length === 1, `${where}: listed twice`);
  isTime(sender.blockedAt, `${where}.blockedAt`);
  const mail = data.messages.filter((message) => message.inboxId === sender.inboxId && !message.outgoing
    && message.from.email.toLowerCase() === sender.address).sort((a, b) => a.date.localeCompare(b.date));
  const since = mail.filter((message) => message.date > sender.blockedAt).length;
  need(sender.messagesSinceBlocked === since, `${where}.messagesSinceBlocked is ${sender.messagesSinceBlocked}, but ${since} messages came after the block`);
  need(sender.lastMessageAt === (mail.at(-1)?.date ?? null), `${where}.lastMessageAt: not their newest mail's date`);
  const named = [...mail].reverse().find((message) => message.from.name)?.from.name;
  need(sender.name === named, `${where}.name: not the name their newest mail gives`);
  const blocks = data.actions.filter((record) => record.inboxId === sender.inboxId && record.state === "applied"
    && record.action.kind === "block_sender" && threadById.get(record.threadId)?.sender === sender.address);
  const block = blocks.sort((a, b) => b.at.localeCompare(a.at))[0];
  need(block !== undefined, `${where}: no applied block_sender record on a thread of theirs`);
  need(block === undefined || block.at === sender.blockedAt, `${where}.blockedAt: not when ${block?.id} blocked them`);
  need(block === undefined || JSON.stringify(block.actor) === JSON.stringify(sender.blockedBy), `${where}.blockedBy: not ${block?.id}'s actor`);
  for (const thread of data.threads.filter((t) => t.inboxId === sender.inboxId && t.sender === sender.address)) {
    need(thread.done, `${where}: their thread ${thread.id} isn't done`);
  }
  if (i > 0) need(blockedList[i - 1].blockedAt >= sender.blockedAt, `${where}: not the newest block first`);
}
// Nobody is blocked without being listed: every applied block_sender record's sender is in the list.
for (const record of data.actions.filter((r) => r.state === "applied" && r.action.kind === "block_sender")) {
  const address = threadById.get(record.threadId)?.sender;
  need(blockedList.some((sender) => sender.inboxId === record.inboxId && sender.address === address), `${record.id}: blocks ${address}, who isn't in blockedSenders`);
}

// Older mail: what a Gmail inbox's mailbox holds from before its first sync's window, which the server doesn't hold.
need(Array.isArray(data.olderMail), "olderMail: missing");
for (const [i, mail] of (data.olderMail ?? []).entries()) {
  const where = `olderMail[${i}]`;
  const inbox = inboxById.get(mail.inboxId);
  need(inbox?.provider === "gmail", `${where}: not in a Gmail inbox (only Gmail searches its mailbox)`);
  isTime(mail.date, `${where}.date`);
  if (inbox) {
    const windowStart = Date.parse(inbox.createdAt) - firstSync.days * DAY;
    need(Date.parse(mail.date) < windowStart, `${where}: inside the first sync's window, so the server would hold it`);
  }
  need(!threadIds.has(mail.threadKey), `${where}.threadKey: a thread the server holds`);
  for (const address of [mail.from, ...mail.to]) need(/\.example$/.test(address.email), `${where}: ${address.email} isn't made up`);
  need(typeof mail.archived === "boolean" && typeof mail.text === "string" && mail.text.length > 0, `${where}: archived and text`);
}

// Searches asked in a sentence: each answer is a search that can be run, in the shape a search echoes.
need(Array.isArray(data.searchAsks) && data.searchAsks.length > 0, "searchAsks: missing");
const ASK_KINDS = new Set(["conversation", "newsletter", "invoice", "receipt", "notification", "otp", "unknown", "screened", "done"]);
const ASK_AI_STATES = new Set(["not_set_up", "paused", "working", "key_refused", "model_not_found", "out_of_credit", "unavailable"]);
const UNDERSTOOD_FIELDS = new Set(["inboxIds", "kinds", "from", "to", "subject", "hasAttachment", "after", "before", "unread", "text", "exclude"]);
for (const [i, asked] of (data.searchAsks ?? []).entries()) {
  const where = `searchAsks[${i}]`;
  const answer = asked.answer ?? {};
  const understood = answer.understood ?? {};
  need(typeof asked.question === "string" && asked.question.length > 0 && asked.question.length <= 200, `${where}.question: 1 to 200 characters`);
  need(typeof asked.tz === "string" && asked.tz.length > 0, `${where}.tz: missing`);
  need(Object.keys(answer).every((key) => ["understood", "text", "found", "ai", "detail"].includes(key)), `${where}.answer: a field the contract doesn't name`);
  need(Object.keys(understood).every((key) => UNDERSTOOD_FIELDS.has(key)), `${where}.answer.understood: a field the contract doesn't name`);
  need(typeof understood.text === "string" && typeof answer.text === "string", `${where}: text and understood.text`);
  need((understood.kinds ?? []).every((kind) => ASK_KINDS.has(kind)), `${where}.answer.understood.kinds: not a kind`);
  for (const key of ["after", "before"]) if (understood[key] !== undefined) isTime(understood[key], `${where}.answer.understood.${key}`);
  for (const key of ["hasAttachment", "unread"]) need(understood[key] === undefined || typeof understood[key] === "boolean", `${where}.answer.understood.${key}: not true or false`);
  need(ASK_AI_STATES.has(answer.ai), `${where}.answer.ai: not an AI state`);
  const { text: _text, inboxIds: _inboxIds, ...filters } = understood;
  need(answer.found === Object.keys(filters).length > 0, `${where}.answer.found: true exactly when a filter or an excluded word was found`);
  const typed = [understood.text, ...(understood.exclude ?? []).map((word) => `-${word}`)].filter(Boolean).join(" ");
  need(answer.text === typed, `${where}.answer.text: the free text, then each excluded word with its minus`);
  // Every word kept is one the sentence holds: nothing invented.
  const said = new Set(asked.question.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  for (const value of [understood.text, understood.from, understood.to, understood.subject, ...(understood.exclude ?? [])]) {
    for (const word of String(value ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) need(said.has(word), `${where}: "${word}" isn't in the sentence`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `sample.json is consistent: ${data.inboxes.length} inboxes, ${data.threads.length} threads, ` +
    `${data.messages.length} messages, ${data.drafts.length} drafts, ${data.actions.length} actions, ` +
    `${data.rules.length} rules; AI ${status.state}, ${status.pending} pending, first sync ${firstSync.days} days, ` +
    `${usage.periods.last30Days.reduce((sum, row) => sum + row.requests, 0)} AI requests in 30 days; ` +
    `Home ${data.counts.all.home}; ${blockedList.length} blocked senders; ${new Set(data.olderMail.map((m) => m.threadKey)).size} older conversations in the mailbox; ${data.searchAsks.length} searches asked in a sentence.`,
);
