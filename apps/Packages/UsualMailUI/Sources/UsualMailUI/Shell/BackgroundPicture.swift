import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A picture the person chose for the window's background, as the app keeps it: decoded once, its first frame only
/// (an animated picture stands still), turned the way its camera meant, at most 3840 pixels on its long side, and
/// written into the app's own container (JPEG, or PNG when it has transparency). Nothing here leaves the Mac.
enum BackgroundPicture {
    /// The long side's most pixels: a 4K screen's width, the bundled wallpaper's.
    static let longestSide = 3840
    /// The copy's name in its folder, before its extension.
    static let name = "background"

    /// Why a picture wasn't taken, in words for its row. The background stays as it was.
    enum Refusal: Error, Equatable, Sendable {
        case undecodable
        case unreadable
        case unwritable

        var words: String {
            switch self {
            case .undecodable: "This file isn't a picture Usual Mail can read. The background is unchanged."
            case .unreadable: "This file couldn't be opened. The background is unchanged."
            case .unwritable: "The picture couldn't be kept on \(SettingsWords.device). The background is unchanged."
            }
        }
    }

    /// The first frame of the picture in `data`, at most `longestSide` pixels on its long side (a smaller picture keeps
    /// its size), turned as its orientation says. Nil when it can't be decoded.
    static func still(from data: Data, longestSide: Int = longestSide) -> CGImage? {
        guard
            let source = CGImageSourceCreateWithData(
                data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
            CGImageSourceGetCount(source) > 0,
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? Int,
            let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: min(longestSide, max(width, height)),
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Decodes `data` and keeps the copy in `directory`, in place of any earlier one. Returns the picture to show.
    static func importing(_ data: Data, into directory: URL) -> Result<CGImage, Refusal> {
        guard let still = still(from: data) else { return .failure(.undecodable) }
        guard let (encoded, type) = encoded(still) else { return .failure(.unwritable) }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appending(path: "\(name).\(type.preferredFilenameExtension ?? "img")")
            try encoded.write(to: file, options: .atomic)
            for other in storedFiles(in: directory) where other.lastPathComponent != file.lastPathComponent {
                try? FileManager.default.removeItem(at: other)
            }
            return .success(still)
        } catch {
            return .failure(.unwritable)
        }
    }

    /// The kept copy, if there is one and it still decodes.
    static func stored(in directory: URL) -> CGImage? {
        for file in storedFiles(in: directory) {
            if let data = try? Data(contentsOf: file), let image = still(from: data) { return image }
        }
        return nil
    }

    /// Removes the kept copy.
    static func removeStored(in directory: URL) {
        for file in storedFiles(in: directory) { try? FileManager.default.removeItem(at: file) }
    }

    /// The copy as a file: JPEG at 0.9 for an opaque picture, PNG when it has transparency.
    static func encoded(_ image: CGImage) -> (Data, UTType)? {
        let type: UTType = hasAlpha(image) ? .png : .jpeg
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
            return nil
        }
        let options = [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary
        CGImageDestinationAddImage(destination, image, type == .jpeg ? options : nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return (data as Data, type)
    }

    private static func hasAlpha(_ image: CGImage) -> Bool {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast: false
        default: true
        }
    }

    private static func storedFiles(in directory: URL) -> [URL] {
        ["jpeg", "png"].compactMap { ext in
            let file = directory.appending(path: "\(name).\(ext)")
            return FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) ? file : nil
        }
    }
}
