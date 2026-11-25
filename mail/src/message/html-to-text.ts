/**
 * Plain text from HTML, for messages that have no text part. Keeps paragraphs and line breaks, list
 * bullets and table cells apart, drops everything that isn't shown (head, style, script).
 */
import { Parser } from "htmlparser2";
import { boundedHtml } from "./html-depth.ts";

const HIDDEN = new Set(["head", "style", "script", "title", "template", "noscript", "xml", "svg", "math"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "details", "dl", "dt", "div", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main",
  "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead", "ul",
]);

export function htmlToText(html: string): string {
  const out: string[] = [];
  let hidden = 0;
  let pre = 0;
  const lineBreak = (count: number) => out.push(count === 2 ? "\n\n" : "\n");

  const parser = new Parser(
    {
      onopentag(name) {
        if (HIDDEN.has(name)) hidden++;
        if (hidden) return;
        if (name === "pre") pre++;
        if (name === "br") lineBreak(1);
        else if (name === "li") out.push("\n- ");
        else if (name === "tr") lineBreak(1);
        else if (name === "td" || name === "th") out.push(" ");
        else if (name === "hr") out.push("\n---\n");
        else if (BLOCK.has(name)) lineBreak(2);
      },
      ontext(text) {
        if (hidden) return;
        out.push(pre ? text : text.replace(/[ \t\r\n\f ]+/g, (space) => (space.includes(" ") ? " " : " ")));
      },
      onclosetag(name) {
        if (HIDDEN.has(name)) {
          hidden = Math.max(0, hidden - 1);
          return;
        }
        if (hidden) return;
        if (name === "pre") pre = Math.max(0, pre - 1);
        if (BLOCK.has(name)) lineBreak(2);
      },
    },
    { decodeEntities: true },
  );
  parser.write(boundedHtml(html));
  parser.end();
  return tidy(out.join(""));
}

function tidy(text: string): string {
  return text
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
