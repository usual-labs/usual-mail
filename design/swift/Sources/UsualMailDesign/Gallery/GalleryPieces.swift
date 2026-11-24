import SwiftUI

// Reference renderings of the four pieces in design/specs, built from the tokens only. They exist to show the specs
// in the gallery; the apps build their own from the same specs.

/// specs/hat.md: a dot in the hat's fill and the inbox's name.
struct HatLabel: View {
    let hat: String
    let name: String
    var small = false

    var body: some View {
        HStack(spacing: UsualSpace.s6) {
            Circle().fill(GalleryPieces.hat(hat).fillColor).frame(width: UsualSize.dot, height: UsualSize.dot)
            Text(name)
                .usualFont(small ? .caption : .label)
                .foregroundStyle(small ? UsualColor.meta : UsualColor.ink)
        }
    }
}

/// specs/hat.md: the chip, on the tint with fill-coloured text, or selected on the fill with on-coloured text.
struct HatChip: View {
    let hat: String
    let name: String
    var selected = false

    var body: some View {
        let h = GalleryPieces.hat(hat)
        HStack(spacing: UsualSpace.s6) {
            Circle().fill(selected ? h.onColor : h.fillColor).frame(width: UsualSize.dot, height: UsualSize.dot)
            Text(name).usualFont(.label)
        }
        .foregroundStyle(selected ? h.onColor : h.fillColor)
        .padding(.horizontal, UsualSpace.s12)
        .padding(.vertical, UsualSpace.s4)
        .frame(minHeight: UsualSize.control)
        .background(selected ? h.fillColor : h.tintColor, in: Capsule())
    }
}

/// specs/brief-card.md.
struct BriefCard: View {
    let brief: GalleryBrief

    #if os(iOS)
        static let padding = UsualSpace.s20
    #else
        static let padding = UsualSpace.s24
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: UsualSpace.s4) {
                Text(brief.title).usualFont(.title).foregroundStyle(UsualColor.ink)
                Text("\(brief.period) · Written by \(brief.writtenBy)").usualFont(.caption).foregroundStyle(UsualColor.meta)
            }
            .padding(.bottom, UsualSpace.s20)
            ForEach(brief.sections) { section in
                Rectangle().fill(UsualColor.line).frame(height: UsualSize.line)
                VStack(alignment: .leading, spacing: UsualSpace.s12) {
                    HatLabel(hat: section.hat, name: section.inbox)
                    if let summary = section.summary {
                        Text(summary).usualFont(.reading).foregroundStyle(UsualColor.body)
                    }
                    if !section.highlights.isEmpty {
                        VStack(alignment: .leading, spacing: UsualSpace.s4) {
                            ForEach(section.highlights) { highlight in
                                VStack(alignment: .leading, spacing: UsualSpace.s2) {
                                    Text(highlight.line).usualFont(.body).foregroundStyle(UsualColor.ink)
                                    Text(highlight.subject).usualFont(.caption).foregroundStyle(UsualColor.meta)
                                }
                                .padding(UsualSpace.s8)
                                .padding(.horizontal, -UsualSpace.s8)
                            }
                        }
                    }
                    if !section.counts.isEmpty {
                        Text(section.counts).usualFont(.caption).foregroundStyle(UsualColor.meta)
                    }
                }
                .padding(.top, UsualSpace.s20)
                .padding(.bottom, section.id == brief.sections.last?.id ? 0 : UsualSpace.s20)
            }
        }
        .padding(BriefCard.padding)
        .frame(maxWidth: UsualSize.measure, alignment: .leading)
        .background(UsualColor.surface, in: RoundedRectangle(cornerRadius: UsualRadius.lg))
    }
}

/// specs/pile-row.md. In the apps a row sits in a system List, which draws selection, separators and insets; the
/// gallery draws `UsualColor.selected` itself so both appearances can sit side by side.
struct PileRow: View {
    let row: GalleryRow
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(alignment: .top, spacing: UsualSpace.s12) {
            Circle()
                .fill(row.unread ? UsualColor.ink : .clear)
                .frame(width: UsualSize.dot, height: UsualSize.dot)
                .padding(.top, centred(UsualSize.dot, on: .label, dynamicTypeSize))
                .accessibilityLabel(row.unread ? "Unread" : "")
                .accessibilityHidden(!row.unread)
            VStack(alignment: .leading, spacing: UsualSpace.s2) {
                HStack(alignment: .firstTextBaseline, spacing: UsualSpace.s6) {
                    Text(row.sender).usualFont(.label, weight: row.unread ? .semibold : nil)
                        .foregroundStyle(row.done ? UsualColor.body : UsualColor.ink).lineLimit(1)
                    if row.messageCount > 1 {
                        Text("\(row.messageCount)").usualFont(.caption).foregroundStyle(UsualColor.meta)
                    }
                    Spacer(minLength: UsualSpace.s8)
                    Text(row.time).usualFont(.caption).foregroundStyle(row.unread ? UsualColor.ink : UsualColor.meta)
                }
                Text(row.subject).usualFont(.body, weight: row.unread ? .semibold : nil)
                    .foregroundStyle(row.done ? UsualColor.body : UsualColor.ink).lineLimit(1)
                Text(row.snippet).usualFont(.body).foregroundStyle(UsualColor.meta).lineLimit(1)
                tags.padding(.top, UsualSpace.s4)
            }
        }
        .padding(.vertical, UsualSpace.s12)
        .padding(.horizontal, UsualSpace.s16)
        .frame(minHeight: UsualSize.target)
        .background(row.selected ? UsualColor.selected : UsualColor.surface)
    }

    private var tags: some View {
        HStack(spacing: UsualSpace.s12) {
            HatLabel(hat: row.hat, name: row.inbox, small: true)
            if let stack = row.stack, let icon = row.stackIcon { tag(icon, stack) }
            if let comeBack = row.comeBack { tag(.comeBack, comeBack) }
            if row.done { tag(.done, "Done") }
            if row.attachment {
                UsualIcon.attachment.view(size: UsualSize.iconSm).accessibilityLabel("Attachment").accessibilityHidden(false)
            }
        }
        .foregroundStyle(UsualColor.meta)
    }

    private func tag(_ icon: UsualIcon, _ text: String) -> some View {
        HStack(spacing: UsualSpace.s4) {
            icon.view(size: UsualSize.iconSm)
            Text(text).usualFont(.caption)
        }
    }
}

