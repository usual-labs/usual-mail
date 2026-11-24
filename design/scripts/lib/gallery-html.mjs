// Writes gallery/index.html: every colour, type role, space, radius and icon, and the four pieces from design/specs,
// in light and dark side by side. It uses only dist/web/tokens.css and fonts.css, an inline copy of the icon sprite,
// and no script.
import { cssColor } from "./color.mjs";
import { shapesSvg } from "./icons.mjs";
import { GALLERY_CSS } from "./gallery-css.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const icon = (name, cls = "icon-sm") => `<svg class="${cls}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const both = (title, render) =>
  `<div class="pair">${["light", "dark"]
    .map((mode) => `<div class="pane" data-theme="${mode}"><p class="pane-title">${title}, ${mode}</p>${render(mode)}</div>`)
    .join("")}</div>`;
const section = (id, title, intro, body) =>
  `<section class="section" id="${id}"><h2>${esc(title)}</h2><p>${intro}</p>${body}</section>`;

// --- The four pieces --------------------------------------------------------------------------------------------

export const hatLabel = (hat, name, small = false) =>
  `<span class="hat-label${small ? " small" : ""}" data-hat="${hat}"><span class="hat-dot"></span>${esc(name)}</span>`;

const hatPiece = (inboxes) =>
  `<div class="stack">${inboxes
    .map(
      (i) =>
        `<div class="hat-line"><span class="hat-icon">${icon(i.icon)}</span>${hatLabel(i.hat, i.name)}` +
        `<span class="hat-chip" data-hat="${i.hat}"><span class="hat-dot"></span>${esc(i.name)}</span>` +
        `<span class="hat-chip selected" data-hat="${i.hat}"><span class="hat-dot"></span>${esc(i.name)}</span>` +
        (i.attention ? `<span class="hat-attention">${esc(i.attention)}</span>` : "") +
        `</div>`,
    )
    .join("")}` +
  `<div class="hat-window" data-hat="${inboxes[0].hat}">${hatLabel(inboxes[0].hat, inboxes[0].name)}` +
  `<p>${esc(inboxes[0].address)} · ${icon(inboxes[0].trustIcon)} ${esc(inboxes[0].trust)}</p></div></div>`;

const briefCard = (brief) =>
  `<article class="brief"><header class="brief-head"><h3>${esc(brief.title)}</h3>` +
  `<p>${esc(brief.period)} · Written by ${esc(brief.writtenBy)}</p></header>` +
  brief.sections
    .map(
      (s) =>
        `<section class="brief-section">${hatLabel(s.hat, s.inbox)}` +
        (s.summary ? `<p class="brief-summary">${esc(s.summary)}</p>` : "") +
        (s.highlights.length
          ? `<ul class="highlights">${s.highlights.map((h) => `<li><a href="#brief">${esc(h.line)}<small>${esc(h.subject)}</small></a></li>`).join("")}</ul>`
          : "") +
        (s.counts ? `<p class="brief-counts">${esc(s.counts)}</p>` : "") +
        `</section>`,
    )
    .join("") +
  `</article>`;

const pileRows = (rows) =>
  `<ul class="rows">${rows
    .map((r) => {
      const tags = [hatLabel(r.hat, r.inbox, true)];
      if (r.stack) tags.push(`<span>${icon(r.stackIcon)}${esc(r.stack)}</span>`);
      if (r.comeBack) tags.push(`<span>${icon("come-back")}${esc(r.comeBack)}</span>`);
      if (r.done) tags.push(`<span>${icon("done")}Done</span>`);
      if (r.attachment) tags.push(`<span>${icon("attachment")}<span class="visually-hidden">Attachment</span></span>`);
      const classes = ["row", r.unread ? "unread" : "", r.done ? "done" : ""].filter(Boolean).join(" ");
      return (
        `<li><a class="${classes}" href="#pile-row"${r.selected ? ' aria-current="true"' : ""}>` +
        `<span class="${r.unread ? "unread-dot" : ""}" ${r.unread ? 'aria-label="Unread"' : 'aria-hidden="true"'}></span>` +
        `<span class="row-main"><span class="row-top"><span class="row-sender">${esc(r.sender)}</span>` +
        (r.messageCount > 1 ? `<span class="row-count">${r.messageCount}</span>` : "") +
        `<span class="row-time">${esc(r.time)}</span></span>` +
        `<span class="row-subject">${esc(r.subject)}</span><span class="row-snippet">${esc(r.snippet)}</span>` +
        `<span class="row-tags">${tags.join("")}</span></span></a></li>`
      );
    })
    .join("")}</ul>`;

const STATE_LABEL = { undone: "Undone", rejected: "Rejected", failed: "Failed" };

const reasonLines = (reasons) =>
  `<ul class="handled">${reasons
    .map((r) => {
      const actions =
        r.state === "proposed"
          ? `<span class="reason-actions"><button class="button primary" type="button">${icon("approve")}Approve</button>` +
            `<button class="button" type="button">${icon("reject")}Reject</button></span>`
          : r.state === "applied" && r.undoable
            ? `<span class="reason-actions"><button class="button" type="button">${icon("undo")}Undo</button></span>`
            : STATE_LABEL[r.state]
              ? `<span class="reason-state">${STATE_LABEL[r.state]}</span>`
              : "";
      return (
        `<li class="handled-item"><span class="handled-subject">${hatLabel(r.hat, r.inbox, true)}${esc(r.subject)}</span>` +
        `<p class="reason ${r.state}">${icon(r.icon)}<span class="reason-text"><b>${esc(r.actor)} ${esc(r.action)}</b>` +
        (r.reason ? `: ${esc(r.reason)}` : "") +
        ` · ${esc(r.time)}</span>${actions}</p></li>`
      );
    })
    .join("")}</ul>`;

