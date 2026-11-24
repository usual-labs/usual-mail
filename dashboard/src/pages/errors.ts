// Pages for things that went wrong outside a form: a page that isn't there, a refused form, a server error.
import { html, type Html } from "../html.ts";
import { alert, href, page, pageHead, type View } from "../view/layout.ts";

export function notFoundPage(view: View, signedIn: boolean, what = "This page doesn't exist, or what it showed was removed."): Html {
  return page(view, {
    title: "Not found",
    signedIn,
    narrow: true,
    body: html`${pageHead(view, { title: "Not found", lede: what })}
<div class="actions"><a class="button large" href="${href(view, "/")}">Go home</a></div>`,
  });
}

export function errorPage(view: View, signedIn: boolean, title: string, message: string): Html {
  return page(view, {
    title,
    signedIn,
    narrow: true,
    body: html`${pageHead(view, { title })}
${alert(view, "error", message)}
<div class="actions"><a class="button large" href="${href(view, "/")}">Go home</a></div>`,
  });
}

/** A form that didn't come from this site, or whose page is too old to trust. Nothing was changed. */
export function formRefusedPage(view: View, signedIn: boolean): Html {
  return errorPage(
    view,
    signedIn,
    "Form not accepted",
    "Nothing was changed. This form came from another site, or its page is too old. Go back, reload the page and try again.",
  );
}
