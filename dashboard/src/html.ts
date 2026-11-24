// A small HTML template tag. Every string put into a template is escaped; only `Html` values (other templates, or
// markup this package wrote itself) go in as they are. Attribute values must always be quoted with `"`.

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export type Child = Html | string | number | boolean | null | undefined | readonly Child[];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for use in element content or a quoted attribute value. */
export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

function render(child: Child): string {
  if (child instanceof Html) return child.value;
  if (Array.isArray(child)) return child.map(render).join("");
  if (typeof child === "string") return escape(child);
  if (typeof child === "number") return String(child);
  return "";
}

/** html`<p>${text}</p>`: strings are escaped; false, null and undefined render nothing. */
export function html(strings: TemplateStringsArray, ...values: Child[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i] as Child) + strings[i + 1]!;
  return new Html(out);
}

/** Markup this package wrote itself and trusts. Never pass text from mail, people or the service. */
export function trusted(markup: string): Html {
  return new Html(markup);
}

/** An attribute that is present or absent, such as `checked` or `selected`. */
export function flag(name: string, on: boolean | undefined): Html {
  return new Html(on ? ` ${name}` : "");
}
