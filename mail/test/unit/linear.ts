// Speed tests that fail instead of hanging (0.1.3, after a security review), like the server's test/linear.ts: a pattern
// that scans back and forth, or a parser that searches every open element at each tag, blocks the event loop, so
// node:test's own timeout never fires. `within` runs one piece of work in a worker thread and terminates it at the
// limit (V8 stops a worker even inside a regex), so a regression fails the test in seconds. This file is both the
// helper and the worker's entry. Made-up `.example` addresses only.

import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { rebuildMessage } from "../../src/gmail/payload.ts";
import { messageIds, stripBrackets } from "../../src/message/headers.ts";
import { htmlToText } from "../../src/message/html-to-text.ts";
import { MAX_HTML_DEPTH, MAX_PARSED_HTML } from "../../src/message/html-depth.ts";
import { parseMessage } from "../../src/message/parse.ts";
import { remotePictures, rewritePictures } from "../../src/message/pictures.ts";
import { sanitizeHtml } from "../../src/message/sanitize.ts";

export const MB = 1024 * 1024;

/** `unit` repeated to at least `length` characters. */
const fill = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length));
/** More elements open than any parser is given. */
const DEEPEST = "<b>".repeat(MAX_HTML_DEPTH + 10);

/**
 * HTML built to make htmlparser2 nest deeper at every tag (1 MB of "<b>" took 42.6 s in the sanitizer before 0.1.3),
 * search its open elements at every tag, or make the sanitizer copy what it wrote, by length.
 */
export const HTML: Record<string, (length: number) => string> = {
  "<b> never closed": (length) => fill("<b>", length),
  "<span> never closed": (length) => fill("<span>", length),
  "<div><span> never closed": (length) => fill("<div><span>", length),
  "closing tags that close nothing, at the deepest": (length) => DEEPEST + fill("</x>", length),
  "<b>, then as many </i>": (length) => fill("<b>", length / 2) + fill("</i>", length / 2),
  "<i></i> at the deepest": (length) => DEEPEST + fill("<i></i>", length),
  "style blocks at the deepest": (length) => DEEPEST + fill("<style>a</style>", length),
  "<desc>, each a way into foreign content": (length) => fill("<desc>", length),
  "<svg> never closed": (length) => fill("<svg>", length),
  "<form> at the deepest": (length) => DEEPEST + fill("<form>", length),
  "<p><div></p>": (length) => fill("<p><div></p>", length),
  "a \"<\" before each tag dropped and \"b>\" after it": (length) => DEEPEST + fill("<<i>b>", length),
  "a script at the deepest, then <b>": (length) => `${DEEPEST}<script>${fill("<b>", length)}`,
  "a CDATA section, then <b>": (length) => `<![CDATA[${fill("<b>", length)}`,
  "an iframe, then <b>": (length) => `<iframe>${fill("<b>", length)}`,
  "tracking pixels between paragraphs": (length) =>
    fill('<p>Words in a paragraph between two pictures.</p><img src="https://track.example/p.gif" width="1" height="1">', length),
  // Under the cap, or the cut leaves the tag unfinished and no reader sees it.
  "a picture's width of spaces": (length) => `<img src="https://cdn.example/a.png" width="1${" ".repeat(length - 100)}x">`,
};

/** A message whose only part is `html`. */
const htmlMessage = (html: string) => `From: a@sender.example\r\nSubject: Hi\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;

/** One character, a megabyte of ">" and another: 256 KB of ">" in a Message-ID took 25.6 s before 0.1.3. */
export const BRACKETS = `a${">".repeat(MB)}b`;
/** The same with 450 KB of ">", so four such fields fit the parser's 2 MB of headers (counted over all parts). */
const FIELD = `a${">".repeat(450_000)}b`;

/** Which HTML, and how long. */
export interface Input {
  shape: string;
  length: number;
}

/** What reads mail before it's stored, and what the server's picture pass reads again each time a message is opened. */
const WORK: Record<"html" | "headers" | "rebuild", (input: Input) => Promise<Record<string, number>>> = {
  /** Each reader of mail HTML, timed apart. */
  async html({ shape, length }) {
    const html = HTML[shape]!(length);
    const took: Record<string, number> = {};
    const time = async (name: string, read: () => unknown) => {
      const started = performance.now();
      await read();
      took[name] = performance.now() - started;
    };
    await time("sanitizeHtml", () => sanitizeHtml(html));
    await time("htmlToText", () => htmlToText(html));
    await time("remotePictures", () => remotePictures(html));
    await time("rewritePictures", () => rewritePictures(html, () => ({ kind: "remove" })));
    await time("parseMessage", () => parseMessage(htmlMessage(html), { ownAddresses: [] }));
    return took;
  },
  /** Message ids, read directly and from a whole message (an attachment's Content-ID too). */
  async headers() {
    const started = performance.now();
    messageIds(BRACKETS);
    messageIds(`<${BRACKETS}>`);
    stripBrackets(BRACKETS);
    const raw = [
      `Message-ID: ${FIELD}`, `In-Reply-To: ${FIELD}`, `References: ${FIELD}`, "From: a@sender.example",
      'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", "Hi.", "--b",
      "Content-Type: image/png", `Content-ID: <${FIELD}>`, "Content-Disposition: inline", "", "PNG", "--b--", "",
    ].join("\r\n");
    await parseMessage(raw, { ownAddresses: [] });
    return { headers: performance.now() - started };
  },
  /** The large-message rebuild reading a forwarded message's Content-Transfer-Encoding, a megabyte of "(". */
  async rebuild() {
    const started = performance.now();
    const part = (name: string, value: string) => ({ name, value });
    rebuildMessage({
      headers: [part("From", "a@sender.example"), part("Content-Type", "message/rfc822"), part("Content-Transfer-Encoding", "(".repeat(MB))],
      body: { size: 3, data: Buffer.from("Hi.").toString("base64url") },
    });
    return { rebuild: performance.now() - started };
  },
};
export type Work = keyof typeof WORK;

/** Runs the work in a worker; resolves with how long each part took, rejects once `ms` has passed. */
export function within(ms: number, work: Work, input: Input = { shape: "", length: 0 }): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { work, input } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`${work} ${input.shape} ${input.length || ""} took over ${ms} ms`));
    }, ms);
    worker.once("message", (took: Record<string, number>) => {
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

export { MAX_PARSED_HTML };

if (!isMainThread) {
  const { work, input } = workerData as { work: Work; input: Input };
  parentPort!.postMessage(await WORK[work](input));
}
