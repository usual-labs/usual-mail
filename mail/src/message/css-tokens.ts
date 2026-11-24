/**
 * Reading CSS the way a browser does (CSS Syntax Level 3, the parts that matter here): comments only outside
 * strings, strings and their escapes, unquoted `url(` tokens, functions and their nesting, and escapes in names.
 * The sanitizer and the picture pass use it to find every address a value loads, so nothing hides behind a ")" in a
 * string, a function inside another, or comment markers inside strings (the security review of 2026-11-18).
 */

export type CssToken =
  | { type: "ws" | "comment" | "open" | "close" | "comma" | "other"; start: number; end: number; text: string }
  | { type: "ident" | "function"; start: number; end: number; name: string }
  | { type: "string" | "url"; start: number; end: number; value: string; bad: boolean };

const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isNameStart = (c: string | undefined) => c !== undefined && (/^[a-zA-Z_]$/.test(c) || c.charCodeAt(0) >= 0x80);
const isName = (c: string | undefined) => isNameStart(c) || (c !== undefined && /^[0-9-]$/.test(c));
const isNonPrintable = (c: string) => {
  const code = c.charCodeAt(0);
  return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
};

/** Splits CSS text into tokens. Never fails: what a browser would read as broken is marked `bad`. */
export function cssTokens(text: string): CssToken[] {
  const out: CssToken[] = [];
  let at = 0;
  const validEscape = (i: number) => text[i] === "\\" && text[i + 1] !== "\n" && text[i + 1] !== "\r" && text[i + 1] !== "\f";
  const startsIdent = (i: number) => {
    const c = text[i];
    if (c === "-") return isNameStart(text[i + 1]) || text[i + 1] === "-" || validEscape(i + 1);
    return isNameStart(c) || validEscape(i);
  };
  /** Reads the escape whose backslash is at `i`: the character it stands for and where it ends. */
  const escape = (i: number): [string, number] => {
    let j = i + 1;
    if (j >= text.length) return ["�", j];
    if (isHex(text[j])) {
      let hex = "";
      while (hex.length < 6 && isHex(text[j])) hex += text[j++];
      if (isWs(text[j])) j += text[j] === "\r" && text[j + 1] === "\n" ? 2 : 1;
      const code = Number.parseInt(hex, 16);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return [valid ? String.fromCodePoint(code) : "�", j];
    }
    return [text[j]!, j + 1];
  };
  const name = (i: number): [string, number] => {
    let value = "";
    let j = i;
    for (;;) {
      if (isName(text[j])) value += text[j++];
      else if (validEscape(j)) {
        const [c, next] = escape(j);
        value += c;
        j = next;
      } else return [value, j];
    }
  };

  while (at < text.length) {
    const start = at;
    const c = text[at]!;
    if (c === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      at = close < 0 ? text.length : close + 2;
      out.push({ type: "comment", start, end: at, text: text.slice(start, at) });
    } else if (isWs(c)) {
      while (isWs(text[at])) at++;
      out.push({ type: "ws", start, end: at, text: text.slice(start, at) });
    } else if (c === '"' || c === "'") {
      let value = "";
      let bad = false;
      at++;
      for (;;) {
        const d = text[at];
        if (d === undefined) break;
        if (d === c) {
          at++;
          break;
        }
        if (d === "\n" || d === "\r" || d === "\f") {
          bad = true; // the string ends unclosed at the line's end
          break;
        }
        if (d === "\\") {
          if (at + 1 >= text.length) at++;
          else if (text[at + 1] === "\n" || text[at + 1] === "\f") at += 2;
          else if (text[at + 1] === "\r") at += text[at + 2] === "\n" ? 3 : 2;
          else {
            const [e, next] = escape(at);
            value += e;
            at = next;
          }
          continue;
        }
        value += d;
        at++;
      }
      out.push({ type: "string", start, end: at, value, bad });
    } else if (startsIdent(at)) {
      const [id, next] = name(at);
      at = next;
      if (text[at] === "(" && id.toLowerCase() === "url") {
        at++;
        let look = at;
        while (isWs(text[look])) look++;
        if (text[look] === '"' || text[look] === "'") {
          out.push({ type: "function", start, end: at, name: id });
        } else {
          at = look;
          let value = "";
          let bad = false;
          for (;;) {
            const d = text[at];
            if (d === undefined) break;
            if (d === ")") {
              at++;
              break;
            }
            if (isWs(d)) {
              while (isWs(text[at])) at++;
              if (text[at] === ")" || text[at] === undefined) {
                if (text[at] === ")") at++;
                break;
              }
              bad = true;
            } else if (d === '"' || d === "'" || d === "(" || isNonPrintable(d)) {
              bad = true;
              at++;
            } else if (d === "\\") {
              if (validEscape(at)) {
                const [e, next] = escape(at);
                value += e;
                at = next;
              } else {
                bad = true;
                at++;
              }
            } else {
              value += d;
              at++;
            }
            if (bad) {
              // The rest of a bad url, to its ")" (escapes skipped), as a browser consumes it.
              while (at < text.length && text[at] !== ")") at += validEscape(at) ? escape(at)[1] - at : 1;
              if (text[at] === ")") at++;
              break;
            }
          }
          out.push({ type: "url", start, end: at, value, bad });
        }
      } else if (text[at] === "(") {
        at++;
        out.push({ type: "function", start, end: at, name: id });
      } else {
        out.push({ type: "ident", start, end: at, name: id });
      }
    } else if (c === "(") {
      at++;
      out.push({ type: "open", start, end: at, text: c });
    } else if (c === ")") {
      at++;
      out.push({ type: "close", start, end: at, text: c });
    } else if (c === ",") {
      at++;
      out.push({ type: "comma", start, end: at, text: c });
    } else {
      at++;
      out.push({ type: "other", start, end: at, text: c });
    }
  }
  return out;
}