// --- Token sections -----------------------------------------------------------------------------------------------

const swatches = (model, mode) =>
  `<div class="swatches">${model.colors
    .map((c) => `<div class="swatch"><div class="chip-color" style="background: var(--color-${c.name})"></div><b>${c.name}</b>${cssColor(c[mode])}</div>`)
    .join("")}</div>`;

const hatPalette = (model, mode) =>
  `<div class="hats">${model.hats
    .map(
      (h) =>
        `<div class="hat-sample" data-hat="${h.name}"><span class="solid">${h.name}</span>` +
        `<span class="hat-chip" data-hat="${h.name}"><span class="hat-dot"></span>${h.name}</span>` +
        `<code>${h.fill[mode].hex} · ${h.tint[mode].hex}</code></div>`,
    )
    .join("")}</div>`;

const FAMILY_LABEL = { serif: "Geist Serif", sans: "Geist Sans", mono: "System mono", wordmark: "Prociono" };

const typeRows = (model, samples) =>
  model.type
    .map((t) => {
      const spec =
        `${FAMILY_LABEL[t.family]} ${t.weight}, ${t.size}/${Number((t.size * t.lineHeight).toFixed(1))}` +
        `${t.tracking ? `, ${t.tracking}em` : ""}; iPhone ${t.iphoneSize}, ${t.appleTextStyle ? `grows like ${t.appleTextStyle}` : "fixed"}`;
      const text = t.name === "wordmark" ? (() => { const [a, b] = samples.wordmark.split("|"); return `${esc(a)}<span>${esc(b)}</span>`; })() : esc(samples[t.name]);
      const style = `font: var(--type-${t.name}); letter-spacing: var(--type-${t.name}-tracking)`;
      return `<div class="type-row"><div class="spec"><b>${t.name}</b>${spec}</div><div class="sample${t.name === "wordmark" ? " wordmark" : ""}" style="${style}">${text}</div></div>`;
    })
    .join("");

export function galleryHtml(model, icons, content) {
  const sprite = icons.map((i) => `<symbol id="icon-${i.name}" viewBox="0 0 24 24" fill="none">${shapesSvg(i.shapes)}</symbol>`).join("\n");
  const body = [
    section("colours", "Colours", "The family's monochrome palette. Each token has a light and a dark value.", both("Colours", (m) => swatches(model, m))),
    section(
      "hats",
      "Hats",
      "A company's colour: fill, the readable colour on it, and a soft tint. The light fill is the hat's key.",
      both("Hat palette", (m) => hatPalette(model, m)),
    ),
    section("type", "Type", "Geist Serif for the brief, headings and large text; Geist Sans for small text and controls; Prociono for the wordmark only.", typeRows(model, content.typeSamples)),
    section(
      "space",
      "Space and radii",
      "Spacing steps are named by their size. Radii run from chips to sheets.",
      model.space.map((s) => `<div class="space-row"><span>space.${s.name}</span><div class="space-bar" style="width: var(--space-${s.name})"></div></div>`).join("") +
        `<h3>Radii</h3><div class="radii">${model.radius
          .map((r) => `<div><div class="radius-box" style="border-radius: var(--radius-${r.name})"></div>radius.${r.name}</div>`)
          .join("")}</div>`,
    ),
    section(
      "icons",
      "Icons",
      "Hugeicons' free set, Stroke Rounded. Each name is listed in design/icons.json.",
      `<div class="icons">${icons.map((i) => `<div class="icon-cell">${icon(i.name, "icon")}${i.name}</div>`).join("")}</div>`,
    ),
    section("hat", "A company's hat", "See design/specs/hat.md. The inbox's icon, label, chip, selected chip, a problem, and the window tint.", both("Hat", () => hatPiece(content.hats))),
    section("brief", "The brief card", "See design/specs/brief-card.md.", both("Brief card", () => briefCard(content.brief))),
    section("pile-row", "A pile row", "See design/specs/pile-row.md. The second row is selected.", both("Pile rows", () => pileRows(content.rows))),
    section("reason", "The reason line", "See design/specs/reason-line.md. Under each handled thread.", both("Handled", () => reasonLines(content.reasons))),
  ];
  return `<!doctype html>
<!-- Generated by design/scripts/build.mjs from design/tokens.json, design/icons.json and core/fixtures/sample.json.
     Do not edit; run \`npm run build\` in design/. Serve design/ over HTTP to see the fonts. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usual Mail design gallery</title>
<link rel="stylesheet" href="../dist/web/fonts.css">
<link rel="stylesheet" href="../dist/web/tokens.css">
<style>${GALLERY_CSS}.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" class="sprite" width="0" height="0" aria-hidden="true" focusable="false">
${sprite}
</svg>
<main class="page">
<header class="masthead"><h1 class="wordmark">Usual<span>mail</span></h1><p>Design gallery. The look has not been checked by eye.</p></header>
${body.join("\n")}
</main>
</body>
</html>
`;
}
