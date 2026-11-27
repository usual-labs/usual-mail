/**
 * Unsubscribing from a sender (docs/contract.md, "Unsubscribing"; the owner's words of 2026-11-27: "unsubscribe from
 * it, so I won't ever get that any feed from those or email from those"): a person asks the server to have a sender
 * stop. The server asks the cheapest way the sender's mail offers: its one-click address (RFC 8058), else an email to
 * the address its List-Unsubscribe header names, else its unsubscribe page, opened by a browser agent when the person
 * set one up (`BrowserAgentSettings`), or handed to the person to open. The apps block the sender too, so their mail
 * stays out of sight whatever the sender does.
 */
import type { Id, IsoTime } from "./domain.ts";

/**
 * How the server asked: `one_click`, a POST to the sender's one-click address; `email`, a message from the inbox to the
 * address the header names; `browser_agent`, the unsubscribe page opened by the person's browser agent; `page`, the
 * unsubscribe page, for the person to open.
 */
export type UnsubscribeWay = "one_click" | "email" | "browser_agent" | "page";
export const UNSUBSCRIBE_WAYS = ["one_click", "email", "browser_agent", "page"] as const;

/**
 * `working`: the server is asking (a browser agent can take a few minutes). `done`: the one-click address or the page
 * said yes, or the email went out. `needs_person`: what is left is a page the person opens (`url`). `failed`: the mail
 * offers no way, or none worked; `detail` says which.
 */
export type UnsubscribeState = "working" | "done" | "needs_person" | "failed";
export const UNSUBSCRIBE_STATES = ["working", "done", "needs_person", "failed"] as const;

/** One sender's unsubscribing, in one inbox: the newest asked. Person only. */
export interface Unsubscribe {
  inboxId: Id;
  /** The sender, lower case: the thread's `sender` when it was asked. */
  address: string;
  /** The thread it was asked from. */
  threadId: Id;
  state: UnsubscribeState;
  /** How it was asked, or is being asked. Absent while nothing has been tried, and when the mail offered no way. */
  way?: UnsubscribeWay;
  /**
   * With `needs_person`: the sender's unsubscribe page, an https address, for the person to open in their own browser.
   * It comes from the sender's mail: an interface opens it only when the person asks.
   */
  url?: string;
  /** What happened, in words a person can read. Never a key, never the page's own words. */
  detail?: string;
  askedAt: IsoTime;
  updatedAt: IsoTime;
  /** Rises with every change and may rise by more than one. Of two copies, keep the higher. */
  version: number;
}

/** A service that runs a browser agent for the server. */
export type BrowserAgentService = "browser_use";
export const BROWSER_AGENT_SERVICES = ["browser_use"] as const;

/**
 * Whether the browser agent's key works. `working`: its last request was answered. `key_refused`: the service refused
 * the key. `out_of_credit`: the account has no credit or reached its limit. `unavailable`: the service couldn't be
 * reached or failed, which usually passes by itself.
 */
export type BrowserAgentState = "working" | "key_refused" | "out_of_credit" | "unavailable";
export const BROWSER_AGENT_STATES = ["working", "key_refused", "out_of_credit", "unavailable"] as const;

/** The browser agent as the person set it up (`AiSettings.browserAgent`), without the key. */
export interface BrowserAgentSettings {
  service: BrowserAgentService;
  state: BrowserAgentState;
  /** Why the state isn't `working`, in words a person can act on. Never the key or any part of it. */
  detail?: string;
}

/**
 * What a person gives to set the browser agent up. Stored encrypted like the AI's key; never returned by any route,
 * never shown to an agent, never written to a log.
 */
export interface BrowserAgentCredentials {
  service: BrowserAgentService;
  apiKey: string;
}

/**
 * What saving a browser agent's key means, for an interface to show before it sends the key, as `aiDisclosure` is for
 * the AI's.
 */
export const BROWSER_AGENT_DISCLOSURE = {
  title: "What Browser Use is sent",
  lines: [
    "Only when you unsubscribe from a sender whose mail offers nothing but an unsubscribe page, and only that once.",
    "The page's address, which the sender made and which may identify you, this inbox's address, in case the page asks for it, and a random number that marks the request.",
    "Browser Use opens the page in its own browser, with no sign-ins, and its AI presses the page's unsubscribe controls. Nothing else from your mail is sent.",
    "Each unsubscribe uses some of your Browser Use credit: at most US$0.10 of its AI, and a few minutes of its browser.",
  ],
} as const;