/** Where a CSS value loads something: an address, and the span of text that says so. */
export interface CssAddress {
  /** The address, escapes resolved. */
  value: string;
  /** A whole `url(…)` or `src(…)` (replaced whole), or a string inside `image-set()` and its kin. */
  kind: "call" | "string";
  start: number;
  end: number;
  /** For a string: the whole `image-set(…)` (or kin) call it is in. */
  within?: { start: number; end: number };
}

/** The most addresses one value may load; a value with more is too many to read (and serve) and goes. */
export const MAX_ADDRESSES_PER_VALUE = 100;

/** The deepest rules may nest in a style block (or braces in an attribute) before the whole of it goes. */
export const MAX_NESTING = 16;

/** Functions whose bare strings are addresses. */
const STRING_ADDRESS_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "image", "-webkit-image", "cross-fade", "-webkit-cross-fade"]);

/**
 * Every address a CSS value loads, in order, or null when the value is broken in a way that could hide one: a bad
 * string or url, a `url(` or `src(` that holds anything but one string, or a string address that isn't whole.
 */
export function cssAddresses(text: string, options: { max?: number } = {}): CssAddress[] | null {
  const max = options.max ?? MAX_ADDRESSES_PER_VALUE;
  const tokens = cssTokens(text);
  const found: CssAddress[] = [];
  const stack: Array<{ name: string; start: number; strings: CssAddress[] }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if ((token.type === "string" || token.type === "url") && token.bad) return null;
    if (token.type === "url") {
      found.push({ value: token.value, kind: "call", start: token.start, end: token.end });
      if (found.length > max) return null;
    } else if (token.type === "function") {
      const lower = token.name.toLowerCase();
      if (lower === "url" || lower === "src") {
        // One string, then the closing ")" (or the end, which a browser closes for it).
        let j = i + 1;
        while (tokens[j]?.type === "ws" || tokens[j]?.type === "comment") j++;
        const argument = tokens[j];
        if (argument?.type !== "string" || argument.bad) return null;
        let k = j + 1;
        while (tokens[k]?.type === "ws" || tokens[k]?.type === "comment") k++;
        const close = tokens[k];
        if (close !== undefined && close.type !== "close") return null;
        found.push({ value: argument.value, kind: "call", start: token.start, end: close ? close.end : text.length });
        if (found.length > max) return null;
        i = close ? k : tokens.length;
        continue;
      }
      stack.push({ name: lower, start: token.start, strings: [] });
    } else if (token.type === "open") {
      stack.push({ name: "", start: token.start, strings: [] });
    } else if (token.type === "close") {
      const call = stack.pop();
      for (const string of call?.strings ?? []) string.within = { start: call!.start, end: token.end };
    } else if (token.type === "string" && STRING_ADDRESS_FUNCTIONS.has(stack.at(-1)?.name ?? "")) {
      const address: CssAddress = { value: token.value, kind: "string", start: token.start, end: token.end };
      stack.at(-1)!.strings.push(address);
      found.push(address);
      if (found.length > max) return null;
    }
  }
  // A call left open runs to the end, as a browser closes it.
  for (const call of stack) for (const string of call.strings) string.within = { start: call.start, end: text.length };
  return found;
}

/** How deep braces nest in CSS text, outside strings and comments: 1 for `a{color:red}`. */
export function nestingDepth(text: string): number {
  let depth = 0;
  let deepest = 0;
  for (const token of cssTokens(text)) {
    if (token.type !== "other") continue;
    if (token.text === "{") deepest = Math.max(deepest, ++depth);
    else if (token.text === "}") depth = Math.max(0, depth - 1);
  }
  return deepest;
}

/** CSS text as a browser reads it: comments outside strings removed, escapes resolved. For checks only. */
export function decodeCss(text: string): string {
  return cssTokens(text).map((token) => {
    switch (token.type) {
      case "comment":
        return "";
      case "string":
        return `"${token.value}"`;
      case "url":
        return `url(${token.value})`;
      case "function":
        return `${token.name}(`;
      case "ident":
        return token.name;
      default:
        return token.text;
    }
  }).join("");
}
