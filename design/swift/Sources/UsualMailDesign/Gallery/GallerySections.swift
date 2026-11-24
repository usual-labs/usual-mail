import SwiftUI

// The gallery's token sections: colours, hats, type, space and radii, icons, and the hat piece.

struct ColorSwatches: View {
    let scheme: ColorScheme

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: UsualSpace.s12, alignment: .top)], alignment: .leading, spacing: UsualSpace.s12) {
            ForEach(UsualColor.swatches) { swatch in
                VStack(alignment: .leading, spacing: UsualSpace.s6) {
                    RoundedRectangle(cornerRadius: UsualRadius.md).fill(swatch.color).frame(height: 48)
                        .overlay(RoundedRectangle(cornerRadius: UsualRadius.md).strokeBorder(UsualColor.line, lineWidth: UsualSize.line))
                    Text(swatch.name).usualFont(.label).foregroundStyle(UsualColor.ink)
                    Text(swatch.colors.value(for: scheme).hexString).usualFont(.caption).foregroundStyle(UsualColor.meta)
                }
            }
        }
    }
}

struct HatPalette: View {
    let scheme: ColorScheme

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: UsualSpace.s12, alignment: .top)], alignment: .leading, spacing: UsualSpace.s12) {
            ForEach(UsualHat.all) { hat in
                VStack(alignment: .leading, spacing: UsualSpace.s6) {
                    Text(hat.name).usualFont(.label).foregroundStyle(hat.onColor)
                        .padding(.horizontal, UsualSpace.s8).padding(.vertical, UsualSpace.s4)
                        .background(hat.fillColor, in: RoundedRectangle(cornerRadius: UsualRadius.sm))
                    HatChip(hat: hat.name, name: hat.name)
                    Text("\(hat.fill.value(for: scheme).hexString) · \(hat.tint.value(for: scheme).hexString)")
                        .usualFont(.caption).foregroundStyle(UsualColor.meta)
                }
                .padding(UsualSpace.s12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(hat.tintColor, in: RoundedRectangle(cornerRadius: UsualRadius.lg))
            }
        }
    }
}

struct TypeRoles: View {
    let samples: [UsualTextRole: String]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(UsualTextRole.allCases, id: \.self) { role in
                Rectangle().fill(UsualColor.line).frame(height: UsualSize.line)
                HStack(alignment: .firstTextBaseline, spacing: UsualSpace.s16) {
                    VStack(alignment: .leading, spacing: UsualSpace.s2) {
                        Text(role.rawValue).usualFont(.label).foregroundStyle(UsualColor.ink)
                        Text(spec(role.style)).usualFont(.caption).foregroundStyle(UsualColor.meta)
                    }
                    .frame(width: 160, alignment: .leading)
                    sample(role)
                }
                .padding(.vertical, UsualSpace.s12)
            }
        }
    }

    @ViewBuilder private func sample(_ role: UsualTextRole) -> some View {
        let text = samples[role] ?? role.rawValue
        if role == .wordmark {
            Wordmark(suffix: String(text.split(separator: "|").last ?? "mail"))
        } else {
            Text(text).usualFont(role).foregroundStyle(UsualColor.ink)
        }
    }

    private func spec(_ s: UsualTextStyle) -> String {
        let family = ["serif": "Geist Serif", "sans": "Geist Sans", "mono": "System mono", "wordmark": "Prociono"]["\(s.family)"] ?? ""
        let line = (s.size * s.lineHeight * 10).rounded() / 10
        let tracking = s.tracking == 0 ? "" : ", \(s.tracking.formatted())em"
        let grows = s.textStyle.map { "grows like \($0)" } ?? "fixed"
        return "\(family) \(s.weight.rawValue), \(s.size.formatted())/\(line.formatted())\(tracking); iPhone \(s.iphoneSize.formatted()), \(grows)"
    }
}

