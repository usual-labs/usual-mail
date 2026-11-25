import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import UsualMailUI

/// Settings' Appearance tab: a chosen picture is kept downsampled, its first frame only, a file that isn't a picture is
/// refused with words, "Use the default" brings the wallpaper back, softening is remembered, and the words and icons
/// drawn on the background take its tone.
@MainActor
struct AppearanceTests {
    /// A background over a new folder and a new defaults domain, removed after.
    private final class Place {
        let directory = FileManager.default.temporaryDirectory.appending(path: "Background-\(UUID().uuidString)")
        let suite = "UsualMailTests-\(UUID().uuidString)"
        var defaults: UserDefaults { UserDefaults(suiteName: suite)! }

        deinit {
            try? FileManager.default.removeItem(at: directory)
            UserDefaults().removePersistentDomain(forName: suite)
        }
    }

    // MARK: Pictures

    /// A `width` × `height` picture, `gray` all over (0 black, 1 white), or a checkerboard of `square`-pixel squares.
    static func picture(width: Int, height: Int, gray: CGFloat = 0.5, checker square: Int? = nil) throws -> CGImage {
        let context = try #require(
            CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(gray: gray, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        if let square {
            context.setFillColor(gray: 1, alpha: 1)
            for row in 0..<(height / square + 1) {
                for column in 0..<(width / square + 1) where (row + column).isMultiple(of: 2) {
                    context.fill(CGRect(x: column * square, y: row * square, width: square, height: square))
                }
            }
        }
        return try #require(context.makeImage())
    }

    static func png(_ images: [CGImage], type: UTType = .png) throws -> Data {
        let data = NSMutableData()
        let destination = try #require(
            CGImageDestinationCreateWithData(data, type.identifier as CFString, images.count, nil))
        for image in images { CGImageDestinationAddImage(destination, image, nil) }
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }

