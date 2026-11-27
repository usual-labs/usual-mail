// Working through unsubscribes in the background (docs/contract.md, "Unsubscribing"), apart from the request that
// asked, as the AI's cost lookups are (ai/costs.ts): what waits is in the store, so a restart carries on with it.
//
// Only proved mail is used (the security reviews of 2026-11-27): a Gmail inbox, whose checker the server trusts
// (`trustsChecker`), and a message from the sender that the checker proved from exactly the From address's domain with a
// DKIM signature of its organisation, as the let-in rules ask (`provedOwnSender`), and that the signature says was sent
// to this inbox (a signed To or Cc naming its address, aliases included, as the screening gate reads it: `addressedTo`),
// so another recipient's unsubscribe, forwarded here, is never used. Of those, the thread asked from first, newest
// first, the first whose signed List-Unsubscribe offers a way gives them all (`ways.ts`, `headerWays`); no link in a
// body is ever used. Otherwise nothing at all is tried: the sender stays blocked, and the words say why it couldn't be
// done (`UNPROVED`): an IMAP inbox, mail not proved, mail not sent to this inbox, or mail stored before 0.1.5, which
// carries no reading of its signed headers.
//
// A new one (`start`) tries those ways cheapest first: the one-click POST (only a 2xx answer is a yes; a redirect isn't
// followed and counts as no), else an email from the inbox to the header's address, else the page: given to the
// person's browser agent when one is set up (`agent`, read every few seconds until its run ends, at most ten minutes
// and the cost cap), or handed to the person (`needs_person` with the page). Before an email is sent or a run started,
// that is written down (`tried`), so a server stopped mid-way never sends a second email or starts a second run: it
// stops the run it may have started, found by its marker, and says what it can't know.

import { base64url } from "../util.ts";
import { and, asc, desc, eq, isNotNull, lte, min, sql } from "drizzle-orm";
import { trustsChecker } from "../ai/gate.ts";
import { addressedTo } from "../ai/gate-shape.ts";
import { loadState } from "../ai/state.ts";
import { inboxes, messages, unsubscribes, type InboxRow, type UnsubscribeRow } from "../db/index.ts";
import type { Address } from "@usualmail/core";
import { PictureRefused } from "../pictures/refused.ts";
import type { Ctx } from "../service/context.ts";
import { openBrowserAgent, recordBrowserAgent } from "./agent.ts";
import { BrowserAgentError, MOST_COST_USD } from "./browser-use.ts";
import { emitUnsubscribe } from "./requests.ts";
import { headerWays, type SignedPart, type WayOptions, type Ways } from "./ways.ts";

/** How often a browser agent's run is read while it goes on. */
export const AGENT_POLL_MS = 5_000;
/** How long a browser agent's run may take before it is stopped and the page handed to the person. */
export const AGENT_LIMIT_MS = 10 * 60_000;
/** The pause before asking Browser Use again when it couldn't be reached or was busy. */
const AGENT_RETRY_MS = 30_000;
/** How many of the sender's newest messages are read for the ways their mail offers. */
const MESSAGES_READ = 20;
/** How many unsubscribes one round works on, so a stop never waits long. */
const BATCH = 10;
/** Timers longer than this are re-armed, as the cost lookups' are. */
const MAX_TIMER_MS = 6 * 60 * 60_000;

/** What a row becomes next: its new fields (`state` and the rest), written and told together. */
type Next = Partial<Omit<UnsubscribeRow, "inboxId" | "address" | "askedAt" | "version">>;

/** The words when nothing may be used, and why. */
export const UNPROVED = {
  inbox: "Only Gmail's own check can prove who sent a mail, so Usual Mail couldn't unsubscribe automatically here. They stay blocked, so their mail stays out of sight.",
  mail: "Their mail isn't proved to come from them, so Usual Mail couldn't unsubscribe automatically. They stay blocked, so their mail stays out of sight.",
  forwarded: "Their mail here wasn't proved to be sent to this inbox's address (it may be someone else's, sent on), so Usual Mail couldn't unsubscribe automatically. They stay blocked.",
  old: "Their mail here arrived before unsubscribing was possible, so it couldn't be proved to come from them. They're blocked; the next time they write, unsubscribing will work.",
};

