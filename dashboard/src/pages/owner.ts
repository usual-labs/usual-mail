// The owner's password on the dashboard (docs/contract.md, "The owner's password"): setting up an unclaimed server,
// signing in with the password, asking for a recovery code, and the Account page that sets the password.
import type { Owner, RecoveryCodeAnswer } from "@usualmail/core";
import { OWNER_PASSWORD_MIN } from "@usualmail/core";
import { html, type Html } from "../html.ts";
import { alert, href, notice, ownerCodeWhere, page, pageHead, postForm, type View } from "../view/layout.ts";
import { hidden, textField } from "../view/parts.ts";
import { fullTime } from "../view/words.ts";

/** A form before any session: its own token (double submit), not a session's. */
function openForm(view: View, action: string, formToken: string, body: Html): Html {
  return html`<form class="form card" method="post" action="${href(view, action)}">
<input type="hidden" name="_csrf" value="${formToken}">
${body}
</form>`;
}

const passwordHint = `At least ${OWNER_PASSWORD_MIN} characters. A few unrelated words are easy to remember and hard to guess.`;

function newPasswordFields(error?: string): Html {
  return html`${textField({
  id: "password",
  name: "password",
  label: "Password",
  type: "password",
  hint: passwordHint,
  required: true,
  autocomplete: "new-password",
  maxlength: 256,
  invalid: Boolean(error),
})}
${textField({
  id: "password-again",
  name: "passwordAgain",
  label: "Password again",
  type: "password",
  required: true,
  autocomplete: "new-password",
  maxlength: 256,
  invalid: Boolean(error),
})}`;
}

function browserName(name?: string): Html {
  return textField({
    id: "device-name",
    name: "name",
    label: "Name for this browser",
    hint: "You'll see it in the list of devices.",
    value: name ?? "Web dashboard",
    maxlength: 80,
  });
}

export interface ClaimOptions {
  formToken: string;
  /** "password": anyone who comes first; "google": the host named the owner's email. */
  claim: "password" | "google";
  /** Google's one-time proof, once the owner's email was proven. */
  proof?: string;
  email?: string;
  name?: string;
  error?: string;
}

/** An unclaimed server's first page: set its password (after Google's proof, when the host named the owner's email). */
export function claimPage(view: View, o: ClaimOptions): Html {
  const google = o.claim === "google";
  const lede = google
    ? o.proof
      ? "Google confirmed you are the owner this server's host named. Set the password you'll sign in with."
      : "This server's host named its owner's email. Sign in with Google as that address to set up the server."
    : "Nobody owns this server yet. Set a password, and you're its owner: you'll sign in with it here and in the apps.";
  const form = google && !o.proof
    ? openForm(view, "/claim/google", o.formToken, html`<div class="actions"><button class="button primary large" type="submit">Sign in with Google</button></div>`)
    : openForm(view, "/claim", o.formToken, html`${o.proof ? hidden("proof", o.proof) : ""}
${google
  ? ""
  : textField({
      id: "email",
      name: "email",
      label: "Email (optional)",
      type: "email",
      hint: "Only shown to you, on the Account page.",
      value: o.email ?? "",
      autocomplete: "email",
      maxlength: 254,
    })}
${newPasswordFields(o.error)}
${browserName(o.name)}
<div class="actions"><button class="button primary large" type="submit">Set up the server</button></div>`);
  return page(view, {
    title: "Set up your server",
    signedIn: false,
    narrow: true,
    body: html`${pageHead(view, { title: "Set up your server", lede })}
${o.error ? alert(view, "error", o.error) : ""}
${form}
<p class="prose">Already set up? <a href="${href(view, "/sign-in?with=code")}">Sign in with a pairing code</a>.</p>`,
  });
}

/** The answer to "Sign in with Google": a link, since a form here may not lead to another site (`form-action 'self'`). */
export function claimGooglePage(view: View, url: string): Html {
  return page(view, {
    title: "Continue to Google",
    signedIn: false,
    narrow: true,
    body: html`${pageHead(view, { title: "Continue to Google", lede: "Sign in as the owner's address. Google sends you back here to set the password." })}
<div class="actions"><a class="button primary large" href="${url}" rel="noreferrer">Continue to Google</a></div>`,
  });
}

export interface PasswordSignInOptions {
  formToken: string;
  next: string;
  name?: string;
  error?: string;
  done?: string;
  insecure?: boolean;
}