/// specs/reason-line.md, under a handled thread's subject.
struct HandledItem: View {
    let reason: GalleryReason

    var body: some View {
        VStack(alignment: .leading, spacing: UsualSpace.s6) {
            HStack(alignment: .firstTextBaseline, spacing: UsualSpace.s8) {
                HatLabel(hat: reason.hat, name: reason.inbox, small: true)
                Text(reason.subject).usualFont(.label).foregroundStyle(UsualColor.ink)
            }
            ReasonLine(reason: reason)
        }
        .padding(.vertical, UsualSpace.s12)
        .padding(.horizontal, UsualSpace.s16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(UsualColor.surface, in: RoundedRectangle(cornerRadius: UsualRadius.lg))
    }
}

struct ReasonLine: View {
    let reason: GalleryReason
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var proposed: Bool { reason.state == "proposed" }

    var body: some View {
        HStack(alignment: .top, spacing: UsualSpace.s8) {
            reason.icon.view(size: UsualSize.iconSm)
                .foregroundStyle(proposed ? UsualColor.attention : UsualColor.meta)
                .padding(.top, centred(UsualSize.iconSm, on: .caption, dynamicTypeSize))
            text.frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.vertical, proposed ? UsualSpace.s8 : 0)
        .padding(.horizontal, proposed ? UsualSpace.s12 : 0)
        .background(proposed ? UsualColor.attentionTint : .clear, in: RoundedRectangle(cornerRadius: UsualRadius.md))
    }

    private var text: some View {
        let lead = proposed ? UsualColor.ink : reason.state == "undone" ? UsualColor.meta : UsualColor.body
        var line = AttributedString("\(reason.actor) \(reason.action)")
        line.font = UsualTextRole.caption.style.font(for: dynamicTypeSize, weight: .medium)
        line.foregroundColor = lead
        var rest = AttributedString((reason.reason.map { ": \($0)" } ?? "") + " · \(reason.time)")
        rest.foregroundColor = proposed ? UsualColor.body : UsualColor.meta
        return Text(line + rest).usualFont(.caption)
    }

    @ViewBuilder private var trailing: some View {
        switch reason.state {
        case "proposed":
            HStack(spacing: UsualSpace.s6) {
                Button {} label: { Label { Text("Approve") } icon: { UsualIcon.approve.view(size: UsualSize.iconSm) } }
                    .buttonStyle(InkButtonStyle())
                Button {} label: { Label { Text("Reject") } icon: { UsualIcon.reject.view(size: UsualSize.iconSm) } }
                    .buttonStyle(.bordered).controlSize(.small)
            }
        case "applied" where reason.undoable:
            Button {} label: { Label { Text("Undo") } icon: { UsualIcon.undo.view(size: UsualSize.iconSm) } }
                .buttonStyle(.bordered).controlSize(.small)
        case "undone", "rejected", "failed":
            Text(reason.state.capitalized).usualFont(.caption).foregroundStyle(UsualColor.meta)
        default:
            EmptyView()
        }
    }
}

/// The primary action in a line of content: ink fill and on-ink label. The system's prominent style draws its label
/// white, which disappears on the light ink of dark mode.
struct InkButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.titleAndIcon)
            .usualFont(.label)
            .foregroundStyle(UsualColor.onInk)
            .padding(.horizontal, UsualSpace.s12)
            .frame(minHeight: UsualSize.control)
            .background(UsualColor.ink.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: UsualRadius.sm))
    }
}

enum GalleryPieces {
    static func hat(_ name: String) -> UsualHat { UsualHat.named(name) ?? .slate }
}

/// The top padding that centres something `height` tall on the first line of a text role.
private func centred(_ height: CGFloat, on role: UsualTextRole, _ dynamicTypeSize: DynamicTypeSize) -> CGFloat {
    let style = role.style
    return max(0, (style.lineHeight * style.size(for: dynamicTypeSize) - height) / 2)
}
