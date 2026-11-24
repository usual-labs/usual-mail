import CoreGraphics
import SwiftUI

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// How light the background is under a part of the window, for words drawn straight on it: dark on a light background,
/// light on a dark one (owner's direction of 2026-11-18). Reads a small copy of the background (the design's wallpaper
/// or the person's picture, `Background`), made once per picture; the background fills the window, so which part of it
/// lies under a rect depends on the window's size. Softening dims it and blurs it, and the tone counts both.
enum WallpaperTone {
    /// The design's wallpaper, small. Nil if it can't be read, when words stay dark.
    @MainActor static let wallpaper: Brightness? = {
        #if os(macOS)
            Brightness(image: Icon.bundle.image(forResource: "wallpaper"))
        #else
            Brightness(image: UIImage(named: "wallpaper", in: Icon.bundle, with: nil))
        #endif
    }()

    /// Above this average brightness (0 black, 1 white) a background counts as light.
    static let lightAbove: Float = 0.55
    /// Above this spread of brightness (its standard deviation) a background counts as busy: light and dark patches
    /// the size of a word side by side, so neither ink reads on all of it without a halo.
    static let busyAbove: Float = 0.2

    /// How light a background is, as drawn: its brightness, darkened by the dim laid over it, and averaged over the blur's
    /// reach.
    struct Tone: Sendable {
        let brightness: Brightness
        /// The black laid over it, 0 to 1.
        var dim: Float = 0
        /// The blur's radius in window points.
        var blur: CGFloat = 0

        /// The average brightness under `rect` (window coordinates, from the top left), as the window shows it.
        func average(under rect: CGRect, in window: CGSize) -> Float {
            let reach = rect.insetBy(dx: -blur, dy: -blur)
            let unit = WallpaperTone.unitRect(for: reach, in: window, imageSize: brightness.size)
            return brightness.average(in: unit) * (1 - dim)
        }

        func isLight(under rect: CGRect, in window: CGSize) -> Bool {
            average(under: rect, in: window) > WallpaperTone.lightAbove
        }

        /// Whether the background under `rect` is busy (`busyAbove`), as the window shows it.
        func isBusy(under rect: CGRect, in window: CGSize) -> Bool {
            let reach = rect.insetBy(dx: -blur, dy: -blur)
            let unit = WallpaperTone.unitRect(for: reach, in: window, imageSize: brightness.size)
            return brightness.spread(in: unit) * (1 - dim) > WallpaperTone.busyAbove
        }
    }

    /// True when the background under `rect` (window coordinates, from the top left) is light.
    @MainActor
    static func isLight(under rect: CGRect, in window: CGSize) -> Bool {
        Background.shared.tone?.isLight(under: rect, in: window) ?? true
    }

    /// True when the background under `rect` is busy.
    @MainActor
    static func isBusy(under rect: CGRect, in window: CGSize) -> Bool {
        Background.shared.tone?.isBusy(under: rect, in: window) ?? false
    }

    /// Where `rect` of a window falls on an image that fills it (`aspectRatio(contentMode: .fill)`, centred), in the
    /// image's unit square from its top left.
    static func unitRect(for rect: CGRect, in window: CGSize, imageSize: CGSize) -> CGRect {
        guard window.width > 0, window.height > 0, imageSize.width > 0, imageSize.height > 0 else { return .zero }
        let scale = max(window.width / imageSize.width, window.height / imageSize.height)
        let shown = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        let x = (shown.width - window.width) / 2
        let y = (shown.height - window.height) / 2
        return CGRect(
            x: (rect.minX + x) / shown.width, y: (rect.minY + y) / shown.height,
            width: rect.width / shown.width, height: rect.height / shown.height)
    }
}

/// An image's brightness, from a small grey copy of it.
struct Brightness: Sendable {
    /// The original image's size, for mapping onto the window.
    let size: CGSize
    let columns: Int
    let rows: Int
    /// Row by row from the top, 0 to 1.
    let values: [Float]

    #if os(macOS)
        init?(image: NSImage?, columns: Int = 160) {
            guard let image, let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                return nil
            }
            self.init(cgImage: cgImage, size: image.size, columns: columns)
        }
    #else
        init?(image: UIImage?, columns: Int = 160) {
            guard let image, let cgImage = image.cgImage else { return nil }
            self.init(cgImage: cgImage, size: image.size, columns: columns)
        }
    #endif

    init?(cgImage: CGImage, size: CGSize, columns: Int = 160) {
        guard cgImage.width > 0, cgImage.height > 0 else { return nil }
        let rows = max(1, Int((Double(columns) * Double(cgImage.height) / Double(cgImage.width)).rounded()))
        var pixels = [UInt8](repeating: 0, count: columns * rows)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard
                let context = CGContext(
                    data: buffer.baseAddress, width: columns, height: rows, bitsPerComponent: 8, bytesPerRow: columns,
                    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
            else { return false }
            context.interpolationQuality = .medium
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: columns, height: rows))
            return true
        }
        guard drawn else { return nil }
        self.size = size
        self.columns = columns
        self.rows = rows
        // A bitmap context's memory runs from the top row down.
        values = pixels.map { Float($0) / 255 }
    }

    /// The average brightness in `unit`, a rect in the image's unit square from its top left; clamped to the image.
    func average(in unit: CGRect) -> Float {
        let cells = cells(in: unit)
        return cells.reduce(0, +) / Float(cells.count)
    }

    /// How far the brightness in `unit` strays from its average: its standard deviation, 0 for an even patch, 0.5 for
    /// black and white half and half.
    func spread(in unit: CGRect) -> Float {
        let cells = cells(in: unit)
        let mean = cells.reduce(0, +) / Float(cells.count)
        let variance = cells.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Float(cells.count)
        return variance.squareRoot()
    }

    /// The small copy's values under `unit`, at least one.
    private func cells(in unit: CGRect) -> [Float] {
        let left = min(max(Int((unit.minX * CGFloat(columns)).rounded(.down)), 0), columns - 1)
        let right = min(max(Int((unit.maxX * CGFloat(columns)).rounded(.up)), left + 1), columns)
        let top = min(max(Int((unit.minY * CGFloat(rows)).rounded(.down)), 0), rows - 1)
        let bottom = min(max(Int((unit.maxY * CGFloat(rows)).rounded(.up)), top + 1), rows)
        var cells: [Float] = []
        cells.reserveCapacity((bottom - top) * (right - left))
        for row in top..<bottom {
            cells.append(contentsOf: values[(row * columns + left)..<(row * columns + right)])
        }
        return cells
    }
}
