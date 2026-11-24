import SwiftUI

#if canImport(UIKit)
    import UIKit
#endif

/// A text role's values at the default text size. Sizes are points; line height is a multiple of the size and
/// tracking a fraction of it (em), so both follow the size when it grows.
public struct UsualTextStyle: Equatable, Sendable {
    public let family: UsualFontFamily
    /// The size on the Mac (and the web, in px).
    public let size: CGFloat
    /// The size on iPhone and iPad, at the default text size.
    public let iphoneSize: CGFloat
    public let weight: UsualFontWeight
    public let lineHeight: CGFloat
    public let tracking: CGFloat
    /// The text style whose growth the size follows on iPhone. Nil keeps the size fixed.
    public let textStyle: Font.TextStyle?

    /// This platform's size at the default text size.
    public var baseSize: CGFloat {
        #if os(iOS)
            iphoneSize
        #else
            size
        #endif
    }

    /// The size for a Dynamic Type setting. On iPhone it grows like `textStyle`; the Mac has no Dynamic Type and
    /// keeps it.
    public func size(for dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        #if os(iOS)
            guard let textStyle, dynamicTypeSize != .large else { return baseSize }
            let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
            return UIFontMetrics(forTextStyle: textStyle.uiKit).scaledValue(for: baseSize, compatibleWith: traits)
        #else
            return baseSize
        #endif
    }

    /// The font at `size` points. Geist Serif and Prociono have one weight, so `weight` only changes Geist Sans and
    /// mono; a serif is never drawn bold.
    public func font(size: CGFloat, weight: UsualFontWeight? = nil) -> Font {
        let weight = weight ?? self.weight
        guard let face = UsualFonts.face(family, weight: weight) else {
            return .system(size: size, weight: Font.Weight(weight), design: .monospaced)
        }
        UsualFonts.register()
        return .custom(face.postScriptName, fixedSize: size)
    }

    /// The font for a Dynamic Type setting, for places that need a `Font` rather than a view, such as text runs.
    public func font(for dynamicTypeSize: DynamicTypeSize, weight: UsualFontWeight? = nil) -> Font {
        font(size: size(for: dynamicTypeSize), weight: weight)
    }
}

extension View {
    /// Sets a Usual Mail text role: its font, tracking and line height, growing with the text size setting on
    /// iPhone and fixed on the Mac. `weight` applies to Geist Sans (and mono) only.
    public func usualFont(_ role: UsualTextRole, weight: UsualFontWeight? = nil) -> some View {
        modifier(UsualFontModifier(style: role.style, weight: weight))
    }
}

private struct UsualFontModifier: ViewModifier {
    let style: UsualTextStyle
    let weight: UsualFontWeight?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let size = style.size(for: dynamicTypeSize)
        content
            .font(style.font(size: size, weight: weight))
            .tracking(style.tracking * size)
            .lineHeight(.exact(points: style.lineHeight * size))
    }
}

extension Font.Weight {
    init(_ weight: UsualFontWeight) {
        switch weight.rawValue {
        case ..<350: self = .light
        case ..<450: self = .regular
        case ..<550: self = .medium
        case ..<650: self = .semibold
        default: self = .bold
        }
    }
}

#if canImport(UIKit)
    extension Font.TextStyle {
        var uiKit: UIFont.TextStyle {
            switch self {
            case .largeTitle: .largeTitle
            case .title: .title1
            case .title2: .title2
            case .title3: .title3
            case .headline: .headline
            case .subheadline: .subheadline
            case .callout: .callout
            case .footnote: .footnote
            case .caption: .caption1
            case .caption2: .caption2
            default: .body
            }
        }
    }
#endif
