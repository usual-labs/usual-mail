// The HTML gallery's own styles. Every colour, type value, space and radius is a token variable from tokens.css;
// the only literal lengths are the gallery's grid tracks. A test checks that no colour literal slips in.
export const GALLERY_CSS = `
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--color-background);
  color: var(--color-body);
  font: var(--type-body);
  letter-spacing: var(--type-body-tracking);
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p { margin: 0; }
button { font: inherit; color: inherit; }
.icon { width: var(--size-icon-md); height: var(--size-icon-md); flex: none; }
.icon-sm { width: var(--size-icon-sm); height: var(--size-icon-sm); flex: none; }
:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
/* The inline icon sprite only holds symbols: it takes no space (an svg ignores the hidden attribute). */
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }

/* Gallery frame */
.page { max-width: 1120px; margin: 0 auto; padding: var(--space-48) var(--space-24) var(--space-64); }
.masthead { display: flex; align-items: baseline; gap: var(--space-16); flex-wrap: wrap; margin-bottom: var(--space-48); }
.masthead p { font: var(--type-caption); color: var(--color-meta); }
.wordmark { font: var(--type-wordmark); letter-spacing: var(--type-wordmark-tracking); color: var(--color-ink); }
.wordmark span { color: var(--color-suffix); }
.section { margin-top: var(--space-64); }
.section > h2 { font: var(--type-title); letter-spacing: var(--type-title-tracking); color: var(--color-ink); margin-bottom: var(--space-8); }
.section > p { font: var(--type-caption); color: var(--color-meta); margin-bottom: var(--space-24); max-width: var(--size-measure); }
.section h3 { font: var(--type-label); color: var(--color-meta); margin: var(--space-24) 0 var(--space-12); }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: var(--space-16); }
.pane { background: var(--color-background); color: var(--color-body); border: var(--size-line) solid var(--color-line); border-radius: var(--radius-xl); padding: var(--space-24); }
.pane-title { font: var(--type-caption); color: var(--color-meta); margin-bottom: var(--space-16); }
.stack { display: grid; gap: var(--space-16); }

/* Colours */
.swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-12); }
.swatch { display: grid; gap: var(--space-6); font: var(--type-caption); color: var(--color-meta); }
.swatch b { font: var(--type-label); color: var(--color-ink); }
.chip-color { height: 48px; border-radius: var(--radius-md); border: var(--size-line) solid var(--color-line); }
.hats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-12); }
.hat-sample { display: grid; gap: var(--space-6); padding: var(--space-12); border-radius: var(--radius-lg); background: var(--hat-tint); }
.hat-sample .solid { background: var(--hat-fill); color: var(--hat-on); font: var(--type-label); border-radius: var(--radius-sm); padding: var(--space-4) var(--space-8); }
.hat-sample code { font: var(--type-caption); color: var(--color-meta); }

/* Type, space, radii */
.type-row { display: grid; grid-template-columns: 160px 1fr; gap: var(--space-16); padding: var(--space-12) 0; border-top: var(--size-line) solid var(--color-line); align-items: baseline; }
.type-row .spec { font: var(--type-caption); color: var(--color-meta); }
.type-row .spec b { display: block; font: var(--type-label); color: var(--color-ink); }
.sample { color: var(--color-ink); }
.space-row { display: flex; align-items: center; gap: var(--space-16); font: var(--type-caption); color: var(--color-meta); padding: var(--space-4) 0; }
.space-row span { width: 72px; }
.space-bar { height: var(--space-12); background: var(--color-ink); border-radius: var(--radius-sm); }
.radii { display: flex; gap: var(--space-16); flex-wrap: wrap; font: var(--type-caption); color: var(--color-meta); }
.radius-box { width: 88px; height: 64px; background: var(--color-surface); border: var(--size-line) solid var(--color-line-strong); margin-bottom: var(--space-6); }

/* Icons */
.icons { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: var(--space-8); }
.icon-cell { display: flex; align-items: center; gap: var(--space-8); padding: var(--space-8) var(--space-12); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-ink); font: var(--type-caption); }

/* Piece: a company's hat */
.hat-label { display: inline-flex; align-items: center; gap: var(--space-6); font: var(--type-label); color: var(--color-ink); }
.hat-label.small { font: var(--type-caption); color: var(--color-meta); }
.hat-dot { width: var(--size-dot); height: var(--size-dot); border-radius: var(--radius-full); background: var(--hat-fill); flex: none; }
.hat-chip { display: inline-flex; align-items: center; gap: var(--space-6); min-height: var(--size-control); padding: var(--space-4) var(--space-12); border-radius: var(--radius-full); background: var(--hat-tint); color: var(--hat-fill); font: var(--type-label); }
.hat-chip.selected { background: var(--hat-fill); color: var(--hat-on); }
.hat-chip.selected .hat-dot { background: var(--hat-on); }
.hat-attention { font: var(--type-caption); color: var(--color-attention); }
.hat-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-12); }
.hat-icon { display: inline-flex; color: var(--color-meta); }
.hat-window { background: var(--hat-tint); border-radius: var(--radius-lg); padding: var(--space-16); display: grid; gap: var(--space-4); }
.hat-window p { font: var(--type-caption); color: var(--color-meta); }

/* Piece: the brief card */
.brief { max-width: var(--size-measure); background: var(--color-surface); border: var(--size-line) solid var(--color-line); border-radius: var(--radius-lg); box-shadow: var(--elevation-raised); padding: var(--space-24); }
.brief-head { display: grid; gap: var(--space-4); padding-bottom: var(--space-20); }
.brief-head h3 { font: var(--type-title); letter-spacing: var(--type-title-tracking); color: var(--color-ink); margin: 0; }
.brief-head p { font: var(--type-caption); color: var(--color-meta); }
.brief-section { display: grid; gap: var(--space-12); padding: var(--space-20) 0; border-top: var(--size-line) solid var(--color-line); }
.brief-section:last-child { padding-bottom: 0; }
.brief-summary { font: var(--type-reading); letter-spacing: var(--type-reading-tracking); color: var(--color-body); }
.highlights { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-4); }
.highlights a { display: grid; gap: var(--space-2); padding: var(--space-8); margin: 0 calc(-1 * var(--space-8)); border-radius: var(--radius-md); color: var(--color-ink); text-decoration: none; }
.highlights a:hover { background: var(--color-hover); }
.highlights small { font: var(--type-caption); color: var(--color-meta); }
.brief-counts { font: var(--type-caption); color: var(--color-meta); }

/* Piece: a pile row */
.rows { list-style: none; margin: 0; padding: 0; background: var(--color-surface); border: var(--size-line) solid var(--color-line); border-radius: var(--radius-lg); overflow: hidden; }
.row { position: relative; display: grid; grid-template-columns: var(--size-dot) 1fr; column-gap: var(--space-12); padding: var(--space-12) var(--space-16); min-height: var(--size-target); color: var(--color-body); text-decoration: none; }
.rows li + li .row::before { content: ""; position: absolute; top: 0; left: calc(var(--space-16) + var(--size-dot) + var(--space-12)); right: 0; border-top: var(--size-line) solid var(--color-line); }
.row:hover { background: var(--color-hover); }
.row[aria-current="true"] { background: var(--color-selected); }
.row:focus-visible { outline-offset: -2px; border-radius: var(--radius-md); }
.unread-dot { width: var(--size-dot); height: var(--size-dot); margin-top: calc((var(--type-label-size) * var(--type-label-line-height) - var(--size-dot)) / 2); border-radius: var(--radius-full); background: var(--color-ink); }
.row-main { display: grid; gap: var(--space-2); min-width: 0; }
.row-top { display: flex; align-items: baseline; gap: var(--space-6); }
.row-sender { font: var(--type-label); color: var(--color-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-count, .row-time { font: var(--type-caption); color: var(--color-meta); }
.row-time { margin-left: auto; white-space: nowrap; }
.row-subject { font: var(--type-body); color: var(--color-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-snippet { font: var(--type-body); color: var(--color-meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-tags { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4) var(--space-12); margin-top: var(--space-4); font: var(--type-caption); color: var(--color-meta); }
.row-tags span { display: inline-flex; align-items: center; gap: var(--space-4); }
.row.unread .row-sender, .row.unread .row-subject { font-weight: var(--font-weight-semibold); }
.row.unread .row-time { color: var(--color-ink); }
.row.done .row-sender, .row.done .row-subject { color: var(--color-body); }

/* Piece: the reason line on a handled thread */
.handled { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-8); }
.handled-item { display: grid; gap: var(--space-6); padding: var(--space-12) var(--space-16); background: var(--color-surface); border: var(--size-line) solid var(--color-line); border-radius: var(--radius-lg); }
.handled-subject { display: flex; align-items: baseline; gap: var(--space-8); font: var(--type-label); color: var(--color-ink); }
.reason { display: flex; align-items: flex-start; gap: var(--space-8); }
.reason .icon-sm { margin-top: calc((var(--type-caption-size) * var(--type-caption-line-height) - var(--size-icon-sm)) / 2); color: var(--color-meta); }
.reason-text { flex: 1; min-width: 0; font: var(--type-caption); color: var(--color-meta); }
.reason-text b { font-weight: var(--font-weight-medium); color: var(--color-body); }
.reason-state { font: var(--type-caption); color: var(--color-meta); white-space: nowrap; }
.reason-actions { display: flex; gap: var(--space-6); flex: none; }
.reason.proposed { background: var(--color-attention-tint); border-radius: var(--radius-md); padding: var(--space-8) var(--space-12); }
.reason.proposed .icon-sm { color: var(--color-attention); }
.reason.proposed .reason-text { color: var(--color-body); }
.reason.proposed .reason-text b { color: var(--color-ink); }
.reason.undone .reason-text b { color: var(--color-meta); }
.button { display: inline-flex; align-items: center; gap: var(--space-4); min-height: var(--size-control); padding: var(--space-4) var(--space-12); border-radius: var(--radius-sm); border: var(--size-line) solid var(--color-line-strong); background: var(--color-surface); color: var(--color-ink); font: var(--type-label); cursor: pointer; transition: background var(--motion-duration-fast) var(--motion-easing-standard); }
.button:hover { background: var(--color-hover); }
.button.primary { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-on-ink); }
`;