/** Signing in with the owner's password, with the ways round it. */
export function passwordSignInPage(view: View, o: PasswordSignInOptions): Html {
  const codeLink = `/sign-in?with=code${o.next !== "/" ? `&next=${encodeURIComponent(o.next)}` : ""}`;
  return page(view, {
    title: "Sign in",
    signedIn: false,
    narrow: true,
    body: html`${pageHead(view, { title: "Sign in", lede: "Sign in to your Usual Mail server with its owner's password." })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
${o.insecure ? insecureNote(view) : ""}
${openForm(view, "/sign-in", o.formToken, html`${hidden("next", o.next)}
${textField({
  id: "password",
  name: "password",
  label: "Password",
  type: "password",
  required: true,
  autocomplete: "current-password",
  maxlength: 256,
  invalid: Boolean(o.error),
})}
${browserName(o.name)}
<div class="actions"><button class="button primary large" type="submit">Sign in</button></div>`)}
<p class="prose"><a href="${href(view, "/forgot")}">Forgot your password?</a> · <a href="${href(view, codeLink)}">Sign in with a pairing code</a></p>
<p class="hint">This server already has an owner. If you set it up and can't sign in, "Forgot your password?" gets you back in.</p>`,
  });
}

export function insecureNote(view: View): Html {
  return alert(
    view,
    "attention",
    "This page isn't on HTTPS, so your browser won't keep the sign-in. Open the dashboard over HTTPS, or on this machine at localhost.",
  );
}

/** Asking for a recovery code: what it is and where it goes, before it is made. */
export function forgotPage(view: View, formToken: string, error?: string): Html {
  return page(view, {
    title: "Forgot your password?",
    signedIn: false,
    narrow: true,
    body: html`${pageHead(view, {
      title: "Forgot your password?",
      lede: "Signed in anywhere, in a browser or the Mac or iPhone app? Set a new password there, on the Account page or in Settings.",
    })}
${error ? alert(view, "error", error) : ""}
<p class="prose">Otherwise the server can make a recovery code. It never shows it here: it ${ownerCodeWhere(view)}, where only whoever runs the server can read it. Sign in with that code, then set a new password.</p>
${openForm(view, "/forgot", formToken, html`<div class="actions"><button class="button primary large" type="submit">Make a recovery code</button></div>`)}
<p class="prose"><a href="${href(view, "/sign-in")}">Back to signing in</a></p>`,
  });
}

/** A recovery code (or the owner's code) waits where the host keeps it. */
export function recoveryWaitingPage(view: View, answer: RecoveryCodeAnswer): Html {
  const what = answer.kind === "recovery" ? "A recovery code" : "The owner's code";
  return page(view, {
    title: "A code is waiting",
    signedIn: false,
    narrow: true,
    body: html`${pageHead(view, { title: "A code is waiting", lede: `${what} works once, until ${fullTime(answer.expiresAt)}.` })}
<p class="prose">The server ${ownerCodeWhere(view)}. Sign in with it, then set a new password on the Account page.</p>
<div class="actions"><a class="button primary large" href="${href(view, `/sign-in?with=code&next=${encodeURIComponent("/account")}`)}">Sign in with the code</a></div>`,
  });
}

/** The Account page: the owner's email and the password. */
export function accountPage(view: View, owner: Owner, o: { error?: string; done?: string } = {}): Html {
  return page(view, {
    title: "Account",
    section: "account",
    signedIn: true,
    narrow: true,
    body: html`${pageHead(view, {
      title: "Account",
      lede: owner.password
        ? "You sign in to this server with its owner's password, here and in the apps."
        : "This server has no password yet. Set one to sign in with it here and in the apps, instead of a pairing code each time.",
    })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
<section class="card" aria-label="The owner">
<dl class="facts">
<div><dt>Email</dt><dd>${owner.email ?? "None given"}</dd></div>
<div><dt>Password</dt><dd>${owner.password ? (owner.passwordSetAt ? `Set ${fullTime(owner.passwordSetAt)}` : "Set") : "Not set"}</dd></div>
</dl>
</section>
${postForm(view, "/account/password", html`<h2>${owner.password ? "Change the password" : "Set a password"}</h2>
<p class="hint">Devices already signed in stay signed in. Remove one on the Devices page.</p>
${newPasswordFields(o.error)}
<div class="actions"><button class="button primary" type="submit">${owner.password ? "Change the password" : "Set the password"}</button></div>`, "form card")}`,
  });
}
