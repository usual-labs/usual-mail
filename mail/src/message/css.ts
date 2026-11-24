/**
 * CSS from mail, made safe to show: no external style sheets (@import), no script-like constructs
 * (expression(), behaviors, bindings), no URLs other than http(s), cid: and data: images. Remote images
 * stay. Any parse error drops the whole style rather than guessing.
 */
import { parse, type ChildNode, type Container, type Declaration } from "postcss";
import { cssAddresses, decodeCss, MAX_NESTING, nestingDepth } from "./css-tokens.ts";
import { rewriteCssPictures, servableCss, type PictureHook } from "./picture-refs.ts";

const ALLOWED_AT_RULES = new Set([
  "media", "supports", "font-face", "keyframes", "-webkit-keyframes", "-moz-keyframes", "page", "layer",
  "container",
]);
const BLOCKED_PROPERTIES = /^(?:-ms-|-moz-|-webkit-)?(?:behavior|binding)$|^-moz-binding$/i;
const SCRIPT_LIKE = /expression\s*\(|javascript\s*:|vbscript\s*:|livescript\s*:|-moz-binding/i;
/**
 * A declaration's name: an identifier, a vendor prefix or a custom property's `--`. Anything else goes: postcss lets
 * a string in a name run past a newline that ends it for a browser, hiding declarations behind it (the security
 * review's second round, 2026-11-18).
 */
const PROPERTY = /^(--)?-?[A-Za-z_][\w-]*$/;

/**
 * Sanitizes the text of a <style> element. Returns undefined when nothing safe is left. With `pictures`, each picture
 * from the web is decided by it and fonts from the web are taken out (see picture-refs.ts).
 */
export function sanitizeStylesheet(css: string, pictures?: PictureHook): string | undefined {
  // Too deep to be real styling, and deep enough to overflow a stack somewhere: read no further.
  if (nestingDepth(css) > MAX_NESTING) return undefined;
  let root;
  try {
    root = parse(css);
  } catch {
    return undefined;
  }
  cleanContainer(root, pictures, false);
  root.walkComments((comment) => void comment.remove());
  const text = root.toString();
  // The block as a whole is read once more, as a browser reads it: whatever it holds outside a declaration counts.
  if (!(pictures ? servableCss(text, Infinity) : wholeIsSafe(text))) return undefined;
  const out = escapeMarkup(text).trim();
  return out || undefined;
}

/** Sanitizes a style="" attribute. Returns undefined when nothing safe is left. `pictures` as for a stylesheet. */
export function sanitizeStyleAttribute(value: string, pictures?: PictureHook): string | undefined {
  if (nestingDepth(value) > MAX_NESTING) return undefined;
  let root;
  try {
    root = parse(`x{${value}}`);
  } catch {
    return undefined;
  }
  const rule = root.nodes[0];
  // A value that closes the block early to add rules of its own is dropped whole.
  if (root.nodes.length !== 1 || !rule || rule.type !== "rule") return undefined;
  const parts: string[] = [];
  for (const node of rule.nodes) {
    if (node.type !== "decl" || !declarationIsSafe(node)) continue;
    const value = pictures ? rewriteCssPictures(node.value, pictures, false) : node.value;
    if (value === null) continue;
    parts.push(`${node.prop}:${value}${node.important ? " !important" : ""}`);
  }
  const text = parts.join(";");
  // The attribute as a whole is read once more, as a browser reads it.
  if (!(pictures ? servableCss(text, Infinity) : wholeIsSafe(text))) return undefined;
  const out = escapeMarkup(text).trim();
  return out || undefined;
}

function cleanContainer(container: Container, pictures: PictureHook | undefined, fontFace: boolean): void {
  const remove: ChildNode[] = [];
  container.each((node) => {
    if (node.type === "atrule") {
      if (!ALLOWED_AT_RULES.has(node.name.toLowerCase()) || SCRIPT_LIKE.test(decodeCss(node.params))) {
        remove.push(node);
        return;
      }
      if (node.nodes) cleanContainer(node, pictures, fontFace || node.name.toLowerCase() === "font-face");
    } else if (node.type === "rule") {
      if (SCRIPT_LIKE.test(decodeCss(node.selector))) remove.push(node);
      else cleanContainer(node, pictures, fontFace);
    } else if (node.type === "decl") {
      if (!declarationIsSafe(node)) {
        remove.push(node);
        return;
      }
      // What is written out is what was checked: postcss would otherwise write the value as it came, comments and all.
      delete node.raws.value;
      if (!pictures) return;
      const value = rewriteCssPictures(node.value, pictures, fontFace);
      if (value === null) remove.push(node);
      else node.value = value;
    }
  });
  for (const node of remove) node.remove();
}

function declarationIsSafe(decl: Declaration): boolean {
  if (!PROPERTY.test(decl.prop)) return false;
  const prop = decodeCss(decl.prop).trim();
  if (BLOCKED_PROPERTIES.test(prop)) return false;
  if (SCRIPT_LIKE.test(decodeCss(decl.value))) return false;
  return urlsAreSafe(decl.value);
}

/**
 * Every address the value loads must be http(s), protocol-relative, cid: or a data: picture, found the way a browser
 * reads CSS (css-tokens.ts): a value broken in a way that could hide an address is not safe.
 */
function urlsAreSafe(value: string, max?: number): boolean {
  const addresses = cssAddresses(value, max === undefined ? {} : { max });
  return addresses !== null && addresses.every((address) => urlIsSafe(address.value));
}

/** A whole stored attribute or block, read again: every address it loads is allowed, and nothing script-like. */
function wholeIsSafe(text: string): boolean {
  return urlsAreSafe(text, Infinity) && !SCRIPT_LIKE.test(decodeCss(text));
}

function urlIsSafe(url: string): boolean {
  const compact = url.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
  if (!compact) return true;
  if (compact.startsWith("//")) return true;
  if (/^(?:https?|cid):/.test(compact)) return true;
  return compact.startsWith("data:image/");
}

/** A style element ends at the first "</style". Escaping every "<" keeps the CSS inside it. */
function escapeMarkup(css: string): string {
  return css.replace(/</g, "\\3c ");
}
