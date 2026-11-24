import SwiftUI

#if canImport(AppKit)
    import AppKit
#else
    import UIKit
#endif

/// An sRGB colour as tokens.json writes it: `0xRRGGBB` and an alpha.
public struct UsualRGB: Equatable, Sendable {
    public let hex: UInt32
    public let alpha: Double

    public init(_ hex: UInt32, alpha: Double = 1) {
        self.hex = hex
        self.alpha = alpha
    }

    public var red: Double { Double((hex >> 16) & 0xFF) / 255 }
    public var green: Double { Double((hex >> 8) & 0xFF) / 255 }
    public var blue: Double { Double(hex & 0xFF) / 255 }

    /// "#rrggbb", as the tokens and Inbox.color write it.
    public var hexString: String { "#" + String(format: "%06x", hex) }

    /// Parses "#RRGGBB" or "RRGGBB"; nil for anything else.
    public init?(hexString: String) {
        var digits = Substring(hexString.trimmingCharacters(in: .whitespaces))
        if digits.hasPrefix("#") { digits = digits.dropFirst() }
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(value)
    }
}

/// A colour's light and dark values.
public struct UsualColorPair: Equatable, Sendable {
    public let light: UsualRGB
    public let dark: UsualRGB

    public init(light: UsualRGB, dark: UsualRGB) {
        self.light = light
        self.dark = dark
    }

    public func value(for scheme: ColorScheme) -> UsualRGB { scheme == .dark ? dark : light }
}

/// A named colour from tokens.json, for galleries and tests.
public struct UsualColorSwatch: Identifiable, Sendable {
    public let name: String
    public let colors: UsualColorPair
    public var id: String { name }
    public var color: Color { Color(colors) }
}

extension Color {
    /// A colour that follows the system's light and dark appearance, and SwiftUI's `colorScheme` where the view
    /// sets one.
    public init(_ pair: UsualColorPair) {
        #if canImport(AppKit)
            self.init(
                nsColor: NSColor(name: nil) { appearance in
                    let rgb = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? pair.dark : pair.light
                    return NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: rgb.alpha)
                })
        #else
            self.init(
                uiColor: UIColor { traits in
                    let rgb = traits.userInterfaceStyle == .dark ? pair.dark : pair.light
                    return UIColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: rgb.alpha)
                })
        #endif
    }
}
