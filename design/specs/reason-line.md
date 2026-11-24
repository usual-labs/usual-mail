# The reason line

Under each thread in Handled: who acted, what they did or want to do, why, when, and the one control that answers
it (Undo, or Approve and Reject). It is how Usual Mail keeps "nothing happens behind your back".

Tokens are written as in `tokens.json`. On the web `space.8` is `var(--space-8)`; in Swift it is `UsualSpace.s8`.
Type roles are `font: var(--type-caption)` on the web and `.usualFont(.caption)` in Swift.

## Anatomy

A handled item is the thread's subject line (the hat's small label, then the subject in `type.label`,
`color.ink`) with the reason line under it. The reason line is:

1. **Actor icon:** `rule` for a rule, `agent` for an agent, `person` for you.
2. **Text,** wrapping as needed: the actor and the action in medium weight ("A rule moved it to Receipts",
   "Claude Code wants to move it to Reads", "You marked it done"), then `: ` and the reason when there is one, then
   ` · ` and the time.
3. **Trailing:** the control or the state, by the record's state (below).

Actors: a rule is "A rule" (its text is the reason); an agent is its name; a person is "You". Actions are past
tense when applied ("moved it to Reads") and "wants to ..." when proposed.

## Measurements

| Part | Value |
|---|---|
| Handled item | `color.surface`, `radius.lg`, padding `space.12` top and bottom, `space.16` left and right |
| Between handled items | `space.8` |
| Subject line to reason line | `space.6` |
| Icon | `size.icon-sm` (16), `color.meta`, centred on the first line of text |
| Icon to text, text to trailing | `space.8` |
| Text | `type.caption`; actor and action in `font.weight.medium` and `color.body`; the rest `color.meta` |
| Buttons | height `size.control` (28), padding `space.12` left and right, `radius.sm`, `type.label`, icon `size.icon-sm` and `space.4` before the label |
| Between buttons | `space.6` |

## States

| Record state | Line | Trailing |
|---|---|---|
| `applied`, undoable | as above | **Undo** button with the `undo` icon |
| `applied`, not undoable | as above | nothing |
| `proposed` | on `color.attention-tint`, `radius.md`, padding `space.8` by `space.12`; icon `color.attention`; actor and action `color.ink`; the rest `color.body` | **Approve** (primary, `approve` icon) and **Reject** (`reject` icon) |
| `undone` | actor and action in `color.meta` | "Undone" in `type.caption`, `color.meta` |
| `rejected` | as undone | "Rejected" |
| `failed` | icon and the error text in `color.danger`, the error after the reason | "Failed" |

- **Primary button:** `color.ink` fill and `color.on-ink` label. Other buttons: `color.surface` with a
  `size.line` border in `color.line-strong` and an ink label; hover `color.hover`.
- **After Undo, Approve or Reject,** the line changes in place to its new state with `motion.duration.fade`; it
  doesn't leave the list.

## Platforms

- **SwiftUI:** Undo and Reject are the system's `.bordered` buttons at `.controlSize(.small)`. Approve is an
  ink-filled button (ink fill, on-ink label): the system's prominent style draws its label white, which disappears
  on dark mode's light ink. Text is one `Text` built from an `AttributedString`, so it wraps as a sentence.
- **HTML:** the line is a `p` holding the icon (`aria-hidden`), a `span` for the text with the actor and action in
  `b`, and real `button` elements.

## Accessibility

- The line reads as one sentence: "A rule moved it to Receipts: Receipts from paperloop.example go to Receipts,
  06:01", then its buttons.
- Button labels are words, not icons alone.
- Waiting proposals are marked by the tint, the icon colour and the Approve and Reject buttons together.
- Body and meta on `color.attention-tint` are tested at 4.5:1 or more, in light and dark.
