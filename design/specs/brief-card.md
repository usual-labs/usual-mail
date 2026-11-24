# The brief card

The brief says what happened in each inbox since the last one and what needs the person. One card holds one brief,
with a section per inbox, in the order the brief lists them.

Tokens are written as in `tokens.json`. On the web `space.24` is `var(--space-24)`; in Swift it is
`UsualSpace.s24`. Type roles are `font: var(--type-reading)` on the web and `.usualFont(.reading)` in Swift.

## Anatomy

1. **Header:** the title ("Brief"), then one meta line: the period and who wrote it ("Since yesterday 17:00 ·
   Written by Claude Code").
2. **Sections,** one per inbox, each above a hairline:
   - the inbox's hat label (see `hat.md`),
   - the summary, if the brief has one,
   - the highlights, each a line and the thread's subject under it; each opens its thread,
   - the counts: the piles and done with a count above zero, in order People, Reads, Receipts, Screening, Done
     ("People 2 · Reads 1 · Done 1").

## Measurements

| Part | Value |
|---|---|
| Card | `color.surface`, `radius.lg`, padding `space.24` (iPhone `space.20`), at most `size.measure` (640) wide |
| Card edge, web | `size.line` border in `color.line` and `elevation.raised` |
| Card edge, Apple | none: a solid card with no border or shadow |
| Title | `type.title`, `color.ink` |
| Header meta line | `type.caption`, `color.meta`, `space.4` below the title |
| Header to first section | `space.20` |
| Section divider | `size.line` in `color.line`, full card width |
| Section padding | `space.20` above and below (none below the last) |
| Inside a section | `space.12` between hat label, summary, highlights and counts |
| Summary | `type.reading`, `color.body` |
| Highlight line | `type.body`, `color.ink`; the subject `type.caption`, `color.meta`, `space.2` below it |
| Highlight hit area | padding `space.8`, pulled out by `space.8` on each side so text stays aligned; `radius.md` |
| Between highlights | `space.4` |
| Counts | `type.caption`, `color.meta` |

## States

- **No summary:** the section shows its hat label and counts only.
- **No highlights:** leave the list out; don't write "Nothing to report".
- **Highlight hover (web, Mac):** `color.hover` behind the highlight's hit area. Press follows the platform.
- **Highlight focus (web):** the focus ring, `2px` solid `color.focus`, offset `2px`, on the hit area.
- **Loading:** show the last brief; don't draw a placeholder card.

## Platforms

- **SwiftUI:** a `VStack` with the padding above and `UsualColor.surface` in a `RoundedRectangle` of
  `UsualRadius.lg`, `.frame(maxWidth: UsualSize.measure)`. Highlights are `Button`s (plain style) or
  `NavigationLink`s around the two lines. The Mac and iPhone use the same layout; the iPhone's sizes come from the
  type roles.
- **HTML:** an `article` with a `header` (`h2` or `h3` for the title) and a `section` per inbox. Highlights are a
  `ul` of `a` elements.

## Accessibility

- The title is a heading; each section starts with its inbox name, so a screen reader can jump between them.
- A highlight reads as one item: its line, then its subject.
- Text and its ground are tested at 4.5:1 or more: body and meta on surface, in light and dark.
