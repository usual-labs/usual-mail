import SwiftUI

/// A company's hat: the colour an inbox wears. `fill` is the strong colour, `on` is text and icons placed on fill,
/// and `tint` is a soft background on which ink, body, meta and fill-coloured text stay readable.
public struct UsualHat: Identifiable, Equatable, Sendable {
    /// The token name: "blue", "green", ...
    public let name: String
    /// The light fill as "#rrggbb". Store it as Inbox.color.
    public let key: String
    public let fill: UsualColorPair
    public let on: UsualColorPair
    public let tint: UsualColorPair

    public var id: String { name }
    public var fillColor: Color { Color(fill) }
    public var onColor: Color { Color(on) }
    public var tintColor: Color { Color(tint) }

    /// The hat with this token name.
    public static func named(_ name: String) -> UsualHat? { all.first { $0.name == name } }

    /// The hat for a stored colour such as Inbox.color: the one whose light fill is nearest in OKLab, so a key
    /// matches itself and any other colour lands on the closest hat. Text that isn't a colour gets slate.
    public static func matching(hex: String) -> UsualHat {
        guard let rgb = UsualRGB(hexString: hex) else { return slate }
        let target = OKLab(rgb)
        return all.min { target.distance(to: OKLab($0.fill.light)) < target.distance(to: OKLab($1.fill.light)) } ?? slate
    }
}

/// OKLab coordinates, the same maths as design/scripts/lib/color.mjs, so web and Swift pick the same hat.
struct OKLab: Equatable {
    let l: Double
    let a: Double
    let b: Double

    init(_ rgb: UsualRGB) {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let (r, g, bl) = (linear(rgb.red), linear(rgb.green), linear(rgb.blue))
        let lms = (
            cbrt(0.4122214708 * r + 0.5363371923 * g + 0.0514459929 * bl),
            cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl),
            cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl)
        )
        l = 0.2104542553 * lms.0 + 0.793617785 * lms.1 - 0.0040720468 * lms.2
        a = 1.9779984951 * lms.0 - 2.428592205 * lms.1 + 0.4505937099 * lms.2
        b = 0.0259040371 * lms.0 + 0.7827717662 * lms.1 - 0.808675766 * lms.2
    }

    func distance(to other: OKLab) -> Double {
        ((l - other.l) * (l - other.l) + (a - other.a) * (a - other.a) + (b - other.b) * (b - other.b)).squareRoot()
    }
}
