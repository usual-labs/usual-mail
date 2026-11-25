// Speed tests that fail instead of hanging (0.1.3, after a security review): a pattern that
// scans back and forth blocks the event loop, so node:test's own timeout never fires. `within` runs one piece of work on
// one 1 MB body in a worker thread and terminates it at the limit (V8 stops a worker even inside a regex), so a
// regression fails the test in seconds. This file is both the helper and the worker's entry.

import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { holdsCode, looksLikeCode } from "../src/ai/gate.ts";
import { categorizeRequest, detailsRequest, eventRequest, summarizeRequest, withoutAddresses } from "../src/ai/prompt.ts";
import { modelText, plainText, readingText, snippetText } from "../src/ai/text.ts";
import { checkEvent } from "../src/ai/event.ts";
import { withoutRelativeWords, withoutSender } from "../src/ai/event-lines.ts";
import { checkReference } from "../src/ai/event-reference.ts";
import { checkDetails, plainLine } from "../src/ai/payment.ts";
import { partyName } from "../src/ai/payment-party.ts";
import { acceptSummary } from "../src/ai/prompt.ts";
import { PicturePlans } from "../src/pictures/present.ts";
import { normalizeListId } from "../src/service/match.ts";

const MB = 1024 * 1024;
const at = Date.UTC(2026, 10, 25);

/** Bodies built to make a pattern scan back and forth, 1 MB each. */
export const BODIES: Record<string, string> = {
  "card and stars": `card ${"*".repeat(MB)}`,
  "order and hyphens": `order ${"-".repeat(MB)}`,
  "angle brackets": "<".repeat(MB),
  "unclosed style blocks": "<style ".repeat(MB / 7),
  "an href and spaces": `href=${" ".repeat(MB)}`,
  "a link and parentheses": `https://x.example/${")".repeat(MB)}a`,
  "spaced digits": `1 ${"111 ".repeat(MB / 4)}`,
  "reference words": "order A1234 ".repeat(MB / 12),
  "brackets": "[".repeat(MB),
  "letters without an @": "a".repeat(MB),
  "address characters without an @": "a.b-c_d+e%f'g=".repeat(MB / 14),
  "a long local part before every @": `${"a".repeat(1000)}@`.repeat(MB / 1001),
  "dotless domains": "a@b".repeat(MB / 3),
  "markdown mailto links": "[](mailto:".repeat(MB / 10),
  "markdown links in brackets": "[[a](".repeat(MB / 5),
  "angle links": "<mailto:".repeat(MB / 8),
  "tags never closed": "<a".repeat(MB / 2),
  "commas between letters": `a${",".repeat(MB)}b`,
  "separators between letters": `a${" ,".repeat(MB / 2)}b`,
  "a long picture address": `<img src="https://x.example/${"[](mailto:".repeat(MB / 10)}">`,
  "full-width at signs": "＠a".repeat(MB / 2),
  "ideographic dots after an at sign": `a@${"b。".repeat(MB / 2)}`,
  "combining marks before an at sign": `${"e\u0301".repeat(MB / 2)}@x`,
  "one domain label of a megabyte": `a@${"b".repeat(MB)}`,
  "an amount with separators between its digits": `€1${". ".repeat(MB / 2)}1`,
};

/** What reads a message under the server's lock: the one-time code check, the requests and snippets, the answers. */
const WORK = {
  /** The screening gate's check of a one-time code (gate.ts), and the readers it and the requests use. */
  gate(body: string): void {
    looksLikeCode({ subject: body, text: body, html: body, automated: true });
    looksLikeCode({ subject: "Your code", text: null, html: body, automated: true });
    holdsCode(body);
    // Codes, then a gap, then the words: no code near any word, so each code met every word before 0.1.3.
    holdsCode(`${" 482913".repeat(body.length / 14)}${" x".repeat(50)}${"code ".repeat(body.length / 10)}`);
    plainText(null, body);
    modelText(body, null);
    modelText(null, body);
  },
  requests(body: string): void {
    const messages = [{ fromName: body, text: body, html: body, at }];
    summarizeRequest("m", body, messages, "id");
    detailsRequest("m", body, messages, "id", "receipt", at);
    eventRequest("m", body, messages, "id", at);
    categorizeRequest("m", { subject: body, from: { name: body, email: "a@b.example" }, listId: null, automated: true, text: body, html: body }, "id");
    withoutAddresses(body);
    snippetText(body, null);
    snippetText(null, body);
    readingText(null, body);
  },
  /** A model's answers (the server checks every fact) and the names and headers read with them. */
  async answers(body: string): Promise<void> {
    const at = Date.UTC(2026, 10, 25);
    const answer = { party: body, amount: body, currency: body, refund: false, state: body, dueDate: body, what: body, status: body, about: body, date: body, time: body, endTime: body, reference: body, summary: body };
    acceptSummary(body);
    plainLine(body, 200);
    checkDetails(answer, body, "receipt", [{ text: body, at }]);
    checkEvent(answer, body, [{ text: body, at }], body);
    checkReference(body, body);
    partyName(body);
    withoutSender(body, body);
    withoutRelativeWords(body);
    normalizeListId(body);
    await new PicturePlans().present("m", body, undefined);
  },
};
export type Work = keyof typeof WORK;

/** Runs the work on the named body in a worker; resolves with how long it took, rejects once `ms` has passed. */
export function within(ms: number, work: Work, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { work, body } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`${work} on "${body}" took over ${ms} ms`));
    }, ms);
    worker.once("message", (took: number) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(took);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

if (!isMainThread) {
  const { work, body } = workerData as { work: Work; body: string };
  const started = performance.now();
  await WORK[work](BODIES[body]!);
  parentPort!.postMessage(performance.now() - started);
}
