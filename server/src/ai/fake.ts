// A stand-in for the AI services: no network, no real key needed. Every test uses it, demo mode uses it, and the
// development-only switch (`--dev-fake-ai`) puts it behind a normal server. It records each request it was sent, so a
// test can see exactly what would have left the server, and can be told what to answer, to fail, or to wait.

import type { AiConnection, AiCredentials, AiJob } from "@usualmail/core";
import { guessFilters } from "./fake-ask.ts";
import { AiServiceError, NO_USAGE, unfitWords, type AiAnswer, type AiModelAccess, type AiModels, type AiObjectAnswer, type AiUsageReport, type ChoiceRequest, type ModelKind, type ObjectRequest, type TextRequest } from "./models.ts";

export interface FakeRequest {
  kind: "choose" | "write" | "extract";
  /** As sent, without an object request's schema. */
  request: ChoiceRequest | TextRequest | Omit<ObjectRequest, "schema">;
  /** The key the request was made with, as a real service would receive it. */
  apiKey: string;
  connection: AiConnection;
}

export interface FakeModelsOptions {
  label?: string;
  /** The defaults it reports for every kind of connection. */
  defaults?: Record<AiJob, string>;
  /** What kind of model the fake gateway says each model is (see `kinds`). */
  kinds?: Record<string, ModelKind>;
}

export class FakeModels implements AiModelAccess {
  readonly label: string;
  readonly #defaults: Record<AiJob, string>;
  /** Every request, oldest first. */
  readonly requests: FakeRequest[] = [];
  /** What `choose` answers. Default: a guess from the words in the mail (for the screening gate's question, its kind). */
  choose: (request: ChoiceRequest) => string | null | Promise<string | null> = (request) =>
    (request.options.some((option) => option.value === "none") ? guessPass(request) : guessCategory(request));
  /** What `write` answers. Default: the newest message's first sentence. */
  write: (request: TextRequest) => string | null | Promise<string | null> = firstSentence;
  /** What `extract` answers (a receipt's details, a notification's event, a search sentence's filters). Default: a guess by rule. */
  extract: (request: ObjectRequest) => unknown = (request) =>
    (request.name === "event" ? guessEvent(request) : request.name === "search" ? guessFilters(request) : guessDetails(request));
  /** What each answered request reports using. Default: nothing reported, as a service that says nothing. */
  usage: (kind: FakeRequest["kind"], request: FakeRequest["request"]) => AiUsageReport = () => NO_USAGE;
  /** The generation id an answered request gives through the gateway. Default: none. A provider's own key gives none. */
  generation: (kind: FakeRequest["kind"], request: FakeRequest["request"]) => string | null = () => null;
  /** What a cost lookup answers for an id: dollars, or an error to throw (not ready, refused). Default: not found. */
  costOf: (generation: string) => number | Error | Promise<number | Error> = () => new Error("The generation wasn't found");
  /** Every id a lookup was made for, oldest first. Lookups aren't in `requests`: they aren't requests to a model. */
  readonly lookups: string[] = [];
  /** Failures to throw, one per request, before answering again. */
  readonly failures: AiServiceError[] = [];
  /** Thrown for every request while set. */
  failAll: AiServiceError | null = null;
  /** While set, every request waits for it. */
  hold: Promise<void> | null = null;
  /** What kind of model the fake gateway says each model is. A model it doesn't list fits any job. */
  kinds: Record<string, ModelKind> = {};

  constructor(options: FakeModelsOptions = {}) {
    this.label = options.label ?? "fake models";
    this.#defaults = options.defaults ?? { categorize: "fake/categorize", summarize: "fake/summarize" };
    this.kinds = { ...options.kinds };
  }

