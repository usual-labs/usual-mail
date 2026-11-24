// Piece: the reason line under each thread in Handled (design/specs/reason-line.md), with the one control that
// answers it: Undo, or Approve and Reject. Each control is its own small form, so it works without scripts.
//
// What the provider said is always shown in words: why a record failed or an undo was refused (`error`), and a
// note on a change that worked (`note`). A record of a thread now in the trash says so, and can still be undone.
import type { HandledItem, Inbox } from "@usualmail/core";
import { html, type Html } from "../html.ts";
import { icon, postForm, type View } from "./layout.ts";
import { hatLabel, hidden } from "./parts.ts";
import { ACTOR_ICON, actionPhrase, actorName, fullTime, listTime } from "./words.ts";

/** One handled thread. `index` makes element ids unique on the page; `returnTo` is where its forms come back to. */
export function handledItem(view: View, item: HandledItem, inbox: Inbox | undefined, index: number, returnTo: string): Html {
  const { record, thread } = item;
  const proposed = record.state === "proposed";
  const textId = `reason-${index}`;
  const control = (path: string, label: string, iconName: string, primary: boolean, field?: Html) =>
    postForm(
      view,
      path,
      html`${field ?? ""}${hidden("return", returnTo)}<button class="button${primary ? " primary" : ""}" type="submit" aria-describedby="${textId}">${icon(view, iconName)}${label}</button>`,
      "inline-form",
    );

  let trailing: Html | string = "";
  if (proposed) {
    trailing = html`<span class="reason-actions">${control("/handled/approve", "Approve", "approve", true, hidden("ids", record.id))}${control(
      "/handled/reject",
      "Reject",
      "reject",
      false,
      hidden("ids", record.id),
    )}</span>`;
  } else if (record.state === "applied" && record.undoable) {
    trailing = html`<span class="reason-actions">${control(`/handled/${encodeURIComponent(record.id)}/undo`, "Undo", "undo", false)}</span>`;
  } else if (record.state !== "applied") {
    const words: Record<string, string> = { undone: "Undone", rejected: "Rejected", failed: "Failed" };
    trailing = html`<span class="reason-state">${words[record.state] ?? ""}</span>`;
  }

  // A failed record's error says why the provider refused it; on any other record it says why an undo was refused.
  const error = record.error
    ? html`<span class="reason-error">${record.state === "failed" ? "It didn't go through" : "Undo didn't go through"}: ${record.error}</span>`
    : "";
  const note = record.note ? html`<span class="reason-note">Note from the provider: ${record.note}</span>` : "";

  return html`<li class="handled-item">
<span class="handled-subject">${inbox ? hatLabel(inbox, "small") : ""}<span>${thread.subject || "(no subject)"}</span>${
    thread.trashed ? html`<span class="badge">In the trash</span>` : ""}${record.silent ? html`<span class="badge">Done silently</span>` : ""}</span>
<div class="reason ${record.state}">${icon(view, ACTOR_ICON[record.actor.kind])}<span class="reason-text" id="${textId}"><b>${actorName(record.actor)} ${actionPhrase(
    record.action,
    proposed,
  )}</b>${record.reason
    ? html`: ${record.reason}`
    : record.actor.kind === "ai"
      ? html`, using ${record.actor.model}`
      : ""} · <time datetime="${record.at}" title="${fullTime(record.at)}">${listTime(record.at, view.now)}</time>${error}${note}</span>${trailing}</div>
</li>`;
}
