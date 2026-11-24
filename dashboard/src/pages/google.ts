// Signing in with Google for Gmail: the choice where Gmail is connected, the one where a Gmail inbox is reconnected,
// and the page that links on to Google once the server has started a sign-in. Google sends the person back to the
// server's own page, which says how it went; this dashboard keeps no state and doesn't follow it.
import { GOOGLE_RULES_WORDS, type Inbox } from "@usualmail/core";
import { html, type Html } from "../html.ts";
import { alert, href, page, pageHead, postForm, type View } from "../view/layout.ts";
import { colourPicker, textField } from "../view/parts.ts";
import { fullTime } from "../view/words.ts";

/** Google's rules, in core's words, for whoever set the server's Google client up. */
function rules(): Html {
  return html`<details class="reconnect"><summary class="button">Google's rules for this</summary><ul class="prose">${GOOGLE_RULES_WORDS.map((words) => html`<li>${words}</li>`)}</ul></details>`;
}

/** On the Gmail connect page, before the form for a client id, secret and token. */
export function googleConnectCard(view: View, o: { name?: string; color?: string; error?: string } = {}): Html {
  return html`${postForm(
    view,
    "/inboxes/google",
    html`<h2>Sign in with Google</h2>
<p class="hint">Google asks you to choose the account and to allow Usual Mail to read, compose and send its email. This server receives Google's answer itself and keeps the access sealed; nothing to copy or paste.</p>
${o.error ? alert(view, "error", o.error) : ""}
${textField({ id: "google-name", name: "name", label: "Name", value: o.name ?? "", required: true, maxlength: 80, hint: "The company or person this inbox is for." })}
${colourPicker("google-color", o.color || undefined)}
<p class="hint">A new inbox starts with Suggest trust and AI off; change them on its page.</p>
<div class="actions"><button class="button primary large" type="submit">Sign in with Google</button></div>`,
    "card form",
  )}
<h2>Or give your own client id, secret and refresh token</h2>`;
}

/** On a Gmail inbox's page, in Connection: sign in again, in place. */
export function googleReconnectForm(view: View, inbox: Inbox): Html {
  return postForm(
    view,
    `/inboxes/${encodeURIComponent(inbox.id)}/google`,
    html`<p class="note">Signing in with Google again gives the server new access to ${inbox.address}, in place: rules, history and settings stay. Only that account is accepted.</p>
<div class="actions"><button class="button primary" type="submit">Sign in with Google again</button></div>`,
    "form",
  );
}

/** After starting: the link to Google, how long it works, where to look afterwards, and Google's rules. */
export function continueToGooglePage(view: View, o: { url: string; expiresAt: string; inbox?: Inbox }): Html {
  const back = o.inbox ? { path: `/inboxes/${encodeURIComponent(o.inbox.id)}`, label: o.inbox.name } : { path: "/inboxes", label: "Inboxes" };
  return page(view, {
    title: "Sign in with Google",
    section: "inboxes",
    signedIn: true,
    narrow: true,
    body: html`${pageHead(view, {
      title: "Sign in with Google",
      back,
      lede: o.inbox ? html`Sign in as ${o.inbox.address} to reconnect ${o.inbox.name}.` : "Choose the Google account for the new inbox.",
    })}
<div class="card prose">
<p>Google opens in a new tab. It may warn that the app isn't verified: continue if the Google client is your own.</p>
<div class="actions"><a class="button primary large" href="${o.url}" target="_blank" rel="noopener noreferrer">Continue to Google</a></div>
<p>This works until ${fullTime(o.expiresAt)}. After that, start again.</p>
<p>When you're done, Google shows a page on this server that says how it went. Then come back here: this page doesn't update by itself. <a href="${href(view, back.path)}">${o.inbox ? `Back to ${o.inbox.name}` : "Inboxes"}</a> shows the ${o.inbox ? "inbox's state" : "new inbox"} once the server has it.</p>
${rules()}
</div>`,
  });
}
