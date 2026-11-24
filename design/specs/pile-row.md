# A pile row

One thread in a list: a pile, a stack, Now's list view, or the all-inboxes view. It answers who, what, when and
which company at a glance.

Tokens are written as in `tokens.json`. On the web `space.12` is `var(--space-12)`; in Swift it is
`UsualSpace.s12`. Type roles are `font: var(--type-body)` on the web and `.usualFont(.body)` in Swift.

## Anatomy

A leading column with the unread dot, and a main column of four lines:

1. **Sender** (the participant who isn't the inbox's own address), the message count when above 1, and the time
   at the trailing edge.
2. **Subject.**
3. **Snippet,** one line.
4. **Tags:** the hat's small label (left out where the whole list is one inbox), then any of: the stack with its
   icon ("Reply later", "Set aside"), the come-back time with the `come-back` icon ("Comes back Thu 08:00 if no
   reply"), "Done" with the `done` icon, and the `attachment` icon.

Times: today as 24-hour `08:52`, then `Yesterday`, then the weekday within a week (`Fri`), then `13 Nov`, in the
person's time zone.

## Measurements

| Part | Value |
|---|---|
| Row padding | `space.12` top and bottom, `space.16` left and right |
| Row height | at least `size.target` (44) |
| Leading column | `size.dot` (8) wide, `space.12` before the main column |
| Unread dot | `size.dot`, `radius.full`, `color.ink`, centred on the first line |
| Between lines 1 to 3 | `space.2` |
| Before the tags line | `space.4` more |
| Sender | `type.label`, `color.ink`, one line, truncated at the end |
| Message count | `type.caption`, `color.meta`, `space.6` after the sender |
| Time | `type.caption`, `color.meta`, never truncated |
| Subject | `type.body`, `color.ink`, one line |
| Snippet | `type.body`, `color.meta`, one line |
| Tags | `type.caption`, `color.meta`; icons `size.icon-sm`, `space.4` from their text; `space.12` between tags |
| Separator (web) | `size.line` in `color.line`, starting where the main column starts |
| Background | `color.surface` |

## States

| State | Change |
|---|---|
| Unread | the dot shows; sender and subject take `font.weight.semibold`; the time turns `color.ink` |
| Read | no dot; weights from the type roles |
| Done | sender and subject in `color.body` instead of ink; the Done tag shows |
| Hover (web, Mac) | background `color.hover` |
| Selected | web: background `color.selected`; Apple: the system's list selection |
| Focus (web) | the focus ring inside the row: `2px` solid `color.focus`, offset `-2px`, `radius.md` |
| Moving out (done, stacked) | the row leaves with `motion.duration.base` and `motion.easing.exit`; under reduced motion it goes at once |

## Platforms

- **SwiftUI:** the row is a list row in a system `List`; the system draws selection, separators, insets and swipe
  actions, so on Apple the row's padding and separator values above apply only where it is drawn outside a list.
  Sender and subject use `.usualFont(.label, weight: .semibold)` and `.usualFont(.body, weight: .semibold)` when
  unread. Use `lineLimit(1)` on the first three lines, and let the tags line wrap.
- **HTML:** an `li` holding one `a` (or `button`) for the whole row, with `aria-current="true"` on the selected
  row. The unread dot carries `aria-label="Unread"`; the read row's empty dot is `aria-hidden`.

## Accessibility

- VoiceOver and screen readers hear: unread, sender, subject, time, then the tags. The snippet comes last.
- Unread is shown by the dot, the weight and the time's colour together, never by colour alone.
- At accessibility text sizes on iPhone, sender and time may wrap to two lines; the time moves under the sender.
- Meta text is tested at 4.5:1 on surface, hover and selected, in light and dark.
