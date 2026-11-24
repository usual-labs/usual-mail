# A company's hat

Each inbox wears a hat: its name and one colour from the hat palette. The hat tells you which company a thing
belongs to, everywhere: in lists, in the brief, in Handled, and around the whole window when you are inside one
inbox.

Tokens are written as in `tokens.json`. On the web `space.6` is `var(--space-6)`; in Swift it is `UsualSpace.s6`.
A hat's three colours are `--hat-fill`, `--hat-on` and `--hat-tint` inside `data-hat="<name>"` on the web, and
`hat.fillColor`, `hat.onColor` and `hat.tintColor` in Swift.

## Choosing the hat

- The palette has twelve hats (`color.hat.*`). Offer only these when someone picks a colour for an inbox.
- A hat's key is its light `fill` hex. Store it as `Inbox.color`.
- To show a stored colour, take the hat whose light fill is nearest in OKLab: `UsualHat.matching(hex:)` in Swift,
  `matchHat` in `design/scripts/lib/sample.mjs` on the web. A key matches itself; any other colour lands on the
  closest hat; text that isn't a colour gets `slate`.
- Never draw the stored hex directly. Only the palette is checked for contrast in light and dark.

## Variants

| Variant | Where | Anatomy |
|---|---|---|
| Label | Brief sections, list tags, Handled | Dot, then the name |
| Small label | Inside a row's tags line or a handled subject | Same, in caption type and meta colour |
| Chip | Inbox filters and tabs | Pill on the tint, dot and name in the fill colour |
| Selected chip | The inbox you are in; compose's From | Pill on the fill, dot and name in the on colour |
| Window tint | Inside one inbox | The page's background becomes the tint |

## Measurements

| Part | Value |
|---|---|
| Dot | `size.dot` (8) square, `radius.full`, `hat fill` (`hat on` in a selected chip) |
| Dot to name | `space.6` |
| Label name | `type.label`, `color.ink` |
| Small label name | `type.caption`, `color.meta` |
| Chip height | at least `size.control` (28) |
| Chip padding | `space.4` top and bottom, `space.12` left and right |
| Chip shape | `radius.full` |
| Chip colours | background `hat tint`, text and dot `hat fill` |
| Selected chip colours | background `hat fill`, text and dot `hat on` |
| Window tint | background `hat tint`; cards and rows on it keep `color.surface` |

## States

- **Needs attention** (`Inbox.status` is `needs_attention`): after the label or chip, the status detail in
  `type.caption`, `color.attention`. Keep the hat's own colour; don't turn it red or amber.
- **Hover and press** (chips that are buttons): the pointer changes; the colours don't, because the tint already
  marks the chip. Press follows the platform.
- **Focus** (web): the focus ring, `2px` solid `color.focus`, offset `2px`.

## Platforms

- **SwiftUI:** a dot is a `Circle` of `UsualSize.dot`; the name uses `.usualFont(.label)` or `.caption`. A chip
  is an `HStack` with the padding above, `.frame(minHeight: UsualSize.control)` and a `Capsule` background. A chip
  that switches inboxes is a `Button` with that label. For the window tint, put `hat.tintColor` behind the
  content; toolbars and sidebars stay the system's (glass floats over it).
- **HTML:** `data-hat="<name>"` on the element or any ancestor sets `--hat-fill`, `--hat-on` and `--hat-tint`.
  A chip is a `button` or `a` when it does something, a `span` otherwise.

## Accessibility

- The name always appears with the colour; colour is never the only way to tell inboxes apart.
- The dot is decorative: `aria-hidden` on the web, hidden from VoiceOver in Swift.
- Every pairing used here is tested at 4.5:1 or more in light and dark: `on` on `fill`, `fill` on `tint`, and
  ink, body and meta on `tint`. The fill is tested at 3:1 against background and surface.
