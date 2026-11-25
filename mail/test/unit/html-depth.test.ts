/**
 * Mail HTML bounded before any parser reads it (html-depth.ts; 0.1.3, after a security review): ordinary mail comes
 * back unchanged; past MAX_HTML_DEPTH open elements, further opening tags go and their content stays; no parser then
 * nests deeper, whatever the HTML; and HTML past MAX_PARSED_HTML is cut there for every reader alike.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { Parser } from "htmlparser2";
import PostalMime from "postal-mime";
import { boundedHtml, MAX_HTML_DEPTH, MAX_PARSED_HTML } from "../../src/message/html-depth.ts";
import { htmlToText } from "../../src/message/html-to-text.ts";
import { rewritePictures } from "../../src/message/pictures.ts";
import { sanitizeHtml } from "../../src/message/sanitize.ts";
import { HOSTILE } from "./hostile-html.ts";

/** The most elements htmlparser2 has open at once reading `html`. */
function deepest(html: string): number {
  let open = 0;
  let most = 0;
  const parser = new Parser({ onopentagname: () => (most = Math.max(most, ++open)), onclosetag: () => open-- }, { decodeEntities: true });
  parser.end(html);
  return most;
}

const nest = (open: string, close: string, levels: number, inner: (level: number) => string) =>
  Array.from({ length: levels }, (_, level) => open + inner(level)).join("") + close.repeat(levels);
const count = (text: string, part: string) => text.split(part).length - 1;
const DEEPEST = "<b>".repeat(MAX_HTML_DEPTH);

describe("ordinary mail", () => {
  it("comes back as it was: the fixtures, the hostile samples, deep tables and a long thread of quoted replies", async () => {
    const samples = [...HOSTILE];
    for (const file of readdirSync(new URL("../fixtures/", import.meta.url))) {
      const { html } = await PostalMime.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url)));
      if (html) samples.push(html);
    }
    samples.push(nest('<table width="600"><tr><td style="padding:4px">', "</td></tr></table>", 30, (level) => `<p>Level ${level}</p>`));
    const thread = nest('<div class="gmail_quote"><blockquote class="gmail_quote">', "</blockquote></div>", 120, (level) => `<div>Reply ${level}</div>`);
    assert.ok(deepest(thread) > 200, "deeper than any newsletter");
    samples.push(thread);
    for (const html of samples) assert.equal(boundedHtml(html), html);
  });
});

describe("past the deepest a parser is given", () => {
  it("further opening tags go, their content and every closing tag stay", () => {
    const html = nest("<div>", "</div>", MAX_HTML_DEPTH + 44, (level) => `Level ${level} `);
    const bounded = boundedHtml(html);
    assert.equal(count(bounded, "<div>"), MAX_HTML_DEPTH);
    assert.equal(count(bounded, "</div>"), MAX_HTML_DEPTH + 44);
    assert.equal(deepest(bounded), MAX_HTML_DEPTH);
    const text = htmlToText(html);
    const sanitized = sanitizeHtml(html)!;
    for (const level of [0, MAX_HTML_DEPTH - 1, MAX_HTML_DEPTH, MAX_HTML_DEPTH + 43]) {
      assert.ok(text.includes(`Level ${level}`) && sanitized.includes(`Level ${level}`), `level ${level}`);
    }
  });

  it("an empty comment stands in for a dropped tag, so the text around it can't join into a tag", () => {
    const html = `${DEEPEST}<<i>b>joined?`;
    assert.equal(boundedHtml(html), `${DEEPEST}<<!>b>joined?`);
    assert.equal(deepest(boundedHtml(html)), MAX_HTML_DEPTH, "no <b> made of the text");
    assert.match(sanitizeHtml(html)!, /&lt;b&gt;joined\?/);
  });

  it("raw-text and void elements are never dropped: a script stays hidden, a style block and a picture stay", () => {
    const html = `${DEEPEST}<script>hidden <b>x</b></script><style>p{color:red}</style><img src="https://cdn.example/a.png" alt="A"><br>`;
    assert.equal(boundedHtml(html), html);
    const sanitized = sanitizeHtml(html)!;
    assert.ok(!sanitized.includes("hidden") && !htmlToText(html).includes("hidden"));
    assert.match(sanitized, /<style>p\{color:red\}<\/style><img src="https:\/\/cdn\.example\/a\.png" alt="A" \/><br \/>/);
  });

  it("nothing nests deeper, whatever the HTML: random deep tag soup", () => {
    const tags = [
      "<b>", "<i>", "<div>", "<p>", "</p>", "<span>", "<table>", "<tr>", "<td>", "<li>", "<a href='#x'>", "<form>", "<svg>",
      "<math>", "<desc>", "<foreignObject>", "<clippath>", "</clipPath>", "<mi>", "<title>t</title>", "<style>s</style>",
      "<script>x</script>", "<textarea>z</textarea>", "<iframe>f</iframe>", "<image>", "<br/>", "</br>", "</x>", "</b>",
      "</div>", "<!-- c -->", "<![CDATA[d]]>", "text", " < ", "<", "<<i>b>", "<path/>", "<select>", "<option>", "<h1>",
    ];
    for (let round = 0; round < 60; round++) {
      const soup = Array.from({ length: 3_000 }, () => (Math.random() < 0.5 ? "<b>" : tags[Math.floor(Math.random() * tags.length)]!)).join("");
      // At most the bound, one raw-text element, and a "</p>" opening and closing a paragraph of its own.
      assert.ok(deepest(boundedHtml(soup)) <= MAX_HTML_DEPTH + 2, `round ${round}`);
      assert.ok(deepest(boundedHtml(soup.replaceAll("<![CDATA[", "<!&#91;CDATA["))) <= MAX_HTML_DEPTH + 2, `round ${round}, as the sanitizer reads it`);
    }
  });
});

describe("HTML longer than a parser reads", () => {
  it("is cut there, for every reader alike", () => {
    const html = `<p>${"a".repeat(MAX_PARSED_HTML)}</p><p>beyond the cut</p>`;
    assert.equal(boundedHtml(html).length, MAX_PARSED_HTML);
    assert.ok(!sanitizeHtml(html)!.includes("beyond") && !htmlToText(html).includes("beyond"));
  });

  it("never between the two halves of a character", () => {
    const bounded = boundedHtml(`${"a".repeat(MAX_PARSED_HTML - 1)}😀z`);
    assert.equal(bounded.length, MAX_PARSED_HTML - 1);
    assert.ok(bounded.endsWith("a"));
  });
});

describe("a picture taken out", () => {
  it("goes whole; the class it's written with on the way can't be written by a message", () => {
    const html = '<p>a<img src="https://track.example/p.gif" alt="t" width="1" height="1">b<img class="usual-removed-x" alt="kept"></p>';
    assert.equal(rewritePictures(html, () => ({ kind: "remove" })), '<p>ab<img class="usual-removed-x" alt="kept" /></p>');
  });
});
