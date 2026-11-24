import SwiftUI

/// Every colour, type role, space, radius and icon, and the four pieces from design/specs, with the same content as
/// design/gallery/index.html. Pieces and colours are shown in light and dark side by side.
public struct GalleryView: View {
    let content: GalleryContent

    public init() { content = .sample }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: UsualSpace.s64) {
                masthead
                section("Colours", "The family's monochrome palette. Each token has a light and a dark value.") {
                    bothSchemes { scheme in ColorSwatches(scheme: scheme) }
                }
                section("Hats", "A company's colour: fill, the readable colour on it, and a soft tint. The light fill is the hat's key.") {
                    bothSchemes { scheme in HatPalette(scheme: scheme) }
                }
                section("Type", "Geist Serif for the brief, headings and large text; Geist Sans for small text and controls; Prociono for the wordmark only.") {
                    TypeRoles(samples: content.typeSamples)
                }
                section("Space and radii", "Spacing steps are named by their size. Radii run from chips to sheets.") {
                    SpaceAndRadii()
                }
                section("Icons", "Hugeicons' free set, Stroke Rounded. Each name is listed in design/icons.json.") {
                    IconGrid()
                }
                section("A company's hat", "See design/specs/hat.md. Label, chip, selected chip, a problem, and the window tint.") {
                    bothSchemes { _ in HatPiece(inboxes: content.inboxes) }
                }
                section("The brief card", "See design/specs/brief-card.md.") {
                    bothSchemes { _ in BriefCard(brief: content.brief) }
                }
                section("A pile row", "See design/specs/pile-row.md. The second row is selected.") {
                    bothSchemes { _ in
                        VStack(spacing: 0) {
                            ForEach(content.rows) { row in
                                if row.id != content.rows.first?.id {
                                    Rectangle().fill(UsualColor.line).frame(height: UsualSize.line)
                                        .padding(.leading, UsualSpace.s16 + UsualSize.dot + UsualSpace.s12)
                                }
                                PileRow(row: row)
                            }
                        }
                        .background(UsualColor.surface)
                        .clipShape(RoundedRectangle(cornerRadius: UsualRadius.lg))
                    }
                }
                section("The reason line", "See design/specs/reason-line.md. Under each handled thread.") {
                    bothSchemes { _ in
                        VStack(spacing: UsualSpace.s8) { ForEach(content.reasons) { HandledItem(reason: $0) } }
                    }
                }
            }
            .padding(.horizontal, UsualSpace.s24)
            .padding(.vertical, UsualSpace.s48)
            .frame(maxWidth: 1120, alignment: .leading)
        }
        .background(UsualColor.background)
    }

    private var masthead: some View {
        VStack(alignment: .leading, spacing: UsualSpace.s8) {
            Wordmark(suffix: "mail")
            Text("Design gallery. The look has not been checked by eye.").usualFont(.caption).foregroundStyle(UsualColor.meta)
        }
    }

    private func section(_ title: String, _ intro: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: UsualSpace.s8) {
            Text(title).usualFont(.title).foregroundStyle(UsualColor.ink)
            Text(intro).usualFont(.caption).foregroundStyle(UsualColor.meta).frame(maxWidth: UsualSize.measure, alignment: .leading)
                .padding(.bottom, UsualSpace.s16)
            content()
        }
    }

    /// The same content in light and dark, side by side where there is room and stacked where there isn't.
    private func bothSchemes(@ViewBuilder _ content: @escaping (ColorScheme) -> some View) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: UsualSpace.s16) { pane(.light, content); pane(.dark, content) }
            VStack(alignment: .leading, spacing: UsualSpace.s16) { pane(.light, content); pane(.dark, content) }
        }
    }

    private func pane(_ scheme: ColorScheme, _ content: (ColorScheme) -> some View) -> some View {
        VStack(alignment: .leading, spacing: UsualSpace.s16) {
            Text(scheme == .dark ? "Dark" : "Light").usualFont(.caption).foregroundStyle(UsualColor.meta)
            content(scheme)
        }
        .padding(UsualSpace.s24)
        .frame(minWidth: 340, maxWidth: .infinity, alignment: .leading)
        .background(UsualColor.background, in: RoundedRectangle(cornerRadius: UsualRadius.xl))
        .overlay(RoundedRectangle(cornerRadius: UsualRadius.xl).strokeBorder(UsualColor.line, lineWidth: UsualSize.line))
        .environment(\.colorScheme, scheme)
    }
}

/// "Usual" in ink joined to a suffix in the suffix gray, in Prociono.
struct Wordmark: View {
    let suffix: String

    var body: some View {
        var usual = AttributedString("Usual")
        usual.foregroundColor = UsualColor.ink
        var tail = AttributedString(suffix)
        tail.foregroundColor = UsualColor.suffix
        return Text(usual + tail).usualFont(.wordmark).accessibilityLabel("Usual \(suffix)")
    }
}

#Preview("Gallery") {
    GalleryView().frame(minWidth: 900, minHeight: 800)
}

#Preview("Gallery, dark") {
    GalleryView().frame(minWidth: 900, minHeight: 800).preferredColorScheme(.dark)
}