export class Unsubscribes {
  readonly #ctx: Ctx;
  readonly #track: (work: Promise<unknown>) => void;
  #started = false;
  #running = false;
  #again = false;
  #timer: (() => void) | null = null;

  constructor(ctx: Ctx, track: (work: Promise<unknown>) => void) {
    this.#ctx = ctx;
    this.#track = track;
  }

  /** Starts with whatever waited when the server stopped. */
  start(): void {
    this.#started = true;
    this.wake();
  }

  stop(): void {
    this.#started = false;
    this.#timer?.();
    this.#timer = null;
  }

  wake(): void {
    if (!this.#started) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    this.#track(this.#loop());
  }

  async #loop(): Promise<void> {
    try {
      do {
        this.#again = false;
        await this.#round();
      } while (this.#again && this.#started);
    } finally {
      this.#running = false;
    }
  }

  async #round(): Promise<void> {
    const ctx = this.#ctx;
    const due = await ctx.db.select().from(unsubscribes)
      .where(and(eq(unsubscribes.state, "working"), isNotNull(unsubscribes.nextAt), lte(unsubscribes.nextAt, ctx.now())))
      .orderBy(asc(unsubscribes.nextAt)).limit(BATCH);
    for (const row of due) {
      if (!this.#started) return;
      let next: Next;
      try {
        next = row.step === "agent" ? await this.#agent(row) : await this.#begin(row);
      } catch (error) {
        // Something this code didn't expect: said once, never left working for ever.
        ctx.host.log.error("Unsubscribing failed in an unexpected way", error);
        next = done("failed", { detail: "Unsubscribing failed in an unexpected way. They stay blocked." });
      }
      await this.#save(row, next);
    }
    if (due.length === BATCH) this.#again = true;
    const soonest = await ctx.db.select({ at: min(unsubscribes.nextAt) }).from(unsubscribes).where(eq(unsubscribes.state, "working")).get();
    this.#arm(soonest?.at ?? null);
  }

  /** The first try: the ways the sender's proved mail offers, cheapest first. */
  async #begin(row: UnsubscribeRow): Promise<Next> {
    const ctx = this.#ctx;
    const inbox = await ctx.db.select().from(inboxes).where(eq(inboxes.id, row.inboxId)).get();
    if (!inbox) return done("failed", { detail: "The inbox is gone." });
    const found = await waysOf(ctx, row, inbox);
    if (row.tried.includes("browser_agent")) {
      // Stopped between writing that a run would start and keeping its id: before anything else, stop any run it
      // started, found by its marker, and hand the page over.
      const agent = await openBrowserAgent(ctx, await loadState(ctx));
      const stopped = agent !== null && row.marker !== null && await agent.cancelMarked(row.marker);
      const page = found.unproved ? undefined : found.ways.page;
      // Only what is known: the stop taken, or only asked for (no run found, or Browser Use not answering).
      const why = stopped
        ? "The server stopped while Browser Use was starting, so its run was stopped."
        : "The server stopped while Browser Use was starting, so it asked Browser Use to stop any run it had begun.";
      return page
        ? done("needs_person", { way: "page", url: page, detail: `${why} Open their page to finish.` })
        : done("failed", { detail: `${why} They stay blocked.` });
    }
    if (found.unproved) return done("failed", { detail: UNPROVED[found.unproved] });
    const ways = found.ways;
    const failures: string[] = [];
    if (ways.oneClick && ctx.host.oneClick) {
      try {
        const status = await ctx.host.oneClick(ways.oneClick);
        // A redirect isn't followed, so it says nothing was done.
        if (status >= 200 && status < 300) return done("done", { way: "one_click", detail: "Unsubscribed with their one-click link." });
        failures.push(`their one-click link answered ${status}`);
      } catch (error) {
        failures.push(`their one-click link couldn't be reached (${error instanceof PictureRefused ? error.message : "no answer"})`);
      }
    }
    if (ways.email) {
      if (row.tried.includes("email")) {
        return done("failed", {
          way: "email",
          detail: `The server stopped while sending the email to ${ways.email.to}, so whether it went isn't known; it wasn't sent again. They stay blocked.`,
        });
      }
      await this.#mark(row, "email");
      const sent = await sendEmail(ctx, inbox, ways.email.to, ways.email.subject, ways.email.body);
      if (sent) return done("done", { way: "email", detail: `Asked them by email, at ${ways.email.to}.` });
      failures.push(`the email to ${ways.email.to} couldn't be sent`);
    }
    if (!ways.page) {
      return done("failed", {
        detail: failures.length
          ? `It didn't work: ${failures.join("; ")}. They stay blocked, so their mail stays out of sight.`
          : "Their mail gives no way to unsubscribe. They stay blocked, so their mail stays out of sight.",
      });
    }
    const opened = await loadState(ctx);
    const agent = await openBrowserAgent(ctx, opened);
    const toPerson = (why: string) => done("needs_person", { way: "page", url: ways.page!, detail: why });
    if (!agent) {
      return toPerson(failures.length
        ? `It didn't work: ${failures.join("; ")}. Open their page to finish.`
        : "Their mail offers only a page. Open it to finish, or set up Browser Use in Settings, AI, to have it done for you.");
    }
    const marker = base64url(ctx.host.random.bytes(12));
    await this.#mark(row, "browser_agent", marker);
    try {
      const runId = await agent.start(ways.page, inbox.address, marker);
      // The key removed or replaced, or the inbox or this asking gone, while the start was on its way: those removals
      // stopped the runs they knew of, not this one. Stopped now, with the client in hand.
      if (!await this.#stillWanted(row, opened.browserAgentCredentials)) {
        await agent.cancel(runId);
        return toPerson("Browser Use was removed before it finished. Open their page to finish.");
      }
      return { way: "browser_agent", step: "agent", runId, page: ways.page, nextAt: ctx.now() + AGENT_POLL_MS, detail: null };
    } catch (error) {
      // The answer may have been lost after the run began: stop it, found by its marker.
      if (!(error instanceof BrowserAgentError) || error.state === "unavailable") await agent.cancelMarked(marker);
      return this.#agentRefused(error, ways.page);
    }
  }

