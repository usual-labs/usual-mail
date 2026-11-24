// Signing in with a pairing code, and the pages for a refused or missing session.
import { html, type Html } from "../html.ts";
import { alert, href, notice, ownerCodeWhere, page, pageHead, type View } from "../view/layout.ts";
import { hidden, textField } from "../view/parts.ts";

export interface SignInOptions {
  /** The sign-in form's own token (double submit), not the session's. */
  formToken: string;
  next: string;
  name?: string;
  error?: string;
  done?: string;
  /** Plain HTTP on a host that isn't this machine: the browser won't keep the Secure cookie. */
  insecure?: boolean;
}

export function signInPage(view: View, o: SignInOptions): Html {
  return page(view, {
    title: "Sign in",
    signedIn: false,
    narrow: true,
    body: html`${pageHead(view, {
      title: "Sign in",
      lede: "Type a pairing code to use this browser with your Usual Mail server.",
    })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
${o.insecure
  ? alert(
      view,
      "attention",
      "This page isn't on HTTPS, so your browser won't keep the sign-in. Open the dashboard over HTTPS, or on this machine at localhost.",
    )
  : ""}
<form class="form card" method="post" action="${href(view, "/sign-in")}">
<input type="hidden" name="_csrf" value="${o.formToken}">
${hidden("next", o.next)}
${textField({
  id: "code",
  name: "code",
  label: "Pairing code",
  hint: `Whenever no app or browser is paired, the server makes an owner's code: it ${ownerCodeWhere(view)}. A browser that is already signed in can make another on the Devices page. A code works once.`,
  required: true,
  autocomplete: "one-time-code",
  maxlength: 64,
  invalid: Boolean(o.error),
})}
${textField({
  id: "device-name",
  name: "name",
  label: "Name for this browser",
  hint: "You'll see it in the list of devices.",
  value: o.name ?? "Web dashboard",
  maxlength: 80,
})}
<div class="actions"><button class="button primary large" type="submit">Sign in</button></div>
</form>`,
  });
}

/** A token that belongs to an agent: the dashboard is for people. */
export function agentRefusedPage(view: View): Html {
  return page(view, {
    title: "Agents can't sign in here",
    signedIn: false,
    narrow: true,
    body: html`${pageHead(view, {
      title: "Agents can't sign in here",
      lede: "This sign-in belongs to an agent. The dashboard is for people.",
    })}
<p class="prose">Sign in with a pairing code made for an app.</p>
<div class="actions"><a class="button primary large" href="${href(view, "/sign-in")}">Sign in</a></div>`,
  });
}
