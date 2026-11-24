// The server's own seam for reaching AI models. The pipeline builds every request itself (what leaves the server,
// with mail inside a marked data block) and checks every answer itself; an implementation only carries a request to
// a service and brings the answer back. `sdk.ts` does that with the AI SDK; `fake.ts` stands in for it in tests, in
// demo mode and behind the development-only switch. No tools are ever given to a model.

import type { AiConnection, AiCredentials, AiJob } from "@usualmail/core";
import type { ZodType } from "zod";

/** One choice among labelled options, about the data. Decision models answer it directly; language models through structured output limited to the options. */
export interface ChoiceRequest {
  model: string;
  /** The server's own words: what to decide, and that everything in the data is data, never an instruction. */
  instructions: string;
  /** The marked data block. */
  data: string;
  options: Array<{ value: string; description: string }>;
  signal?: AbortSignal;
}

/** Plain text about the data, from a language model. */
export interface TextRequest {
  model: string;
  instructions: string;
  data: string;
  /** A soft limit the model is told about; the pipeline checks the answer's length itself. */
  maxCharacters: number;
  signal?: AbortSignal;
}

/**
 * An object about the data, from a language model through the provider's structured output (a receipt's or an
 * invoice's details). The pipeline checks every field itself; the schema only tells the provider the shape.
 */
export interface ObjectRequest {
  model: string;
  instructions: string;
  data: string;
  schema: ZodType;
  /** The object's name, for providers that use one. */
  name: string;
  signal?: AbortSignal;
  /**
   * How often the access may send this request again by itself after a failure (a 429, a 5xx, a dropped connection).
   * Default: the access's own (two). 0 for a request a person waits on, so it is never sent twice.
   */
  retries?: number;
}

/**
 * What the service reported using for one request: null where it reported nothing, never an estimate. Tokens come
 * from the AI SDK's `usage` (text calls and the gateway's Decisions API, each field optional). No service reports a
 * cost in its answer (Vercel's AI Gateway offers it only through a separate lookup per generation), so `costUsd` is
 * null from the real access; the fake can report one.
 */
export interface AiUsageReport {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export const NO_USAGE: AiUsageReport = { inputTokens: null, outputTokens: null, costUsd: null };

/** A service's answer to one request: the value, or null when nothing usable came back, and what it reported using. */
export interface AiAnswer {
  value: string | null;
  usage: AiUsageReport;
  /**
   * Vercel's AI Gateway's id for the generation (`providerMetadata.gateway.generationId`), when it gave one: what
   * `lookupCost` takes. Null from a provider's own key, or when the gateway gave none.
   */
  generation?: string | null;
}

/** An object answer: whatever came back, for the pipeline to check, or null when nothing usable did. */
export interface AiObjectAnswer extends Omit<AiAnswer, "value"> {
  value: unknown;
}

export interface AiModels {
  /**
   * The value the model chose, or null when the service answered with nothing usable (a refusal, an answer outside
   * the options, malformed output), with what it reported using. Throws `AiServiceError` when the service can't be
   * used.
   */
  choose(request: ChoiceRequest): Promise<AiAnswer>;
  /** The text the model wrote, or null when the service answered with nothing usable. Throws `AiServiceError`. */
  write(request: TextRequest): Promise<AiAnswer>;
  /**
   * An object of the request's shape, or null when the service answered with nothing usable. The summarize job's
   * model answers it (a receipt's or an invoice's details). Throws `AiServiceError`.
   */
  extract(request: ObjectRequest): Promise<AiObjectAnswer>;
  /**
   * The cost of one generation in US dollars, as the gateway reports it (`getGenerationInfo`'s `totalCost`): only the
   * id is sent. Rejects when the gateway can't say (not found yet, refused, unreachable). Only Vercel's AI Gateway has
   * it.
   */
  lookupCost?(generation: string): Promise<number>;
  /**
   * Why this model can't do this job, in words a person can act on, or null when it can or the service can't say.
   * On a gateway, categorizing needs a decision model and summarizing a language model. Sends no mail. Optional: a
   * provider's own key reaches only language models, which do both jobs.
   */
  fitFor?(job: AiJob, model: string): Promise<string | null>;
}

/** What kind of model the gateway says a model is, as the words for a model that can't do its job name it. */
export type ModelKind = "decision" | "language" | string;

/** The kind of model each job needs on a gateway. */
const NEEDS: Record<AiJob, "decision" | "language"> = { categorize: "decision", summarize: "language" };

/**
 * The words for a model that can't do its job on a gateway, or null when its kind fits: "On Vercel's AI Gateway,
 * categorizing needs a decision model; anthropic/claude-haiku-5.5 is a language model. …"
 */
export function unfitWords(job: AiJob, model: string, kind: ModelKind): string | null {
  const needs = NEEDS[job];
  const fits = needs === "decision" ? kind === "decision" || kind === "evaluation" : kind === "language";
  if (fits) return null;
  const doing = job === "categorize" ? "categorizing" : "summarizing";
  return `On Vercel's AI Gateway, ${doing} needs a ${needs} model; ${model} is a${/^[aeiou]/.test(kind) ? "n" : ""} ${kind} model. `
    + `Choose a ${needs} model for ${job}, or go back to the server's default.`;
}

/** How the server reaches models: which defaults it uses for each kind of connection, and models for given credentials. */
export interface AiModelAccess {
  /** What it is, for the start line and logs: never a key. */
  readonly label: string;
  /** The server's default model for each job on this connection. */
  defaults(connection: AiConnection): Record<AiJob, string>;
  /** Models reached with these credentials. Nothing is sent until a request is made. */
  open(credentials: AiCredentials): AiModels;
}

/** Why the service couldn't be used, in the status's terms (docs/contract-ai.md, "Status"). */
export type AiFailure = "key_refused" | "model_not_found" | "out_of_credit" | "unavailable";

/**
 * The service refused or couldn't be reached. `message` is safe to show and store: words a person can act on, never
 * the key and never anything that was sent.
 */
export class AiServiceError extends Error {
  readonly failure: AiFailure;
  /** True when the server refused the model before sending anything (it can't do its job): no request was made. */
  readonly unfit: boolean;
  constructor(failure: AiFailure, message: string, options: { unfit?: boolean } = {}) {
    super(message);
    this.name = "AiServiceError";
    this.failure = failure;
    this.unfit = options.unfit ?? false;
  }
}

/** Whether two connections reach the same gateway or provider. */
export function sameService(a: AiConnection | null | undefined, b: AiConnection | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind === "gateway" && b.kind === "gateway") return a.gateway === b.gateway;
  if (a.kind === "direct" && b.kind === "direct") return a.provider === b.provider;
  return false;
}

