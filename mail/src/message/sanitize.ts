/**
 * Sanitizes mail HTML by an allow-list, with sanitize-html (htmlparser2 underneath, no DOM needed).
 *
 * Kept: text formatting, tables, images (http, https, cid: and data: images), links (http, https, mailto,
 * tel and in-page anchors), and <style> blocks and style attributes after the CSS filter in css.ts.
 * Dropped: scripts, forms and their controls, frames, objects, embeds, SVG and MathML, <base>, <meta>,
 * <link> (external style sheets), event handlers and every attribute not on the list. Remote images are
 * left as they are when a message is read; when the server serves it, it runs the HTML through here again with a
 * `PictureHook` that decides each picture from the web (shown through the server, held back or taken out).
 */
import sanitizeHtmlLib from "sanitize-html";
import { sanitizeStyleAttribute, sanitizeStylesheet } from "./css.ts";
import { boundedHtml } from "./html-depth.ts";
import { canonicalPictureUrl, isRemote, isTinyOrHidden, type PictureDecision, type PictureHook, type PictureSite } from "./picture-refs.ts";

const ALLOWED_TAGS = [
  "a", "abbr", "acronym", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br",
  "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt",
  "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i",
  "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp",
  "section", "small", "span", "strike", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul", "var", "wbr",
];

const GLOBAL_ATTRIBUTES = [
  "align", "bgcolor", "border", "class", "color", "dir", "height", "id", "lang", "style", "title", "valign",
  "width", "role", "aria-*",
];

const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  "*": GLOBAL_ATTRIBUTES,
  a: ["href", "name"],
  img: ["src", "alt", "hspace", "vspace"],
  table: ["background", "cellpadding", "cellspacing", "frame", "rules", "summary"],
  td: ["background", "colspan", "rowspan", "headers", "nowrap", "scope", "abbr", "axis"],
  th: ["background", "colspan", "rowspan", "headers", "nowrap", "scope", "abbr", "axis"],
  tr: ["background"],
  col: ["span"],
  colgroup: ["span"],
  font: ["face", "size"],
  ol: ["start", "type", "reversed"],
  ul: ["type"],
  li: ["value", "type"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
  time: ["datetime"],
  details: ["open"],
};

/** Raw-text and hidden elements whose content must not leak out as text when the element is dropped. */
const NON_TEXT_TAGS = [
  "script", "textarea", "option", "select", "xmp", "title", "noscript", "noembed", "noframes", "iframe",
  "template", "object", "applet", "svg", "math",
];

const IMAGE_SCHEMES = ["http", "https", "cid", "data"];

const OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: IMAGE_SCHEMES, table: IMAGE_SCHEMES, td: IMAGE_SCHEMES, th: IMAGE_SCHEMES, tr: IMAGE_SCHEMES },
  allowedSchemesAppliedToAttributes: ["href", "src", "cite", "background", "action", "formaction", "poster"],
  allowProtocolRelative: true,
  disallowedTagsMode: "discard",
  nonTextTags: NON_TEXT_TAGS,
  allowVulnerableTags: true,
  // The CSS filter (css.ts) reads and writes style attributes itself; sanitize-html writing them again with its own
  // reader would put out something other than what was checked.
  parseStyleAttributes: false,
  transformTags: { "*": transform },
};

/**
 * A pass that decides pictures from the web: the hook, and the class an `<img>` it takes out is written with. Such an
 * `<img>` is written as nothing but that class, then taken out of what the sanitizer wrote, so it goes whole, its alt
 * text with it. The class is new on every pass, so no message can write it. (The sanitizer's own `exclusiveFilter`
 * copies everything written before a picture to take it out: once per picture, up to 1.3 s for 2 MB of tracking
 * pixels.)
 */
interface PicturePass {
  hook: PictureHook;
  removed: string;
}

function optionsFor(pass: PicturePass | undefined): sanitizeHtmlLib.IOptions {
  if (!pass) return OPTIONS;
  return { ...OPTIONS, transformTags: { "*": (tagName, attribs) => transform(tagName, attribs, pass) } };
}

