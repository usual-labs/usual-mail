// Handled: what rules, agents and the server's AI did or propose, with their reasons. Proposals wait for Approve or
// Reject; the rest
// can be undone while the server says they still can. After an undo the server may ask one question to teach the
// inbox a rule.
import type { HandledItem, Inbox, TeachPrompt } from "@usualmail/core";
import { html, type Html } from "../html.ts";
import { alert, href, notice, page, pageHead, postForm, type View } from "../view/layout.ts";
import { hatChip, hidden } from "../view/parts.ts";
import { handledItem } from "../view/reason.ts";
import { matchWords, ruleAction } from "../view/words.ts";

export interface HandledPageData {
  inboxes: Inbox[];
  waiting: HandledItem[];
  /** True when more proposals wait than are shown. */
  moreWaiting: boolean;
  history: HandledItem[];
  /** The inbox the list is narrowed to, if any. */
  inboxId?: string;
  /** True when the person asked to see silent records too. */
  includeSilent: boolean;
  cursor?: string;
  nextCursor?: string;
}

function teachPanel(view: View, teach: TeachPrompt, returnTo: string): Html {
  const when = matchWords(teach.rule.match);
  const then = teach.rule.then.map(ruleAction);
  const answer = (accept: boolean, label: string, primary: boolean) =>
    postForm(
      view,
      `/teach/${encodeURIComponent(teach.id)}`,
      html`${hidden("accept", accept ? "yes" : "no")}${hidden("return", returnTo)}<button class="button${primary ? " primary" : ""}" type="submit">${label}</button>`,
      "inline-form",
    );
  return html`<section class="card" aria-labelledby="teach-title">
<h2 id="teach-title">${teach.question}</h2>
<p class="rule-text">${teach.rule.text}</p>
<p class="rule-when"><span>When: ${when.join("; ") || "any mail"}</span><span>Then: ${then.join(", ")}</span></p>
<div class="actions">${answer(true, "Yes, make it a rule", true)}${answer(false, "No", false)}</div>
</section>`;
}

const query = (params: Record<string, string | undefined>) => {
  const entries = Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
};

export function handledPage(
  view: View,
  data: HandledPageData,
  o: { done?: string; error?: string; teach?: TeachPrompt } = {},
): Html {
  const inboxes = new Map(data.inboxes.map((inbox) => [inbox.id, inbox]));
  const silent = data.includeSilent ? "1" : undefined;
  const returnTo = `/handled${query({ inbox: data.inboxId, silent, cursor: data.cursor })}`;
  const ids = data.waiting.map((item) => item.record.id);
  const filter = html`<nav class="chips" aria-label="Inbox">
<a class="chip-all" href="${href(view, `/handled${query({ silent })}`)}"${data.inboxId ? "" : html` aria-current="page"`}>All inboxes</a>
${data.inboxes.map((inbox) => hatChip(view, inbox, `/handled${query({ inbox: inbox.id, silent })}`, inbox.id === data.inboxId))}
</nav>`;
  // Silent records: what rules and agents applied cleanly in an inbox set to act silently, and every category the
  // server's AI set. Left out unless asked.
  const silentToggle = html`<p class="note">${
    data.includeSilent
      ? "Showing everything, including what rules and agents did silently in inboxes set to act silently, and the categories Usual Mail's AI set."
      : "What rules and agents did cleanly in inboxes set to act silently is left out here, and so is every category Usual Mail's AI set. Anything that went wrong is always shown."
  } <a href="${href(view, `/handled${query({ inbox: data.inboxId, silent: data.includeSilent ? undefined : "1" })}`)}">${
    data.includeSilent ? "Hide silent changes" : "Show silent changes too"
  }</a></p>`;
  let index = 0;
  return page(view, {
    title: "Handled",
    section: "handled",
    signedIn: true,
    body: html`${pageHead(view, {
      title: "Handled",
      lede: "What rules, agents and Usual Mail's AI did or want to do, each with its reason. A change to a thread now in the trash stays here, so the trash can be undone.",
    })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
${o.teach ? teachPanel(view, o.teach, returnTo) : ""}
${data.inboxes.length > 1 ? filter : ""}
<section class="block" aria-labelledby="waiting-title">
<h2 id="waiting-title">Waiting for you</h2>
${data.waiting.length
  ? html`<p class="note">Approving applies the change. Rejecting leaves the mail where it is.</p>
${data.waiting.length > 1
  ? html`<div class="actions">${postForm(
      view,
      "/handled/approve",
      html`${ids.map((id) => hidden("ids", id))}${hidden("return", returnTo)}<button class="button primary" type="submit">Approve all ${data.waiting.length}</button>`,
      "inline-form",
    )}${postForm(
      view,
      "/handled/reject",
      html`${ids.map((id) => hidden("ids", id))}${hidden("return", returnTo)}<button class="button" type="submit">Reject all ${data.waiting.length}</button>`,
      "inline-form",
    )}</div>`
  : ""}
<ul class="handled">${data.waiting.map((item) => handledItem(view, item, inboxes.get(item.record.inboxId), index++, returnTo))}</ul>
${data.moreWaiting ? html`<p class="meta">More are waiting. Approve or reject these to see them.</p>` : ""}`
  : html`<p class="empty">Nothing is waiting for you.</p>`}
</section>
<section class="block" aria-labelledby="history-title">
<h2 id="history-title">Done for you</h2>
${silentToggle}
${data.history.length
  ? html`<ul class="handled">${data.history.map((item) => handledItem(view, item, inboxes.get(item.record.inboxId), index++, returnTo))}</ul>`
  : html`<p class="empty">Nothing yet.</p>`}
${data.cursor || data.nextCursor
  ? html`<nav class="pager" aria-label="Pages">${data.cursor ? html`<a class="button" href="${href(view, `/handled${query({ inbox: data.inboxId, silent })}`)}">Newest</a>` : ""}${
      data.nextCursor ? html`<a class="button" href="${href(view, `/handled${query({ inbox: data.inboxId, silent, cursor: data.nextCursor })}`)}">Older</a>` : ""}</nav>`
  : ""}
</section>`,
  });
}