  /** A browser agent's run, read again: still going, ended, taking too long or costing too much. */
  async #agent(row: UnsubscribeRow): Promise<Next> {
    const ctx = this.#ctx;
    const page = row.page ?? "";
    const agent = await openBrowserAgent(ctx, await loadState(ctx));
    if (!agent || !row.runId) {
      return done("needs_person", { way: "page", url: page, detail: "Browser Use was removed before it finished. Open their page to finish." });
    }
    if (ctx.now() - row.askedAt > AGENT_LIMIT_MS) {
      await agent.cancel(row.runId);
      return done("needs_person", { way: "page", url: page, detail: "Browser Use took too long. Open their page to finish." });
    }
    try {
      const outcome = await agent.check(row.runId);
      await recordBrowserAgent(ctx, "working");
      if (!outcome.ended) {
        if (outcome.costUsd <= MOST_COST_USD) return { nextAt: ctx.now() + AGENT_POLL_MS };
        await agent.cancel(row.runId);
        return done("needs_person", { way: "page", url: page, detail: `Browser Use reached its US$${MOST_COST_USD.toFixed(2)} limit and was stopped. Open their page to finish.` });
      }
      return outcome.unsubscribed
        ? done("done", { way: "browser_agent", detail: "Unsubscribed by Browser Use on their page." })
        : done("needs_person", { way: "page", url: page, detail: "Browser Use couldn't finish on their page. Open it to finish." });
    } catch (error) {
      if (error instanceof BrowserAgentError && error.state === "unavailable") {
        // Busy or unreachable: asked again in a while, until the run's ten minutes are up.
        await recordBrowserAgent(ctx, error.state, error.message);
        return { nextAt: ctx.now() + AGENT_RETRY_MS };
      }
      await agent.cancel(row.runId);
      return this.#agentRefused(error, page);
    }
  }

  /** Whether the key a run was started with is still the one stored, and this asking still stands as it was. */
  async #stillWanted(row: UnsubscribeRow, sealed: string | null): Promise<boolean> {
    const ctx = this.#ctx;
    return ctx.lock.run(async () => {
      const state = await loadState(ctx);
      const current = await ctx.db.select({ version: unsubscribes.version }).from(unsubscribes)
        .where(and(eq(unsubscribes.inboxId, row.inboxId), eq(unsubscribes.address, row.address), eq(unsubscribes.version, row.version))).get();
      return sealed !== null && state.browserAgentCredentials === sealed && current !== undefined;
    });
  }

  /** The browser agent refused or failed: recorded on its settings, and the page handed to the person. */
  async #agentRefused(error: unknown, page: string): Promise<Next> {
    const known = error instanceof BrowserAgentError ? error : new BrowserAgentError("unavailable", "Browser Use failed in an unexpected way.");
    await recordBrowserAgent(this.#ctx, known.state, known.message);
    return done("needs_person", { way: "page", url: page, detail: `${known.message} Open their page to finish.` });
  }

  /**
   * Writes down, before its side effect, that a way was started on this asking (and a run's marker), unless the row was
   * asked again meanwhile. Not told: nothing a person sees changed.
   */
  async #mark(row: UnsubscribeRow, way: "email" | "browser_agent", marker?: string): Promise<void> {
    const ctx = this.#ctx;
    row.tried = [...row.tried, way];
    if (marker) row.marker = marker;
    await ctx.lock.run(() => ctx.db.update(unsubscribes)
      .set({ tried: row.tried, ...(marker && { marker }) })
      .where(and(eq(unsubscribes.inboxId, row.inboxId), eq(unsubscribes.address, row.address), eq(unsubscribes.version, row.version))));
  }

  /** Writes what comes next, unless the row was asked again meanwhile, and tells people's devices when it changed. */
  async #save(row: UnsubscribeRow, next: Next): Promise<void> {
    const ctx = this.#ctx;
    await ctx.lock.run(async () => {
      const key = and(eq(unsubscribes.inboxId, row.inboxId), eq(unsubscribes.address, row.address), eq(unsubscribes.version, row.version));
      const current = await ctx.db.select().from(unsubscribes).where(key).get();
      if (!current) return;
      const told = next.state !== undefined || next.way !== undefined;
      const updated: UnsubscribeRow = { ...current, ...next, ...(told && { updatedAt: ctx.now(), version: current.version + 1 }) };
      await ctx.db.update(unsubscribes).set(updated).where(key);
      if (told) emitUnsubscribe(ctx, updated);
    });
  }

  #arm(at: number | null): void {
    this.#timer?.();
    this.#timer = null;
    if (at === null || !this.#started) return;
    const delay = Math.min(Math.max(0, at - this.#ctx.now()), MAX_TIMER_MS);
    this.#timer = this.#ctx.host.scheduler.setTimer(delay, () => {
      this.#timer = null;
      this.wake();
    });
  }
}

