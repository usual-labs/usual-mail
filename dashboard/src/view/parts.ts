// Pieces several pages share: the hat (design/specs/hat.md), form fields, and a step that can't be undone.
import type { Inbox, TrustLevel } from "@usualmail/core";
import { HATS, hatFor } from "../hats.ts";
import { flag, html, type Child, type Html } from "../html.ts";
import { href, icon, postForm, type View } from "./layout.ts";
import { TRUST } from "./words.ts";

/** A hat label: the dot, then the name. `small` is for tags lines; `large` heads a card. */
export function hatLabel(inbox: Pick<Inbox, "name" | "color">, size: "small" | "normal" | "large" = "normal"): Html {
  const cls = size === "normal" ? "hat-label" : `hat-label ${size}`;
  return html`<span class="${cls}" data-hat="${hatFor(inbox.color).name}"><span class="hat-dot" aria-hidden="true"></span><span class="hat-name">${inbox.name}</span></span>`;
}

/** A hat chip that links somewhere, such as a filter. `current` marks the one in use. */
export function hatChip(view: View, inbox: Pick<Inbox, "name" | "color">, path: string, current: boolean): Html {
  return html`<a class="hat-chip" data-hat="${hatFor(inbox.color).name}" href="${href(view, path)}"${current ? html` aria-current="page"` : ""}><span class="hat-dot" aria-hidden="true"></span>${inbox.name}</a>`;
}

export interface FieldOptions {
  id: string;
  name: string;
  label: string;
  value?: string;
  hint?: Child;
  error?: string;
  /** Marks the field invalid when the message is shown elsewhere, such as at the top of the page. */
  invalid?: boolean;
  type?: "text" | "password" | "number" | "email";
  required?: boolean;
  autocomplete?: string;
  inputmode?: string;
  placeholder?: string;
  maxlength?: number;
  className?: string;
}

/** A labelled text input, with its hint and its error tied to it for screen readers. */
export function textField(o: FieldOptions): Html {
  const described = [o.hint ? `${o.id}-hint` : "", o.error ? `${o.id}-error` : ""].filter(Boolean).join(" ");
  return html`<div class="field${o.className ? ` ${o.className}` : ""}">
<label for="${o.id}">${o.label}</label>
${o.hint ? html`<p class="hint" id="${o.id}-hint">${o.hint}</p>` : ""}
<input type="${o.type ?? "text"}" id="${o.id}" name="${o.name}" value="${o.type === "password" ? "" : (o.value ?? "")}"${flag("required", o.required)}${
    o.autocomplete ? html` autocomplete="${o.autocomplete}"` : ""}${o.inputmode ? html` inputmode="${o.inputmode}"` : ""}${
    o.placeholder ? html` placeholder="${o.placeholder}"` : ""}${o.maxlength ? html` maxlength="${o.maxlength}"` : ""}${
    described ? html` aria-describedby="${described}"` : ""}${o.error || o.invalid ? html` aria-invalid="true"` : ""}>
${o.error ? html`<p class="field-error" id="${o.id}-error">${o.error}</p>` : ""}
</div>`;
}

/** A labelled text area. The newline after the opening tag is dropped by HTML parsers, so a value that starts
 * with a newline keeps it. */
export function textArea(o: { id: string; name: string; label: string; value: string; hint?: Child; rows?: number; maxlength?: number }): Html {
  return html`<div class="field">
<label for="${o.id}">${o.label}</label>
${o.hint ? html`<p class="hint" id="${o.id}-hint">${o.hint}</p>` : ""}
<textarea id="${o.id}" name="${o.name}" rows="${o.rows ?? 8}"${o.maxlength ? html` maxlength="${o.maxlength}"` : ""}${o.hint ? html` aria-describedby="${o.id}-hint"` : ""}>
${o.value}</textarea>
</div>`;
}

export function selectField(o: {
  id: string;
  name: string;
  label: string;
  options: Array<[value: string, label: string]>;
  value: string;
  hint?: Child;
}): Html {
  return html`<div class="field">
<label for="${o.id}">${o.label}</label>
${o.hint ? html`<p class="hint" id="${o.id}-hint">${o.hint}</p>` : ""}
<select id="${o.id}" name="${o.name}"${o.hint ? html` aria-describedby="${o.id}-hint"` : ""}>${o.options.map(
    ([value, label]) => html`<option value="${value}"${flag("selected", value === o.value)}>${label}</option>`,
  )}</select>
</div>`;
}

export function checkbox(o: { id: string; name: string; label: Child; checked: boolean; value?: string }): Html {
  return html`<label class="check" for="${o.id}"><input type="checkbox" id="${o.id}" name="${o.name}" value="${o.value ?? "on"}"${flag("checked", o.checked)}>${o.label}</label>`;
}

/** The twelve hats as radio chips. Only these are offered (docs/contract.md, "Words"). */
export function colourPicker(idPrefix: string, selectedKey: string | undefined): Html {
  const selected = selectedKey ? hatFor(selectedKey).key : undefined;
  return html`<fieldset class="swatches"><legend>Colour</legend>${HATS.map(
    (hat) =>
      html`<label class="swatch" data-hat="${hat.name}" for="${idPrefix}-${hat.name}"><input type="radio" id="${idPrefix}-${hat.name}" name="color" value="${hat.key}"${flag("checked", hat.key === selected)} required><span class="hat-dot" aria-hidden="true"></span>${hat.label}</label>`,
  )}</fieldset>`;
}

/** The three trust levels, each with what it means. */
export function trustChoices(view: View, idPrefix: string, selected: TrustLevel): Html {
  return html`<fieldset><legend>Trust</legend>${(Object.keys(TRUST) as TrustLevel[]).map(
    (level) =>
      html`<label class="choice" for="${idPrefix}-${level}"><input type="radio" id="${idPrefix}-${level}" name="trust" value="${level}"${flag("checked", level === selected)}><span class="choice-text"><b>${icon(view, TRUST[level].icon)}${TRUST[level].label}</b><span>${TRUST[level].explain}</span></span></label>`,
  )}<p class="hint">Moving mail to the trash and blocking a sender always wait for your yes, whatever you choose.</p></fieldset>`;
}

/**
 * A step that can't be undone: a button that opens a short explanation, and the button that does it.
 * Works without scripts (a details element).
 */
export function confirmStep(view: View, o: { open: string; explain: Child; action: string; confirm: string; fields?: Child }): Html {
  return html`<details class="confirm"><summary class="button danger">${o.open}</summary><div class="confirm-body"><p>${o.explain}</p>${postForm(
    view,
    o.action,
    html`${o.fields ?? ""}<button class="button danger" type="submit">${o.confirm}</button>`,
  )}</div></details>`;
}

/** A hidden field, for ids and where to return after a form. */
export const hidden = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;
