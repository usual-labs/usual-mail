import CoreGraphics
import Foundation
import Testing

@testable import UsualMailUI

/// Words drawn straight on the wallpaper take their colour from how light it is under them.
struct WallpaperToneTests {
    /// A 10 × 10 picture, white in its top half and black in its bottom half.
    private func halves() throws -> CGImage {
        let context = try #require(
            CGContext(
                data: nil, width: 10, height: 10, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
        // Core Graphics counts up from the bottom: y 5 to 10 is the top half.
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 5, width: 10, height: 5))
        return try #require(context.makeImage())
    }

    @Test func brightnessIsReadFromTheTopDown() throws {
        let brightness = try #require(
            Brightness(cgImage: try halves(), size: CGSize(width: 10, height: 10), columns: 10))
        #expect(brightness.average(in: CGRect(x: 0, y: 0, width: 1, height: 0.5)) > 0.9)
        #expect(brightness.average(in: CGRect(x: 0, y: 0.5, width: 1, height: 0.5)) < 0.1)
        // Outside the picture it is clamped to the nearest edge.
        #expect(brightness.average(in: CGRect(x: 0.9, y: 1.2, width: 0.3, height: 0.3)) < 0.1)
    }

    @Test func aWindowCropsTheWallpaperItFills() {
        // A 2:1 picture in a square window: scaled to the window's height, its sides cut off equally.
        let unit = WallpaperTone.unitRect(
            for: CGRect(x: 0, y: 0, width: 100, height: 100), in: CGSize(width: 100, height: 100),
            imageSize: CGSize(width: 200, height: 100))
        #expect(abs(unit.minX - 0.25) < 0.001 && abs(unit.width - 0.5) < 0.001)
        #expect(abs(unit.minY) < 0.001 && abs(unit.height - 1) < 0.001)
    }

    @MainActor @Test func theDesignsWallpaperIsDarkInItsBottomRightCorner() {
        // The green hills: light words there.
        let window = CGSize(width: 1512, height: 982)
        #expect(!WallpaperTone.isLight(under: CGRect(x: 1300, y: 940, width: 190, height: 20), in: window))
        // The sky at the top: dark words.
        #expect(WallpaperTone.isLight(under: CGRect(x: 1300, y: 20, width: 190, height: 20), in: window))
    }
}