function transform(tagName: string, attribs: sanitizeHtmlLib.Attributes, pass?: PicturePass): sanitizeHtmlLib.Tag {
  const out: sanitizeHtmlLib.Attributes = { ...attribs };
  if (out.style !== undefined) {
    const style = sanitizeStyleAttribute(out.style, pass?.hook);
    if (style) out.style = style;
    else delete out.style;
  }
  if (tagName === "a" && out.href !== undefined && !linkIsAllowed(out.href)) delete out.href;
  if (tagName === "img" && out.src !== undefined && !imageIsAllowed(out.src)) delete out.src;
  if (out.background !== undefined && !imageIsAllowed(out.background)) delete out.background;
  if (pass && decidePictures(tagName, out, pass) === "remove") return { tagName, attribs: { class: pass.removed } };
  if (tagName === "style") return { tagName, attribs: {} };
  return { tagName, attribs: out };
}

/**
 * Hands an element's pictures from the web to the hook: an <img>'s src, and a table part's background. "remove" when
 * the `<img>` is to go whole.
 */
function decidePictures(tagName: string, out: sanitizeHtmlLib.Attributes, pass: PicturePass): "remove" | undefined {
  let removed: "remove" | undefined;
  if (tagName === "img" && out.src !== undefined && isRemote(out.src)) {
    const decision = decide(out.src, "img", isTinyOrHidden(out), pass.hook);
    if (decision.kind === "show") out.src = decision.src;
    else delete out.src;
    if (decision.kind === "remove") removed = "remove";
  }
  if (out.background !== undefined && isRemote(out.background)) {
    const decision = decide(out.background, "background", false, pass.hook);
    if (decision.kind === "show") out.background = decision.src;
    else delete out.background;
  }
  return removed;
}

/** The hook's decision for one address; an address that can't be fetched, or a new one that would be, is held. */
function decide(value: string, site: PictureSite, tiny: boolean, hook: PictureHook): PictureDecision {
  const url = canonicalPictureUrl(value);
  if (!url) return { kind: "hold" };
  const decision = hook({ url, site, tiny });
  if (decision.kind === "show" && isRemote(decision.src)) return { kind: "hold" };
  return decision;
}

function compactUrl(url: string): string {
  return url.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
}

function linkIsAllowed(href: string): boolean {
  const url = compactUrl(href);
  return /^(?:https?:|mailto:|tel:|#)/.test(url) || url.startsWith("//");
}

function imageIsAllowed(src: string): boolean {
  const url = compactUrl(src);
  return /^(?:https?:|cid:|data:image\/)/.test(url) || url.startsWith("//");
}

/**
 * Returns safe HTML, or undefined when nothing is left to show. With `pictures`, each picture from the web (an
 * <img>'s src, a table part's background, a url() in a style) is decided by it, in the order the HTML has them
 * (style blocks last), and fonts from the web are taken out.
 */
export function sanitizeHtml(html: string, pictures?: PictureHook): string | undefined {
  const pass = pictures ? { hook: pictures, removed: `usual-removed-${crypto.randomUUID()}` } : undefined;
  // Bounded as sanitize-html will parse it: it first writes "<![CDATA[" as "<!&#91;CDATA[" (so what such a section
  // hides is read as markup), and the bound must see the same tags (html-depth.ts).
  const written = sanitizeHtmlLib(boundedHtml(html.replaceAll("<![CDATA[", "<!&#91;CDATA[")), optionsFor(pass));
  const cleaned = pass ? written.replaceAll(`<img class="${pass.removed}" />`, "") : written;
  // sanitize-html passes <style> text through untouched; the CSS filter decides what of it stays.
  const out = cleaned
    .replace(/<style>([\s\S]*?)<\/style>/gi, (_, css: string) => {
      const safe = sanitizeStylesheet(css, pictures);
      return safe ? `<style>${safe}</style>` : "";
    })
    .trim();
  return out ? out : undefined;
}
