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

/** A pass that decides pictures from the web: the hook, and the `<img>` elements it took out. */
interface PicturePass {
  hook: PictureHook;
  removed: WeakSet<sanitizeHtmlLib.Attributes>;
}

function optionsFor(pass: PicturePass | undefined): sanitizeHtmlLib.IOptions {
  if (!pass) return OPTIONS;
  return {
    ...OPTIONS,
    transformTags: { "*": (tagName, attribs) => transform(tagName, attribs, pass) },
    // An <img> taken out as a tracker goes whole, its alt text with it.
    exclusiveFilter: (frame) => pass.removed.has(frame.attribs),
  };
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
  if (pass) decidePictures(tagName, out, pass);
  if (tagName === "style") return { tagName, attribs: {} };
  return { tagName, attribs: out };
}

/** Hands an element's pictures from the web to the hook: an <img>'s src, and a table part's background. */
function decidePictures(tagName: string, out: sanitizeHtmlLib.Attributes, pass: PicturePass): void {
  if (tagName === "img" && out.src !== undefined && isRemote(out.src)) {
    const decision = decide(out.src, "img", isTinyOrHidden(out), pass.hook);
    if (decision.kind === "show") out.src = decision.src;
    else delete out.src;
    if (decision.kind === "remove") pass.removed.add(out);
  }
  if (out.background !== undefined && isRemote(out.background)) {
    const decision = decide(out.background, "background", false, pass.hook);
    if (decision.kind === "show") out.background = decision.src;
    else delete out.background;
  }
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
  const pass = pictures ? { hook: pictures, removed: new WeakSet<sanitizeHtmlLib.Attributes>() } : undefined;
  const cleaned = sanitizeHtmlLib(html, optionsFor(pass));
  // sanitize-html passes <style> text through untouched; the CSS filter decides what of it stays.
  const out = cleaned
    .replace(/<style>([\s\S]*?)<\/style>/gi, (_, css: string) => {
      const safe = sanitizeStylesheet(css, pictures);
      return safe ? `<style>${safe}</style>` : "";
    })
    .trim();
  return out ? out : undefined;
}
