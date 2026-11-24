/**
 * The two interface pieces for chat apps that support MCP Apps (extension io.modelcontextprotocol/ui,
 * specification 2026-01-26): the brief card and the thread list (rows as in design/specs/pile-row.md, used for Home and the other lists).
 *
 * Each is one self-contained HTML document served as a `ui://` resource with MIME type
 * `text/html;profile=mcp-app`. Styles and the script are inline, which the extension's default content security
 * policy allows; nothing is loaded from the network. That policy has no font source, so Geist can't be loaded and
 * the token font stacks fall back to Georgia and the system sans. Colours, type, space and radii come only from
 * design/dist/web/tokens.css, inlined unchanged.
 */
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { ICON_SYMBOLS, TOKENS_CSS } from "./design.generated.ts";
import { VIEW_SCRIPT } from "./view-script.ts";

export const BRIEF_VIEW_URI = "ui://usual-mail/brief.html";
export const THREADS_VIEW_URI = "ui://usual-mail/threads.html";

/** The views' own styles: every colour, font, size and space is a design token. Specs in design/specs/. */
export const VIEW_CSS = `
:root { font-synthesis: none; }
body { margin: 0; padding: var(--space-4); color: var(--color-ink); font: var(--type-body); }
.sprite { display: none; }
.card {
  box-sizing: border-box; max-width: var(--size-measure); background: var(--color-surface); color: var(--color-ink);
  border: var(--size-line) solid var(--color-line); border-radius: var(--radius-lg); box-shadow: var(--elevation-raised);
}
.hat-label { display: flex; align-items: center; gap: var(--space-6); margin: 0; font: var(--type-label); color: var(--color-ink); }
.hat-label.small { display: inline-flex; font: var(--type-caption); color: var(--color-meta); }
.hat-dot { flex: none; width: var(--size-dot); height: var(--size-dot); border-radius: var(--radius-full); background: var(--hat-fill); }

.brief { padding: var(--space-24); }
.brief header { margin-bottom: var(--space-20); }
.brief h2 { margin: 0; font: var(--type-title); letter-spacing: var(--type-title-tracking); color: var(--color-ink); }
.brief .meta { margin: var(--space-4) 0 0; font: var(--type-caption); color: var(--color-meta); }
.section { padding: var(--space-20) 0; }
.section:first-of-type { padding-top: 0; }
.section:last-child { padding-bottom: 0; }
.section + .section {
  margin: 0 calc(var(--space-24) * -1); padding-left: var(--space-24); padding-right: var(--space-24);
  border-top: var(--size-line) solid var(--color-line);
}
.section > * + * { margin-top: var(--space-12); }
.summary { margin: 0; font: var(--type-reading); color: var(--color-body); }
.highlights { list-style: none; margin-left: calc(var(--space-8) * -1); margin-right: calc(var(--space-8) * -1); padding: 0; }
.highlights li + li { margin-top: var(--space-4); }
.highlight { display: block; padding: var(--space-8); border-radius: var(--radius-md); color: inherit; text-decoration: none; }
a.highlight:hover { background: var(--color-hover); }
a.highlight:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.hl-line { display: block; font: var(--type-body); color: var(--color-ink); }
.hl-subject { display: block; margin-top: var(--space-2); font: var(--type-caption); color: var(--color-meta); }
.counts { margin: 0; font: var(--type-caption); color: var(--color-meta); }

.threads { overflow: hidden; }
.rows { list-style: none; margin: 0; padding: 0; }
.row {
  position: relative; display: flex; gap: var(--space-12); box-sizing: border-box; min-height: var(--size-target);
  padding: var(--space-12) var(--space-16); background: var(--color-surface);
}
.row + .row::before {
  content: ""; position: absolute; top: 0; right: 0;
  left: calc(var(--space-16) + var(--size-dot) + var(--space-12)); border-top: var(--size-line) solid var(--color-line);
}
.row:hover { background: var(--color-hover); }
.lead { flex: none; width: var(--size-dot); padding-top: calc((var(--type-label-size) * var(--type-label-line-height) - var(--size-dot)) / 2); }
.unread-dot, .read-dot { display: block; width: var(--size-dot); height: var(--size-dot); border-radius: var(--radius-full); }
.unread-dot { background: var(--color-ink); }
.main { flex: 1; min-width: 0; }
.line1 { display: flex; align-items: baseline; gap: var(--space-6); }
.sender { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font: var(--type-label); color: var(--color-ink); }
.count { flex: none; font: var(--type-caption); color: var(--color-meta); }
.time { flex: none; margin-left: auto; white-space: nowrap; font: var(--type-caption); color: var(--color-meta); }
.subject, .snippet { margin-top: var(--space-2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font: var(--type-body); }
.subject { color: var(--color-ink); }
.snippet { color: var(--color-meta); }
.row.unread .sender, .row.unread .subject { font-weight: var(--font-weight-semibold); }
.row.unread .time { color: var(--color-ink); }
.row.done .sender, .row.done .subject { color: var(--color-body); }
.tags {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4) var(--space-12);
  margin-top: calc(var(--space-2) + var(--space-4)); font: var(--type-caption); color: var(--color-meta);
}
.tag { display: inline-flex; align-items: center; gap: var(--space-4); }
.icon { flex: none; width: var(--size-icon-sm); height: var(--size-icon-sm); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-6); margin-top: var(--space-8); }
.button {
  display: inline-flex; align-items: center; gap: var(--space-4); box-sizing: border-box; height: var(--size-control);
  padding: 0 var(--space-12); border: var(--size-line) solid var(--color-line-strong); border-radius: var(--radius-sm);
  background: var(--color-surface); color: var(--color-ink); font: var(--type-label); cursor: pointer;
}
.button:hover { background: var(--color-hover); }
.button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.note { font: var(--type-caption); color: var(--color-meta); }
.note.attention { color: var(--color-attention); }
.note.danger { color: var(--color-danger); }
.empty, .more { margin: 0; padding: var(--space-12) var(--space-16); font: var(--type-caption); color: var(--color-meta); }
.more { border-top: var(--size-line) solid var(--color-line); }
@media (max-width: 480px) { .brief { padding: var(--space-20); } }
`;

export type ViewName = "brief" | "threads";

export function viewHtml(view: ViewName): string {
  const title = view === "brief" ? "Usual Mail brief" : "Usual Mail threads";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${TOKENS_CSS}</style>`,
    `<style>${VIEW_CSS}</style>`,
    "</head>",
    `<body data-view="${view}">`,
    '<svg class="sprite" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><!-- Hugeicons free set, MIT -->',
    ICON_SYMBOLS,
    "</svg>",
    '<main id="root"></main>',
    `<script>${VIEW_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** The resource's `_meta.ui`: no network, fonts or frames (an empty policy keeps the extension's strict default). */
export const VIEW_RESOURCE_META = { ui: { csp: {}, prefersBorder: false } } as const;

export function registerViews(server: McpServer): void {
  const views: Array<[ViewName, string, string]> = [
    ["brief", BRIEF_VIEW_URI, "The brief card: per inbox, what happened and what needs the person."],
    ["threads", THREADS_VIEW_URI, "A list of threads as rows, with Done and Reply later."],
  ];
  for (const [view, uri, description] of views) {
    registerAppResource(server, view === "brief" ? "Brief card" : "Thread list", uri, { description, _meta: VIEW_RESOURCE_META }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: viewHtml(view), _meta: VIEW_RESOURCE_META }],
    }));
  }
}
