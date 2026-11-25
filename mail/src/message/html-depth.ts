/**
 * Mail HTML bounded so htmlparser2 reads it in linear time (0.1.3, after a security review). htmlparser2 12 keeps the
 * open elements in an array it adds each one to at the front (`unshift`) and searches at each closing tag (`indexOf`),
 * so a tag costs as much as there are elements open around it: 1 MB of "<b>" took 42.6 s in the sanitizer, inside
 * `parseMessage`, and the picture pass reads a message's HTML again each time it's opened.
 *
 * So before any reader parses HTML, `boundedHtml` reads it once with htmlparser2's own parser and drops each opening
 * tag that would make more than MAX_HTML_DEPTH elements open, the way browsers stop nesting past a depth: the element's
 * content stays where it was, and so does every closing tag. An empty comment (`<!>`) takes the tag's place, so the
 * text on either side can't join into a new tag ("<" before it and "b>" after it). Every parser then reads the same
 * elements open at each point as that first read, never more than MAX_HTML_DEPTH and one raw-text element (script,
 * style and the like are never dropped: their content is text to every parser, and a raw-text element holds no
 * other). HTML longer than MAX_PARSED_HTML is cut there first, so what follows is read by no parser.
 *
 * Ordinary mail is far shallower (a newsletter's nested tables run to a few dozen), and comes back unchanged.
 */
import { Parser } from "htmlparser2";

/**
 * The most elements open at once that a parser is given: half as deep as Chromium's HTML parser nests (512), still
 * over eighty levels of quoted replies. Each tag costs the parser as much as the elements open around it, and
 * sanitize-html looks through all of them for each style block's text, so the bound also sets the worst case: 2 MB of
 * mismatched closing tags inside 256 open elements take the sanitizer about 0.3 s.
 */
export const MAX_HTML_DEPTH = 256;

/** The most HTML, in characters, a parser reads: twice the longest the server shows (core's MAX_SHOWN_HTML_LENGTH). */
export const MAX_PARSED_HTML = 2_000_000;

/** Elements htmlparser2's tokenizer reads as text up to their own closing tag, outside SVG and MathML. */
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

/** What stands in for a dropped tag: an empty comment, read as such by htmlparser2 and by browsers. */
const STAND_IN = "<!>";

/** The parser every reader uses (the same options), counting the open elements and noting each tag it drops. */
class DepthBound extends Parser {
  /** Where each dropped tag starts and ends (after its `>`, or the end of the HTML). */
  readonly dropped: Array<[number, number]> = [];
  readonly #html: string;
  readonly #count: { open: number };
  #dropping = -1;

  constructor(html: string) {
    // htmlparser2 announces every element it puts on its stack and closes every one it takes off (a void element
    // opens and closes at once), so the count is the stack's length whenever a tag starts.
    const count = { open: 0 };
    super({ onopentagname: () => count.open++, onclosetag: () => count.open-- }, { decodeEntities: true });
    this.#html = html;
    this.#count = count;
  }

  override onopentagname(start: number, endIndex: number): void {
    const name = this.#html.slice(start, endIndex).toLowerCase();
    const foreign = this.isInForeignContext();
    // Nothing is dropped that wouldn't be put on the stack (a void element; "image" is "img" outside SVG), nor a
    // raw-text element, whose content every parser reads as text.
    const stays = this.isVoidElement(name === "image" && !foreign ? "img" : name) || (RAW_TEXT.has(name) && !foreign);
    if (this.#count.open >= MAX_HTML_DEPTH && !stays) {
      // `start` is the name's first character, right after the "<".
      this.#dropping = start - 1;
      return;
    }
    super.onopentagname(start, endIndex);
  }

  override onopentagend(endIndex: number): void {
    if (!this.#endDropped(endIndex)) super.onopentagend(endIndex);
  }

  override onselfclosingtag(endIndex: number): void {
    if (!this.#endDropped(endIndex)) super.onselfclosingtag(endIndex);
  }

  override onend(): void {
    // A dropped tag the HTML ends inside of runs to its end.
    if (this.#dropping >= 0) this.#endDropped(this.#html.length - 1);
    super.onend();
  }

  #endDropped(endIndex: number): boolean {
    if (this.#dropping < 0) return false;
    this.dropped.push([this.#dropping, endIndex + 1]);
    this.#dropping = -1;
    return true;
  }
}

/** The HTML cut to MAX_PARSED_HTML characters, never inside a character written as two. */
function cut(html: string): string {
  if (html.length <= MAX_PARSED_HTML) return html;
  const code = html.charCodeAt(MAX_PARSED_HTML - 1);
  return html.slice(0, code >= 0xd800 && code <= 0xdbff ? MAX_PARSED_HTML - 1 : MAX_PARSED_HTML);
}

/** The HTML as every parser should be given it: at most MAX_PARSED_HTML long, nested at most MAX_HTML_DEPTH deep. */
export function boundedHtml(html: string): string {
  const text = cut(html);
  const bound = new DepthBound(text);
  bound.end(text);
  if (!bound.dropped.length) return text;
  const parts: string[] = [];
  let from = 0;
  for (const [start, end] of bound.dropped) {
    parts.push(text.slice(from, start), STAND_IN);
    from = end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}
