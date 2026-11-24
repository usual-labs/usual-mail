// Home: what needs the person. Inboxes with a problem, the server's AI when it stopped for something a person must
// fix, proposals waiting for a yes or no, changes that went wrong or carry a note from the provider, drafts that
// didn't send, and rules agents suggested. Each part links to where it is handled in full. Silent records are never
// part of it (docs/contract.md, "Trust" and "Lists").
import type { AiSettings, AiStatus, Draft, HandledItem, Inbox, Rule } from "@usualmail/core";
import { html, type Html } from "../html.ts";
import { alert, href, icon, notice, page, pageHead, type View } from "../view/layout.ts";
import { hatLabel } from "../view/parts.ts";
import { handledItem } from "../view/reason.ts";
import { STATE_NAMES, stateWords } from "../view/ai.ts";
import { count, fullTime } from "../view/words.ts";
import { suggestionCard } from "./rules.ts";

/** How many changes that need a look Home shows; Handled has the rest. */
const TROUBLE_SHOWN = 5;

export interface HomeData {
  inboxes: Inbox[];
  waiting: HandledItem[];
  moreWaiting: boolean;
  /**
   * Records that failed, whose undo was refused, or that carry a note from the provider, whoever made them (the
   * person's own refused changes too). Newest first.
   */
  trouble: HandledItem[];
  /** True when more records need a look than were fetched. */
  moreTrouble: boolean;
  /** Drafts whose sending the provider refused. */
  failedDrafts: Draft[];
  suggestions: Rule[];
  /** The server's AI, only when it stopped for something a person must fix. */
  ai?: { status: AiStatus; settings: AiSettings };
}

function failedDraft(draft: Draft, inbox: Inbox | undefined): Html {
  const to = draft.to.map((address) => (address.name ? `${address.name} <${address.email}>` : address.email)).join(", ");
  return html`<li class="card">
${inbox ? hatLabel(inbox, "small") : ""}
<p><strong>${draft.subject || "(no subject)"}</strong></p>
<p class="meta">To ${to || "nobody"} · ${fullTime(draft.updatedAt)}</p>
<p class="hat-attention">It didn't send: ${draft.error || "the provider gave no reason."}</p>
</li>`;
}

export function homePage(view: View, data: HomeData, o: { done?: string; error?: string } = {}): Html {
  const inboxes = new Map(data.inboxes.map((inbox) => [inbox.id, inbox]));
  const troubled = data.inboxes.filter((inbox) => inbox.status === "needs_attention");
  const nothing =
    !troubled.length && !data.waiting.length && !data.trouble.length && !data.failedDrafts.length && !data.suggestions.length && !data.ai;

  const welcome = html`<div class="card">
<h2>Connect your first inbox</h2>
<p>Usual Mail works with the mailbox you already have: IMAP with SMTP, or Gmail.</p>
<div class="actions"><a class="button primary large" href="${href(view, "/inboxes/new")}">Connect an inbox</a></div>
</div>`;

  const problems = html`<section class="block" aria-labelledby="problems-title">
<h2 id="problems-title">${count(troubled.length, "inbox needs", "inboxes need")} attention</h2>
<ul class="list">${troubled.map(
    (inbox) => html`<li class="card inbox">
${hatLabel(inbox)}
<p class="hat-attention">${inbox.statusDetail || "Something is wrong with this inbox."}</p>
<div class="actions"><a class="button" href="${href(view, `/inboxes/${encodeURIComponent(inbox.id)}`)}">${icon(view, "settings")}Open settings<span class="visually-hidden"> for ${inbox.name}</span></a></div>
</li>`,
  )}</ul>
</section>`;

  const waiting = html`<section class="block" aria-labelledby="waiting-title">
<h2 id="waiting-title">Waiting for your yes</h2>
<ul class="handled">${data.waiting.map((item, index) => handledItem(view, item, inboxes.get(item.record.inboxId), index, "/"))}</ul>
<p><a href="${href(view, "/handled")}">${data.moreWaiting ? "See all in Handled" : "Open Handled"}</a></p>
</section>`;

  const failedCount = data.trouble.filter((item) => item.record.state === "failed").length;
  const shown = data.trouble.slice(0, TROUBLE_SHOWN);
  const trouble = html`<section class="block" aria-labelledby="trouble-title">
<h2 id="trouble-title">${count(data.trouble.length, "change needs", "changes need")} a look</h2>
<p class="note">${failedCount
    ? `${count(failedCount, "change", "changes")}${data.moreTrouble ? " or more" : ""} didn't go through at the provider. `
    : ""}Each says what the provider said.</p>
<ul class="handled">${shown.map((item, index) => handledItem(view, item, inboxes.get(item.record.inboxId), data.waiting.length + index, "/"))}</ul>
<p><a href="${href(view, "/handled")}">${data.trouble.length > shown.length || data.moreTrouble ? "See all in Handled" : "Open Handled"}</a></p>
</section>`;

  const drafts = html`<section class="block" aria-labelledby="drafts-title">
<h2 id="drafts-title">${count(data.failedDrafts.length, "draft", "drafts")} didn't send</h2>
<p class="note">Each stays a draft until it is sent again or deleted, in the Usual Mail app.</p>
<ul class="list">${data.failedDrafts.map((draft) => failedDraft(draft, inboxes.get(draft.inboxId)))}</ul>
</section>`;

  const ai = data.ai
    ? html`<section class="block" aria-labelledby="ai-title">
<h2 id="ai-title">Usual Mail's AI needs you</h2>
<div class="card">
<p class="hat-attention">${STATE_NAMES[data.ai.status.state]}: ${stateWords(data.ai.status, data.ai.settings)}</p>
${data.ai.status.detail ? html`<p class="meta">It said: ${data.ai.status.detail}</p>` : ""}
<div class="actions"><a class="button" href="${href(view, "/ai")}">${icon(view, "settings")}Open AI settings</a></div>
</div>
</section>`
    : "";

  const suggested = html`<section class="block" aria-labelledby="suggested-title">
<h2 id="suggested-title">Rules agents suggested</h2>
<p class="note">An agent's rule stays off until you accept it.</p>
<ul class="list">${data.suggestions.map((rule) => suggestionCard(view, rule, inboxes.get(rule.inboxId), "/"))}</ul>
</section>`;

  return page(view, {
    title: "Usual Mail",
    section: "home",
    signedIn: true,
    body: html`${pageHead(view, {
      title: "What needs you",
      lede: data.inboxes.length
        ? `${count(data.inboxes.length, "inbox", "inboxes")} on this server.`
        : "This server has no inboxes yet.",
    })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
${data.inboxes.length ? "" : welcome}
${troubled.length ? problems : ""}
${ai}
${data.waiting.length ? waiting : ""}
${data.trouble.length ? trouble : ""}
${data.failedDrafts.length ? drafts : ""}
${data.suggestions.length ? suggested : ""}
${data.inboxes.length && nothing ? html`<p class="empty">Nothing needs you right now.</p>` : ""}`,
  });
}