/** An end: the state and what it says, with nothing left to do. */
function done(state: "done" | "needs_person" | "failed", fields: Next): Next {
  return { state, step: null, nextAt: null, runId: null, url: null, ...fields };
}

interface StoredMail {
  from: { email: string };
  to: Address[];
  cc: Address[];
  fromCheck: string | null;
  fromVerified: string | null;
  signedRecipients: Array<"to" | "cc"> | null;
  signedUnsubscribe: SignedPart[] | null;
  header: string | null;
  post: string | null;
}

/**
 * Whether a stored message is proved to come from its From address, as the let-in rules ask (`provedOwnSender`): the
 * provider's checker proved exactly that address's domain, by a DKIM signature of its organisation (which vouches for a
 * recipient field), in an inbox whose checker the server trusts (the caller's part).
 */
export function provedFromSender(message: Pick<StoredMail, "from" | "fromCheck" | "fromVerified" | "signedRecipients">): boolean {
  const domain = message.from.email.toLowerCase().split("@").pop() ?? "";
  return message.fromCheck === "verified" && domain !== "" && message.fromVerified?.toLowerCase() === domain && (message.signedRecipients?.length ?? 0) > 0;
}

/** Whether the sender's signature says the message was sent to this inbox: a signed To or Cc names it, aliases included. */
function sentHere(message: Pick<StoredMail, "to" | "cc" | "signedRecipients">, inboxAddress: string): boolean {
  const signed = message.signedRecipients ?? [];
  return addressedTo({ to: signed.includes("to") ? message.to : [], cc: signed.includes("cc") ? message.cc : [] }, inboxAddress);
}