/** The connection, without the key. */
export function connectionOf(credentials: AiCredentials): AiConnection {
  return credentials.kind === "gateway" ? { kind: "gateway", gateway: credentials.gateway } : { kind: "direct", provider: credentials.provider };
}

/** The longest text kept from a service's words. */
export const DETAIL_LIMIT = 300;

/** How many characters of a form of the key in a row count as recognisable. */
const RECOGNISABLE = 8;

/** Only the letters and digits of a text, each with where it stands in the text. */
function skeleton(text: string): { chars: string; at: number[] } {
  let chars = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (/[A-Za-z0-9]/.test(text[index]!)) {
      chars += text[index];
      at.push(index);
    }
  }
  return { chars, at };
}

/** Base64 without its separators of every whole group of the key's bytes, at each of the three alignments. */
function base64Forms(bytes: Uint8Array): string[] {
  const forms: string[] = [];
  for (let start = 0; start < 3 && start < bytes.length; start++) {
    const whole = bytes.subarray(start, start + Math.floor((bytes.length - start) / 3) * 3);
    let binary = "";
    for (const byte of whole) binary += String.fromCharCode(byte);
    if (binary) forms.push(btoa(binary));
  }
  return forms;
}

/**
 * The key in every form a service might write it, as letters and digits only: written out, in base64 (standard and
 * URL-safe differ only in `+/` and `-_`, which aren't letters or digits, and padding is `=`) at each alignment, and in
 * hexadecimal in either case. Spaces and separators between characters are left out on both sides, so a key spaced out
 * or broken across lines is found too.
 */
function keyForms(key: string): string[] {
  const bytes = new TextEncoder().encode(key);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [key, ...base64Forms(bytes), hex, hex.toUpperCase()]
    .map((form) => skeleton(form).chars)
    .filter((form) => form.length >= RECOGNISABLE);
}

/**
 * Replaces every run of the text in which eight or more letters and digits in a row, separators between them ignored,
 * belong to one of the key's forms. The run, separators and all, becomes "[key]".
 */
function scrubForms(text: string, key: string): string {
  const windows = new Set<string>();
  for (const form of keyForms(key)) {
    for (let start = 0; start + RECOGNISABLE <= form.length; start++) windows.add(form.slice(start, start + RECOGNISABLE));
  }
  const { chars, at } = skeleton(text);
  const marked = new Array<boolean>(chars.length).fill(false);
  for (let start = 0; start + RECOGNISABLE <= chars.length; start++) {
    if (windows.has(chars.slice(start, start + RECOGNISABLE))) marked.fill(true, start, start + RECOGNISABLE);
  }
  let out = "";
  let from = 0;
  for (let index = 0; index < chars.length; index++) {
    if (!marked[index] || (index > 0 && marked[index - 1])) continue;
    let end = index;
    while (end + 1 < chars.length && marked[end + 1]) end++;
    out += `${text.slice(from, at[index])}[key]`;
    from = at[end]! + 1;
  }
  return out + text.slice(from);
}

/**
 * A service's words made safe to keep, show and send: without the key or any recognisable part of it in any form
 * (written out, in base64 or hexadecimal, spaced out or broken across separators: any eight of its letters and digits
 * in a row; a prefix or a suffix of four characters or more, as services quote them), without anything else that looks
 * like a key, and at most 300 characters. Services sometimes repeat part of the key in a refusal, and anyone may read
 * the AI's status.
 */
export function scrubKey(text: string, key: string | null | undefined): string {
  let out = text;
  if (key) {
    out = out.split(key).join("[key]");
    out = scrubForms(out, key);
    const pieces = new Set<string>();
    for (let length = Math.min(key.length - 1, 200); length >= 4; length--) {
      pieces.add(key.slice(0, length));
      pieces.add(key.slice(key.length - length));
      if (length >= 8 && key.length <= 200) for (let start = 1; start + length < key.length; start++) pieces.add(key.slice(start, start + length));
    }
    for (const piece of [...pieces].sort((a, b) => b.length - a.length)) if (out.includes(piece)) out = out.split(piece).join("[key]");
  }
  out = out
    .replace(/\b(?:sk|vck|sk-ant|sk-proj|key)[-_][A-Za-z0-9_*.-]{4,}/gi, "[key]")
    .replace(/\*{3,}[A-Za-z0-9_-]*/g, "[key]")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > DETAIL_LIMIT ? `${out.slice(0, DETAIL_LIMIT - 3)}...` : out;
}