  defaults(_connection: AiConnection): Record<AiJob, string> {
    return { ...this.#defaults };
  }

  open(credentials: AiCredentials): AiModels {
    const connection: AiConnection = credentials.kind === "gateway"
      ? { kind: "gateway", gateway: credentials.gateway }
      : { kind: "direct", provider: credentials.provider };
    const answer = async <V>(kind: FakeRequest["kind"], request: ChoiceRequest | TextRequest | ObjectRequest, reply: () => V | Promise<V>): Promise<Omit<AiAnswer, "value"> & { value: V }> => {
      const { schema: _schema, ...sent } = request as ObjectRequest;
      this.requests.push({ kind, request: structuredClone({ ...sent, signal: undefined }), apiKey: credentials.apiKey, connection });
      if (this.hold) await this.hold;
      const failure = this.failures.shift() ?? this.failAll;
      if (failure) throw failure;
      const value = await reply();
      return { value, usage: this.usage(kind, request), generation: connection.kind === "gateway" ? this.generation(kind, request) : null };
    };
    // As the gateway does: only it can say what one generation cost.
    const lookupCost = async (generation: string): Promise<number> => {
      this.lookups.push(generation);
      const cost = await this.costOf(generation);
      if (cost instanceof Error) throw cost;
      return cost;
    };
    return {
      choose: (request) => answer("choose", request, () => this.choose(request)),
      write: (request) => answer("write", request, () => this.write(request)),
      extract: (request): Promise<AiObjectAnswer> => answer("extract", request, () => this.extract(request) ?? null),
      ...(connection.kind === "gateway" && { lookupCost }),
      // As the gateway does: a model listed with a kind that can't do the job. A provider's own key says nothing.
      fitFor: async (job, model) => {
        const kind = this.kinds[model];
        return connection.kind === "gateway" && kind !== undefined ? unfitWords(job, model, kind) : null;
      },
    };
  }

  /** Requests of one kind, oldest first. */
  sent(kind: FakeRequest["kind"]): FakeRequest[] {
    return this.requests.filter((request) => request.kind === kind);
  }

  /** Makes requests wait until the returned function is called. */
  pause(): () => void {
    let release: () => void = () => {};
    this.hold = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.hold = null;
      release();
    };
  }
}

export function failure(kind: AiServiceError["failure"], message = `The fake service says ${kind}.`): AiServiceError {
  return new AiServiceError(kind, message);
}