struct SpaceAndRadii: View {
    private let spaces: [(String, CGFloat)] = [
        ("2", UsualSpace.s2), ("4", UsualSpace.s4), ("6", UsualSpace.s6), ("8", UsualSpace.s8), ("12", UsualSpace.s12),
        ("16", UsualSpace.s16), ("20", UsualSpace.s20), ("24", UsualSpace.s24), ("32", UsualSpace.s32), ("40", UsualSpace.s40),
        ("48", UsualSpace.s48), ("64", UsualSpace.s64),
    ]
    private let radii: [(String, CGFloat)] = [
        ("sm", UsualRadius.sm), ("md", UsualRadius.md), ("lg", UsualRadius.lg), ("xl", UsualRadius.xl), ("full", UsualRadius.full),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: UsualSpace.s4) {
            ForEach(spaces, id: \.0) { name, value in
                HStack(spacing: UsualSpace.s16) {
                    Text("space.\(name)").usualFont(.caption).foregroundStyle(UsualColor.meta).frame(width: 72, alignment: .leading)
                    RoundedRectangle(cornerRadius: UsualRadius.sm).fill(UsualColor.ink).frame(width: value, height: UsualSpace.s12)
                }
            }
            Text("Radii").usualFont(.label).foregroundStyle(UsualColor.meta).padding(.top, UsualSpace.s24)
            HStack(spacing: UsualSpace.s16) {
                ForEach(radii, id: \.0) { name, value in
                    VStack(alignment: .leading, spacing: UsualSpace.s6) {
                        RoundedRectangle(cornerRadius: min(value, 32)).fill(UsualColor.surface)
                            .overlay(RoundedRectangle(cornerRadius: min(value, 32)).strokeBorder(UsualColor.lineStrong, lineWidth: UsualSize.line))
                            .frame(width: 88, height: 64)
                        Text("radius.\(name)").usualFont(.caption).foregroundStyle(UsualColor.meta)
                    }
                }
            }
        }
    }
}

struct IconGrid: View {
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: UsualSpace.s8)], alignment: .leading, spacing: UsualSpace.s8) {
            ForEach(UsualIcon.allCases, id: \.self) { icon in
                HStack(spacing: UsualSpace.s8) {
                    icon.view(size: UsualSize.iconMd)
                    Text(icon.rawValue).usualFont(.caption)
                }
                .foregroundStyle(UsualColor.ink)
                .padding(.vertical, UsualSpace.s8).padding(.horizontal, UsualSpace.s12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(UsualColor.surface, in: RoundedRectangle(cornerRadius: UsualRadius.md))
            }
        }
    }
}

/// specs/hat.md: for each inbox, the label, the chip, the selected chip and any problem; then a window in a hat's tint.
struct HatPiece: View {
    let inboxes: [GalleryInbox]

    var body: some View {
        VStack(alignment: .leading, spacing: UsualSpace.s16) {
            ForEach(inboxes) { inbox in
                VStack(alignment: .leading, spacing: UsualSpace.s8) {
                    HStack(spacing: UsualSpace.s12) {
                        inbox.icon.view(size: UsualSize.iconSm).foregroundStyle(UsualColor.meta)
                        HatLabel(hat: inbox.hat, name: inbox.name)
                        HatChip(hat: inbox.hat, name: inbox.name)
                        HatChip(hat: inbox.hat, name: inbox.name, selected: true)
                    }
                    if let attention = inbox.attention {
                        Text(attention).usualFont(.caption).foregroundStyle(UsualColor.attention)
                    }
                }
            }
            if let first = inboxes.first {
                VStack(alignment: .leading, spacing: UsualSpace.s4) {
                    HatLabel(hat: first.hat, name: first.name)
                    HStack(spacing: UsualSpace.s4) {
                        Text("\(first.address) ·")
                        first.trustIcon.view(size: UsualSize.iconSm)
                        Text(first.trust)
                    }
                    .usualFont(.caption).foregroundStyle(UsualColor.meta)
                }
                .padding(UsualSpace.s16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(GalleryPieces.hat(first.hat).tintColor, in: RoundedRectangle(cornerRadius: UsualRadius.lg))
            }
        }
    }
}
