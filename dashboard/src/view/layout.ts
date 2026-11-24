// The page shell every dashboard page shares: head, top bar with the wordmark and sections, and the footer.
import { ASSET_PATHS } from "../generated/assets.ts";
import { html, type Child, type Html } from "../html.ts";

/** What every view needs to build links and forms. */
export interface View {
  /** Where the dashboard is mounted: "" at the root, or "/dashboard". No trailing slash. */
  base: string;
  /** The form token for this session. Empty on pages without a session. */
  csrf: string;
  /** The moment pages treat as now, for "today" and "Yesterday". */
  now: Date;
  /** Where the server keeps a waiting owner's code, in its host's words (`DashboardOptions.ownerCodeWhere`). */
  ownerCodeWhere?: string;
}

/** Where a server its host starts itself keeps a waiting owner's code: what follows "it" in "the server makes …: it". */
export const OWNER_CODE_WHERE = "prints it in its log and writes it to owner-pairing-code in its data folder";

/** Where this server keeps a waiting owner's code. */
export const ownerCodeWhere = (view: View) => view.ownerCodeWhere ?? OWNER_CODE_WHERE;

export type Section = "home" | "inboxes" | "handled" | "ai" | "devices";

/** A path inside the dashboard, with the base in front. `path` starts with "/". */
export const href = (view: View, path: string) => `${view.base}${path}`;

export const asset = (view: View, name: string) => `${view.base}${ASSET_PATHS[name]}`;

/** An icon from the design system's sprite, in the text's colour. Decorative: hidden from screen readers. */
export function icon(view: View, name: string, size: "sm" | "md" = "sm"): Html {
  return html`<svg class="${size === "sm" ? "icon-sm" : "icon"}" aria-hidden="true" focusable="false"><use href="${asset(view, "icons.svg")}#icon-${name}"></use></svg>`;
}

const SECTIONS: Array<[Section, string, string, string]> = [
  ["home", "/", "Home", "now"],
  ["inboxes", "/inboxes", "Inboxes", "inboxes"],
  ["handled", "/handled", "Handled", "handled"],
  ["ai", "/ai", "AI", "settings"],
  ["devices", "/devices", "Devices and agents", "agent"],
];

export interface PageOptions {
  title: string;
  /** Which section is current; signed-in pages only. Left out on the sign-in page. */
  section?: Section | null;
  signedIn: boolean;
  /** A hat name: the whole page takes the hat's tint, as inside one inbox. */
  hat?: string;
  narrow?: boolean;
  body: Child;
}

export function page(view: View, options: PageOptions): Html {
  const { title, section, signedIn } = options;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="same-origin">
<title>${title === "Usual Mail" ? title : `${title} · Usual Mail`}</title>
<link rel="preload" href="${asset(view, "fonts/Geist-Variable.woff2")}" as="font" type="font/woff2" crossorigin="anonymous">
<link rel="stylesheet" href="${asset(view, "app.css")}">
</head>
<body${options.hat ? html` class="tinted" data-hat="${options.hat}"` : ""}>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<div class="top-inner">
<a class="brand" href="${href(view, "/")}" aria-label="Usual Mail, home"><span class="wordmark" aria-hidden="true">Usual<span>mail</span></span></a>
${signedIn
  ? html`<nav class="nav" aria-label="Sections">${SECTIONS.map(
      ([key, path, label, iconName]) =>
        html`<a href="${href(view, path)}"${key === section ? html` aria-current="page"` : ""}>${icon(view, iconName)}${label}</a>`,
    )}</nav>
${postForm(view, "/sign-out", html`<button class="button quiet" type="submit">Sign out</button>`, "inline-form")}`
  : ""}
</div>
</header>
<main id="main" class="page${options.narrow ? " narrow" : ""}" tabindex="-1">
${options.body}
</main>
<footer class="foot">
<div class="foot-inner">
<span>Usual Mail</span>
<span>Times are in UTC.</span>
<span>Fonts: <a href="${asset(view, "licences/Geist-OFL.txt")}">Geist</a> and <a href="${asset(view, "licences/Prociono-OFL.txt")}">Prociono</a> (SIL Open Font License). Icons: <a href="${asset(view, "licences/icons-LICENSE.md")}">Hugeicons</a> (MIT).</span>
</div>
</footer>
</body>
</html>
`;
}

/** A form that changes something. Every one carries the session's form token. */
export function postForm(view: View, action: string, body: Child, className?: string): Html {
  return html`<form method="post" action="${href(view, action)}"${className ? html` class="${className}"` : ""}><input type="hidden" name="_csrf" value="${view.csrf}">${body}</form>`;
}

/** A page's heading, with an optional way back and a lede under it. */
export function pageHead(view: View, options: { title: Child; back?: { path: string; label: string }; lede?: Child }): Html {
  return html`<div class="head">
${options.back ? html`<a class="crumb" href="${href(view, options.back.path)}">${icon(view, "back")}${options.back.label}</a>` : ""}
<h1>${options.title}</h1>
${options.lede ? html`<p class="lede">${options.lede}</p>` : ""}
</div>`;
}

/** A message at the top of a page: what just happened, or what went wrong. */
export function alert(view: View, kind: "notice" | "error" | "attention", body: Child): Html {
  const iconName = kind === "notice" ? "approve" : kind === "error" ? "close" : "screening";
  const role = kind === "error" ? "alert" : "status";
  return html`<div class="alert ${kind}" role="${role}">${icon(view, iconName)}<div>${body}</div></div>`;
}

/** Messages carried to a page after a redirect: `?done=<key>`. Only these fixed words are ever shown. */
export const NOTICES: Record<string, string> = {
  "connected": "Connected. The first sync brings in the last 30 days of mail as history; rules start with new mail.",
  "saved": "Saved.",
  "paused": "Paused. Nothing syncs until you resume.",
  "resumed": "Resumed. Syncing starts again.",
  "syncing": "A sync is on its way.",
  "removed": "The inbox was removed. Nothing changed at the provider.",
  "reconnected": "The provider accepted the new details and they are saved. The inbox syncs again, unless it is paused.",
  "rule-added": "Rule added.",
  "rule-on": "The rule is on.",
  "rule-off": "The rule is off.",
  "rule-deleted": "Rule deleted.",
  "approved": "Approved.",
  "rejected": "Rejected.",
  "undone": "Undone.",
  "taught": "Rule added from your answer.",
  "not-taught": "No rule added.",
  "revoked": "Removed. Its token no longer works.",
  "ai-key-saved": "The key is saved, and the server tested it at once: the status below says how that went. From now on every inbox's mail goes to the AI, newest first.",
  "ai-models-saved": "Saved. The server tested the models at once: the status below says how that went.",
  "ai-paused": "Paused. Nothing is sent for any inbox until you resume.",
  "ai-resumed": "Resumed. The AI carries on with new mail first, then history.",
  "ai-tested": "Tested: the status below says how it went.",
  "ai-key-removed": "The AI key is removed. Nothing more is sent, for any inbox.",
  "signed-out": "Signed out.",
};

export function notice(view: View, key: string | undefined): Html | "" {
  const text = key ? NOTICES[key] : undefined;
  return text ? alert(view, "notice", text) : "";
}