/** The data block's JSON lines, parsed. */
export function dataItems(data: string): Array<Record<string, unknown>> {
  return data.split("\n").slice(1, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A rough guess from the words, so demo mode and the development switch sort mail plausibly. */
function guessCategory(request: ChoiceRequest): string {
  const item = dataItems(request.data)[0] ?? {};
  const words = `${String(item.subject ?? "")} ${String(item.text ?? "")}`.toLowerCase();
  if (/\b(code|verification|verify|sign-in link|one-time|password reset)\b/.test(words)) return "otp";
  if (/\binvoice\b|amount due|\bdue (on|by)\b/.test(words)) return "invoice";
  if (/\b(receipt|order|booking|payment of|paid)\b/.test(words)) return "receipt";
  if (item.listId || /newsletter|\bissue \d+|unsubscribe|digest/.test(words)) return "newsletter";
  if (item.machineSent === true) return "notification";
  return "conversation";
}

/** A rough guess at which kind of mail may skip Screening, among the request's own options; "none" otherwise. */
function guessPass(request: ChoiceRequest): string {
  const item = dataItems(request.data)[0] ?? {};
  const words = `${String(item.subject ?? "")} ${String(item.text ?? "")}`.toLowerCase();
  const guesses: Array<[string, RegExp]> = [
    ["sign_in", /(sign[ -]?in|log[ -]?in|magic link)/],
    ["email_confirmation", /(confirm|verify).*(e-?mail|address|account)/],
    ["security", /(security|new device|was this you|suspicious)/],
    ["account", /(reset your password|password reset|data export|account (was |has been )?deleted)/],
    ["order", /(order|shipped|delivery|tracking)/],
    ["booking", /(booking|reservation|flight|hotel|appointment)/],
    ["payment", /(payment|charged|renewal|declined)/],
  ];
  const offered = new Set(request.options.map((option) => option.value));
  return guesses.find(([kind, pattern]) => offered.has(kind) && pattern.test(words))?.[0] ?? "none";
}

/** A rough guess at a receipt's details from the newest message that names an amount, for demo mode and the switch. */
function guessDetails(request: ObjectRequest): unknown {
  const items = dataItems(request.data);
  const subject = typeof items[0]?.subject === "string" ? items[0].subject : null;
  const messages = items.slice(1);
  const AMOUNT = /(€|EUR|USD|GBP|£)\s?(\d[\d.,]*\d)|(\d[\d.,]*\d)\s?(€|EUR|USD|GBP|£)/;
  const priced = messages.find((item) => typeof item.text === "string" && AMOUNT.test(item.text));
  const found = priced ? AMOUNT.exec(String(priced.text)) : null;
  const words = messages.map((item) => String(item.text ?? "")).join(" ");
  return {
    party: typeof messages.at(-1)?.from === "string" && messages.at(-1)!.from !== "someone" ? messages.at(-1)!.from : null,
    amount: found ? found[2] ?? found[3]! : null,
    currency: found ? found[1] ?? found[4]! : null,
    refund: /\brefund/i.test(words),
    state: /\brefund/i.test(words) || /\b(paid|thanks for your payment|payment received)\b/i.test(words) ? "paid"
      : /\bwill be (charged|debited|collected)\b/i.test(words) ? "scheduled"
      : /\b(please pay|payment due|amount due|due (on|by))\b/i.test(words) ? "due" : null,
    dueDate: /\bdue\s+(?:on\s+|by\s+)?(\d{4}-\d{2}-\d{2})/i.exec(words)?.[1] ?? null,
    what: subject,
  };
}

/** A rough guess at a notification's summary and event, for demo mode and the switch: a status from a few words. */
function guessEvent(request: ObjectRequest): unknown {
  const items = dataItems(request.data);
  const newest = items.slice(1).find((item) => typeof item.text === "string" && item.text.trim());
  const words = String(newest?.text ?? items[0]?.subject ?? "");
  const STATUSES: Array<[RegExp, string]> = [
    [/out for delivery/i, "Out for delivery"], [/delivered/i, "Delivered"], [/shipped|dispatched|on (its|their) way/i, "Dispatched"],
    [/appointment.*(moved|rescheduled)/i, "Appointment moved"], [/appointment.*confirmed|confirmed.*appointment/i, "Appointment confirmed"],
    [/password.*changed/i, "Password changed"], [/payment.*failed/i, "Payment failed"],
  ];
  const status = STATUSES.find(([pattern]) => pattern.test(words))?.[1] ?? null;
  return {
    summary: firstSentence({ ...request, maxCharacters: 200 } as TextRequest),
    status,
    about: status ? (typeof items[0]?.subject === "string" ? items[0].subject : null) : null,
    date: /\b(\d{4}-\d{2}-\d{2})\b/.exec(words)?.[1] ?? null,
    time: null,
    endTime: null,
    // A tracking or order number: letters then digits, or a long run of digits, as written.
    reference: /\b(?:[A-Z]{2}[ -]?\d{4}[ -]?\d{4}|\d{6,})\b/.exec(words)?.[0] ?? null,
  };
}

/** The newest message's first sentence, short. */
function firstSentence(request: TextRequest): string | null {
  const items = dataItems(request.data);
  const newest = items.find((item) => typeof item.text === "string" && item.text.trim());
  const text = typeof newest?.text === "string" ? newest.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return typeof items[0]?.subject === "string" ? items[0].subject : null;
  const sentence = /^.*?[.!?](\s|$)/.exec(text)?.[0]?.trim() ?? text;
  return sentence.slice(0, 160);
}
