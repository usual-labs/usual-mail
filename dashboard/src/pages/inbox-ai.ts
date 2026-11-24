// On one inbox's page: the inbox's icon and place in the apps' profile switch. (There is no per-inbox AI switch since
// 2026-11-17: a key processes every inbox's mail.)
import { INBOX_ICONS, type Inbox } from "@usualmail/core";
import { flag, html, type Html } from "../html.ts";
import { icon, postForm, type View } from "../view/layout.ts";
import { selectField } from "../view/parts.ts";
import { ICON_NAMES } from "../view/words.ts";

const inboxPath = (inbox: Inbox, rest = "") => `/inboxes/${encodeURIComponent(inbox.id)}${rest}`;

/** The inbox's icon and its place in the profile switch and the inbox list, counting from 1. */
export function placeSection(view: View, inbox: Inbox, total: number): Html {
  const places = Array.from({ length: Math.max(total, inbox.position + 1) }, (_, index): [string, string] => [String(index + 1), String(index + 1)]);
  return postForm(
    view,
    inboxPath(inbox, "/place"),
    html`<h2>Icon and place</h2>
<fieldset class="swatches"><legend>Icon in the apps' profile switch</legend>${INBOX_ICONS.map(
      (name) =>
        html`<label class="swatch" for="inbox-icon-${name}"><input type="radio" id="inbox-icon-${name}" name="icon" value="${name}"${flag("checked", name === inbox.icon)} required>${icon(view, name)}${ICON_NAMES[name]}</label>`,
    )}</fieldset>
${selectField({
  id: "inbox-position",
  name: "position",
  label: "Place in the profile switch and the inbox list",
  value: String(inbox.position + 1),
  options: places,
  hint: "The others move up or down to make room.",
})}
<div class="actions"><button class="button primary" type="submit">Save icon and place</button></div>`,
    "card form",
  );
}

