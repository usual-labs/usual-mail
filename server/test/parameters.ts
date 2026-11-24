// Fails any statement that binds more than 100 parameters, or gives a LIKE or GLOB a pattern over 50 bytes: the limits
// of a Durable Object's SQLite (docs/agents/decisions.md, 2026-11-21), so every test guards them. `npm test` loads this
// before each test file (`--import`). It wraps libSQL's local client, below Drizzle, so it sees what SQLite is sent:
// single statements, batches (which Drizzle's logger never sees), transactions and migrations, and the tests' own raw
// statements. A statement over a limit throws, as SQLite would on Cloudflare (there a long pattern fails only once a
// row is compared; here always); it is also remembered, so one whose error a background job swallows still fails its
// test file.

import type { InArgs, InStatement } from "@libsql/client";
import { Sqlite3Client, Sqlite3Transaction } from "@libsql/client/sqlite3";
import { after } from "node:test";
import { MAX_PARAMS } from "../src/db/params.ts";

/** The most bytes a LIKE or GLOB pattern may have there. */
export const MAX_PATTERN_BYTES = 50;

/** The statements over a limit since the last look, each as what was over and the start of its SQL. */
export const overLimit: string[] = [];

/** Each distinct statement that bound a list as JSON (`json_each`), with its parameters: test/list-plans.ts reads them. */
export const jsonLists = new Map<string, InArgs>();

const WRAPPED = Symbol.for("usual-mail.test.parameters");
type Method = (this: unknown, ...args: unknown[]) => unknown;
type Item = InStatement | [string, InArgs?];

function argsOf(item: Item, separate?: unknown): InArgs | undefined {
  if (typeof item === "string") return separate as InArgs | undefined;
  if (Array.isArray(item)) return item[1];
  return item.args;
}

/**
 * The patterns a statement's LIKE and GLOB operators get, as its text shows them: the positional `?` or the quoted
 * literal right after the keyword (quotes, identifiers and comments skipped, so a `?` in them isn't counted). Anything
 * else there, or a pattern joined on with `||`, can't be measured: null.
 */
export function likePatterns(text: string, args: InArgs | undefined): Array<string | null> {
  const bound = Array.isArray(args) ? args : [];
  const out: Array<string | null> = [];
  const word = /[A-Za-z_][A-Za-z0-9_]*/y;
  let next = 0;
  let state: "none" | "keyword" | "pattern" = "none";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (text.startsWith("--", i) || text.startsWith("/*", i)) {
      const end = text.startsWith("--", i) ? text.indexOf("\n", i) : text.indexOf("*/", i + 2) + 1;
      i = end <= 0 ? text.length : end + 1;
    } else if (text.startsWith("||", i)) {
      if (state === "pattern") out[out.length - 1] = null;
      state = "none";
      i += 2;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      let value = "";
      while (j < text.length && !(text[j] === c && text[j + 1] !== c)) {
        value += text[j];
        j += text[j] === c ? 2 : 1;
      }
      if (state === "keyword") out.push(c === "'" ? value : null);
      state = state === "keyword" ? "pattern" : "none";
      i = j + 1;
    } else if (c === "?") {
      if (state === "keyword") out.push(bound[next] === null || bound[next] === undefined ? "" : String(bound[next]));
      state = state === "keyword" ? "pattern" : "none";
      next++;
      i++;
    } else {
      word.lastIndex = i;
      const found = word.exec(text)?.[0];
      if (state === "keyword") out.push(null);
      state = found && /^(like|glob)$/i.test(found) ? "keyword" : "none";
      i += found ? found.length : 1;
    }
  }
  if (state === "keyword") out.push(null);
  return out;
}

function over(entry: string, error: string): never {
  overLimit.push(entry);
  throw new Error(`${error} (${entry})`);
}

function check(item: Item, separate?: unknown): void {
  const args = argsOf(item, separate);
  const count = args === undefined ? 0 : Array.isArray(args) ? args.length : Object.keys(args).length;
  const text = typeof item === "string" ? item : Array.isArray(item) ? item[0] : item.sql;
  const head = text.replace(/\s+/g, " ").trim().slice(0, 160);
  if (text.includes("json_each(") && !/^\s*EXPLAIN/i.test(text) && jsonLists.size < 1_000) jsonLists.set(text, args ?? []);
  if (count > MAX_PARAMS) over(`${count} parameters: ${head}`, `too many SQL variables (more than ${MAX_PARAMS})`);
  if (!/like|glob/i.test(text)) return;
  for (const pattern of likePatterns(text, args)) {
    const bytes = pattern === null ? null : Buffer.byteLength(pattern, "utf8");
    if (bytes === null || bytes > MAX_PATTERN_BYTES) {
      over(`a LIKE or GLOB pattern of ${bytes ?? "unmeasurable"} bytes: ${head}`, `LIKE or GLOB pattern too complex (more than ${MAX_PATTERN_BYTES} bytes)`);
    }
  }
}

function wrap(prototype: object, name: string, each: (args: unknown[]) => void): void {
  const target = prototype as Record<string | symbol, unknown>;
  const original = target[name] as Method;
  target[name] = function (this: unknown, ...args: unknown[]) {
    try {
      each(args);
    } catch (error) {
      return Promise.reject(error);
    }
    return original.apply(this, args);
  };
}

const marked = Sqlite3Client.prototype as unknown as Record<symbol, boolean>;
if (!marked[WRAPPED]) {
  marked[WRAPPED] = true;
  const single = (args: unknown[]) => check(args[0] as Item, args[1]);
  const many = (args: unknown[]) => {
    for (const item of args[0] as Item[]) check(item);
  };
  for (const prototype of [Sqlite3Client.prototype, Sqlite3Transaction.prototype]) {
    wrap(prototype, "execute", single);
    wrap(prototype, "batch", many);
  }
  wrap(Sqlite3Client.prototype, "migrate", many);
  // After each test file's tests: anything over the limit fails the file, also when the error was caught and logged.
  after(() => {
    if (overLimit.length) throw new Error(`Statements over a Durable Object's SQLite limits:\n${overLimit.join("\n")}`);
  });
}