/**
 * The ways the sender's proved mail to this inbox offers (the comment at the top): the thread asked from first, newest
 * first. Says why when nothing may be used.
 */
async function waysOf(ctx: Ctx, row: UnsubscribeRow, inbox: InboxRow): Promise<{ ways: Ways; unproved?: undefined } | { unproved: keyof typeof UNPROVED }> {
  if (!trustsChecker(inbox.provider)) return { unproved: "inbox" };
  const from = sql<string>`lower(json_extract(${messages.from}, '$.email'))`;
  const mail: StoredMail[] = await ctx.db.select({
    from: messages.from,
    to: messages.to,
    cc: messages.cc,
    fromCheck: messages.fromCheck,
    fromVerified: messages.fromVerified,
    signedRecipients: messages.signedRecipients,
    signedUnsubscribe: messages.signedUnsubscribe,
    header: messages.listUnsubscribe,
    post: messages.listUnsubscribePost,
  }).from(messages)
    .where(and(eq(messages.inboxId, row.inboxId), eq(messages.outgoing, false), eq(from, row.address)))
    .orderBy(desc(sql`${messages.threadId} = ${row.threadId}`), desc(messages.date))
    .limit(MESSAGES_READ);
  const options: WayOptions = ctx.avatars ? { registrable: (host) => ctx.avatars!.suffixes.registrableDomain(host) } : {};
  const proved = mail.filter(provedFromSender);
  const usable = proved.filter((message) => sentHere(message, inbox.address));
  for (const message of usable) {
    const ways = headerWays(message.header, message.post, message.signedUnsubscribe ?? [], options);
    if (ways.oneClick || ways.email || ways.page) return { ways };
  }
  // Nothing to use. Why: their only proved mail was stored before 0.1.5 (its signed headers never read; mail since has
  // them read, if only as none), mail not sent here, mail not proved; else their proved mail here offers no way.
  // Only mail that would have counted (proved from the From domain, sent here) says "next time": other senders' and
  // forwarded mail wouldn't work then either.
  const readSince = usable.some((message) => message.signedUnsubscribe !== null);
  if (!readSince && usable.some((message) => message.signedUnsubscribe === null)) return { unproved: "old" };
  if (usable.length === 0) return { unproved: proved.length > 0 ? "forwarded" : "mail" };
  return { ways: {} };
}

/** Sends the unsubscribe email from the inbox; whether it went. Its copy joins the mailbox's Sent at the next sync. */
async function sendEmail(ctx: Ctx, inbox: InboxRow, to: string, subject: string, body: string): Promise<boolean> {
  if (inbox.paused) return false;
  try {
    const provider = await ctx.hooks.provider(inbox.id);
    await provider.send({ from: { name: inbox.name, email: inbox.address }, to: [{ email: to }], cc: [], bcc: [], subject, text: body });
    ctx.hooks.requestSync(inbox.id);
    return true;
  } catch {
    return false;
  }
}
