import AppKit
import SwiftUI

/// One pixel's colour, 0 to 255 a channel.
struct Pixel {
    let red: Int
    let green: Int
    let blue: Int

    /// Its luminance in levels, 0 to 255 (Rec. 709's weights).
    var luma: Double {
        0.2126 * Double(red) + 0.7152 * Double(green) + 0.0722 * Double(blue)
    }

    /// Its relative luminance, 0 to 1, as contrast ratios take it (WCAG).
    var luminance: Double {
        func linear(_ channel: Int) -> Double {
            let value = Double(channel) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }
}

/// A view drawn offscreen at twice its size, read pixel by pixel, in points from its top left. Glass is drawn flat, in
/// its tint, without the lens.
@MainActor
struct Picture {
    static let scale: CGFloat = 2
    private let width: Int
    private let height: Int
    private let data: [UInt8]

    struct NotDrawn: Error {}

    init(of view: some View) throws {
        // The renderer draws glass (flat, in its tint, without the lens) only once SwiftUI has set up its AppKit
        // hosting in this process; before that, none at all. A hosting view that is never shown is enough.
        _ = NSHostingView(rootView: EmptyView())
        let renderer = ImageRenderer(content: view)
        renderer.scale = Self.scale
        guard let image = renderer.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else {
            throw NotDrawn()
        }
        let width = image.width
        let height = image.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = data.withUnsafeMutableBytes { bytes in
            guard
                let context = CGContext(
                    data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
                    bytesPerRow: width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { throw NotDrawn() }
        self.width = width
        self.height = height
        self.data = data
    }

    var bounds: CGRect {
        CGRect(x: 0, y: 0, width: CGFloat(width) / Self.scale, height: CGFloat(height) / Self.scale)
    }

    /// How many pixels in `rect`, and `inside` a shape there, match.
    func count(
        in rect: CGRect, inside: (CGPoint) -> Bool = { _ in true }, where matches: (Pixel) -> Bool
    ) -> Int {
        pixels(in: rect, inside: inside).filter(matches).count
    }

    /// The pixels in `rect`, and `inside` a shape there, row by row.
    func pixels(in rect: CGRect, inside: (CGPoint) -> Bool = { _ in true }) -> [Pixel] {
        let pixels = rect.applying(CGAffineTransform(scaleX: Self.scale, y: Self.scale)).integral
        var found: [Pixel] = []
        for y in max(0, Int(pixels.minY))..<min(height, Int(pixels.maxY)) {
            for x in max(0, Int(pixels.minX))..<min(width, Int(pixels.maxX)) {
                let point = CGPoint(x: (CGFloat(x) + 0.5) / Self.scale, y: (CGFloat(y) + 0.5) / Self.scale)
                guard inside(point) else { continue }
                let i = (y * width + x) * 4
                found.append(Pixel(red: Int(data[i]), green: Int(data[i + 1]), blue: Int(data[i + 2])))
            }
        }
        return found
    }
}