    /// The red, green and blue of the picture's middle pixel, 0 to 255.
    static func middle(_ image: CGImage) throws -> [UInt8] {
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try #require(
            CGContext(
                data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.draw(
            image, in: CGRect(x: -image.width / 2, y: -image.height / 2, width: image.width, height: image.height))
        return Array(pixel.prefix(3))
    }

    @Test func aLargePictureIsKeptAt3840OnItsLongSideASmallOneAsItIs() throws {
        let large = try Self.png([Self.picture(width: 5000, height: 1000)])
        let still = try #require(BackgroundPicture.still(from: large))
        #expect(still.width == 3840 && still.height == 768)
        let tall = try #require(BackgroundPicture.still(from: Self.png([Self.picture(width: 600, height: 4500)])))
        #expect(tall.height == 3840 && tall.width == 512)
        let small = try #require(BackgroundPicture.still(from: Self.png([Self.picture(width: 300, height: 200)])))
        #expect(small.width == 300 && small.height == 200)
    }

    @Test func anAnimatedPictureStandsStillOnItsFirstFrame() throws {
        let red = try Self.solid(red: 255, green: 0, blue: 0)
        let blue = try Self.solid(red: 0, green: 0, blue: 255)
        let gif = try Self.png([red, blue], type: .gif)
        let source = try #require(CGImageSourceCreateWithData(gif as CFData, nil))
        #expect(CGImageSourceGetCount(source) == 2)
        let still = try #require(BackgroundPicture.still(from: gif))
        let colour = try Self.middle(still)
        #expect(colour[0] > 200 && colour[2] < 60, "Expected the first frame, red; got \(colour)")
    }

    private static func solid(red: CGFloat, green: CGFloat, blue: CGFloat) throws -> CGImage {
        let context = try #require(
            CGContext(
                data: nil, width: 40, height: 40, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(red: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 40, height: 40))
        return try #require(context.makeImage())
    }

    // MARK: The setting

    @Test func aChosenPictureIsKeptAndShownAndTheDefaultBringsTheWallpaperBack() async throws {
        let place = Place()
        let background = Background(directory: place.directory, defaults: place.defaults)
        #expect(!background.isCustom && background.problem == nil)
        await background.choose(try Self.png([Self.picture(width: 5000, height: 2000, gray: 0.9)]))
        #expect(background.isCustom && background.picture?.width == 3840 && background.problem == nil)
        // Kept in the app's folder, so the next launch finds it.
        let files = try FileManager.default.contentsOfDirectory(atPath: place.directory.path(percentEncoded: false))
        #expect(files == ["background.jpeg"])
        #expect(Background(directory: place.directory, defaults: place.defaults).picture?.width == 3840)
        // "Use the default": the wallpaper, its copy gone, the tone the wallpaper's again.
        background.useDefault()
        #expect(!background.isCustom && background.picture == nil)
        #expect(
            try FileManager.default.contentsOfDirectory(atPath: place.directory.path(percentEncoded: false)).isEmpty)
        let window = CGSize(width: 1512, height: 982)
        let corner = CGRect(x: 1300, y: 940, width: 190, height: 20)
        let wallpaper = try #require(WallpaperTone.wallpaper)
        let tone = try #require(background.tone)
        #expect(
            tone.average(under: corner, in: window)
                == WallpaperTone.Tone(brightness: wallpaper).average(under: corner, in: window))
    }

    @Test func aFileThatIsntAPictureIsRefusedWithWordsAndChangesNothing() async throws {
        let place = Place()
        let background = Background(directory: place.directory, defaults: place.defaults)
        await background.choose(Data("Not a picture at all".utf8))
        #expect(background.problem == "This file isn't a picture Usual Mail can read. The background is unchanged.")
        #expect(!background.isCustom)
        // Over a picture already chosen: that picture stays.
        await background.choose(try Self.png([Self.picture(width: 400, height: 300)]))
        await background.choose(Data([0xFF, 0xD8, 0xFF, 0x00]))
        #expect(background.picture?.width == 400 && background.problem != nil)
        // A good picture afterwards clears the words.
        await background.choose(try Self.png([Self.picture(width: 500, height: 300)]))
        #expect(background.picture?.width == 500 && background.problem == nil)
    }

    @Test func softeningIsOffAtFirstAndRemembered() {
        let place = Place()
        let background = Background(directory: place.directory, defaults: place.defaults)
        #expect(!background.softened)
        #expect(background.tone?.dim == 0 && background.tone?.blur == 0)
        background.setSoftened(true)
        #expect(background.softened && place.defaults.bool(forKey: Background.softenedKey))
        #expect(background.tone?.dim == Float(Background.dim) && background.tone?.blur == Background.blurRadius)
        #expect(Background(directory: place.directory, defaults: place.defaults).softened)
        background.setSoftened(false)
        #expect(!Background(directory: place.directory, defaults: place.defaults).softened)
    }

    // MARK: Readability

    /// Where the rail's settings button, a rail label and the corner note sit in the design's window.
    let window = CGSize(width: 1512, height: 982)
    let railButton = CGRect(x: 96, y: 900, width: 32, height: 32)
    let railLabel = CGRect(x: 134, y: 100, width: 120, height: 32)
    let cornerNote = CGRect(x: 1300, y: 940, width: 190, height: 20)

    /// WCAG's contrast between two greys given as sRGB values, 1 to 21.
    static func contrast(_ a: Double, _ b: Double) -> Double {
        func luminance(_ value: Double) -> Double {
            value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    /// The ink a part takes over this tone: the icons' #141B34 (about 0.1 grey) on light, white at 92% on dark.
    private func ink(_ tone: WallpaperTone.Tone, under rect: CGRect) -> Double {
        tone.isLight(under: rect, in: window) ? 0.1 : 0.92 + 0.08 * Double(tone.average(under: rect, in: window))
    }

    @Test func brightDarkAndBusyPicturesKeepTheRailAndTheCornerNoteReadable() async throws {
        let place = Place()
        let background = Background(directory: place.directory, defaults: place.defaults)
        let parts = [railButton, railLabel, cornerNote]

        // Very bright: dark icons and words everywhere.
        await background.choose(try Self.png([Self.picture(width: 1600, height: 1000, gray: 0.97)]))
        var tone = try #require(background.tone)
        for part in parts {
            #expect(tone.isLight(under: part, in: window) && !tone.isBusy(under: part, in: window))
            #expect(Self.contrast(ink(tone, under: part), Double(tone.average(under: part, in: window))) > 7)
        }

        // Very dark: white icons and words everywhere.
        await background.choose(try Self.png([Self.picture(width: 1600, height: 1000, gray: 0.03)]))
        tone = try #require(background.tone)
        for part in parts {
            #expect(!tone.isLight(under: part, in: window))
            #expect(Self.contrast(ink(tone, under: part), Double(tone.average(under: part, in: window))) > 7)
        }

        // Busy: black and white squares about as big as a word's letters run together (16 pixels in a 1600-wide
        // picture, about 16 points in the window). Whichever ink a part takes, it keeps more than the 3:1 icons need
        // against what lies under it on average (the rail's glass evens that out); the worst case is white just under
        // the 0.55 line, about 3.1:1. The corner note's words have no glass: it is busy there, so its halo is drawn
        // stronger (`ActivityNote`).
        await background.choose(try Self.png([Self.picture(width: 1600, height: 1000, gray: 0, checker: 16)]))
        tone = try #require(background.tone)
        for part in parts {
            let average = Double(tone.average(under: part, in: window))
            #expect(Self.contrast(ink(tone, under: part), average) > 3, "average \(average)")
        }
        #expect(abs(tone.average(under: cornerNote, in: window) - 0.5) < 0.1)
        #expect(!tone.isLight(under: cornerNote, in: window) && tone.isBusy(under: cornerNote, in: window))
        #expect(Self.contrast(0.92 + 0.08 * 0.549, 0.549) > 3 && Self.contrast(0.1, 0.551) > 5)

        // The design's wallpaper isn't busy under the corner note, so its look there is as before.
        background.useDefault()
        #expect(background.tone?.isBusy(under: cornerNote, in: window) == false)
    }

    @Test func softeningDimsTheToneSoAMidGreyCountsAsDark() async throws {
        let place = Place()
        let background = Background(directory: place.directory, defaults: place.defaults)
        await background.choose(try Self.png([Self.picture(width: 800, height: 500, gray: 0.6)]))
        #expect(background.tone?.isLight(under: railButton, in: window) == true)
        background.setSoftened(true)
        #expect(background.tone?.isLight(under: railButton, in: window) == false)
        // A bright picture stays light softened, so its icons stay dark.
        await background.choose(try Self.png([Self.picture(width: 800, height: 500, gray: 0.95)]))
        #expect(background.tone?.isLight(under: railButton, in: window) == true)
    }
}
