import CoreGraphics
import Foundation
import Observation
import SwiftUI

/// The window's background, an app setting on this Mac (Settings' Appearance tab, 2026-11-20): the design's wallpaper,
/// or a picture the person chose, copied into the app's container at once (`BackgroundPicture`); and "Soften the
/// background", a slight blur and dim, off by default. The picture is never sent anywhere. The words and icons drawn
/// straight on it take their tone from it (`tone`, `WallpaperTone`), softened or not.
@MainActor
@Observable
final class Background {
    /// The app's one background, which the window, onboarding's pages and the tone read.
    static let shared = Background()

    /// Softened: the blur's radius in the window, in points.
    static let blurRadius: CGFloat = 10
    /// Softened: black laid over it, so its light parts read a little darker.
    static let dim: Double = 0.12
    /// Where "Soften the background" is remembered.
    static let softenedKey = "UsualMailBackgroundSoftened"

    /// Where the copy is kept: the app's Application Support (its container's, sandboxed).
    nonisolated static var defaultDirectory: URL {
        URL.applicationSupportDirectory.appending(path: "UsualMail/Background", directoryHint: .isDirectory)
    }

    /// The person's picture, or nil for the design's wallpaper.
    private(set) var picture: CGImage?
    private(set) var softened: Bool
    /// Why the last picture chosen wasn't taken, in words for its row; nil once one is, or the default is back.
    private(set) var problem: String?
    /// True while a chosen picture is being decoded and kept.
    private(set) var isImporting = false
    /// How light the background is under each part of the window, softening included. Nil only when neither the
    /// picture nor the wallpaper can be read, and words then stay dark.
    private(set) var tone: WallpaperTone.Tone?

    @ObservationIgnored let directory: URL
    @ObservationIgnored private let defaults: UserDefaults
    /// The picture's brightness, worked out once per picture.
    @ObservationIgnored private var pictureBrightness: Brightness?

    init(directory: URL = Background.defaultDirectory, defaults: UserDefaults = .standard) {
        self.directory = directory
        self.defaults = defaults
        picture = BackgroundPicture.stored(in: directory)
        softened = defaults.bool(forKey: Self.softenedKey)
        pictureBrightness = picture.flatMap { Self.brightness(of: $0) }
        tone = makeTone()
    }

    /// Whether the person chose a picture.
    var isCustom: Bool { picture != nil }

    /// Takes the picture the system's picker granted: reads it at once, while the sandbox lets the app, then decodes and
    /// keeps it. A file that can't be read or decoded leaves the background as it was, with the reason in `problem`.
    func choose(fileAt url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        let data = try? Data(contentsOf: url)
        if scoped { url.stopAccessingSecurityScopedResource() }
        guard let data else {
            problem = BackgroundPicture.Refusal.unreadable.words
            return
        }
        await choose(data)
    }

    /// Decodes and keeps a picture, off the main thread; shows it once kept.
    func choose(_ data: Data) async {
        isImporting = true
        defer { isImporting = false }
        let directory = self.directory
        let result = await Task.detached(priority: .userInitiated) {
            BackgroundPicture.importing(data, into: directory)
        }.value
        switch result {
        case .success(let still):
            picture = still
            pictureBrightness = Self.brightness(of: still)
            problem = nil
            tone = makeTone()
        case .failure(let refusal):
            problem = refusal.words
        }
    }

    /// "Use the default": the design's wallpaper again; the copy is removed.
    func useDefault() {
        BackgroundPicture.removeStored(in: directory)
        picture = nil
        pictureBrightness = nil
        problem = nil
        tone = makeTone()
    }

    /// "Soften the background".
    func setSoftened(_ on: Bool) {
        guard on != softened else { return }
        softened = on
        defaults.set(on, forKey: Self.softenedKey)
        tone = makeTone()
    }

    private func makeTone() -> WallpaperTone.Tone? {
        guard let brightness = pictureBrightness ?? WallpaperTone.wallpaper else { return nil }
        return WallpaperTone.Tone(
            brightness: brightness, dim: softened ? Float(Self.dim) : 0, blur: softened ? Self.blurRadius : 0)
    }

    nonisolated private static func brightness(of image: CGImage) -> Brightness? {
        Brightness(cgImage: image, size: CGSize(width: image.width, height: image.height))
    }
}

/// The background as drawn: the picture or the wallpaper filling the space, softened when asked. `scale` shrinks the
/// blur for a small preview, so it looks as the window does.
struct BackgroundImage: View {
    let background: Background
    var scale: CGFloat = 1

    var body: some View {
        image
            .resizable()
            .aspectRatio(contentMode: .fill)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .blur(radius: background.softened ? Background.blurRadius * scale : 0, opaque: true)
            .overlay(Color.black.opacity(background.softened ? Background.dim : 0))
            .clipped()
            .accessibilityHidden(true)
    }

    private var image: Image {
        if let picture = background.picture {
            Image(decorative: picture, scale: 1)
        } else {
            Image("wallpaper", bundle: Icon.bundle)
        }
    }
}

extension EnvironmentValues {
    /// The window's size, for Settings' preview of the background, drawn in the window's shape.
    @Entry var windowSize: CGSize = .zero
}
