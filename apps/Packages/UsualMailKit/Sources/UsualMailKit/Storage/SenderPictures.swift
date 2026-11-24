import CoreGraphics
import Foundation
import ImageIO

/// Sender pictures (docs/contract-avatars.md), loaded through the person's server with the device's token and kept on
/// this device by their id, which changes whenever the picture does:
///
/// - **In memory**, the decoded still of each picture shown, so a row scrolled back to shows it at once. An `NSCache`,
///   which a critical memory-pressure event on the Mac empties, and which then keeps no new stills until the pressure
///   is back to normal (a warning drops nothing, but leaves a cache still empty at the time keeping none either): a
///   row then fades its picture in again, from disk, with no request.
/// - **On disk**, the server's bytes under `directory`, one file named by the id alone, kept for good (the system may
///   clear a cache folder when it needs room; the picture is then fetched again).
/// - **Not there**: an id the server answered `not_found` for, or whose bytes aren't a picture this app draws (not
///   PNG, JPEG or WebP, not the type the server named, undecodable, or over `SenderPictureStill.largestSide`), is
///   remembered in memory only and not asked for again until the id changes or the app starts again.
/// - **Offline or a server error**: initials, and the next appearance asks again.
///
/// Loads of the same id at the same time make one request. Only an id of the server's own shape
/// (`SenderPicture.isPictureID`) is ever asked for or written. Nil always means initials.
@MainActor
public final class SenderPictures {
    /// Fetches a picture's bytes and type by id: `APIClient.avatar(id:)`, or a stand-in in tests.
    public typealias Loader = @Sendable (String) async throws -> AttachmentData

    /// The app's own caches folder (its container's, in the sandbox), `UsualMail/Avatars`.
    public nonisolated static var defaultDirectory: URL {
        URL.cachesDirectory.appending(path: "UsualMail/Avatars", directoryHint: .isDirectory)
    }

    private let directory: URL
    private let loader: Loader
    private let stills: NSCache<NSString, CGImage>
    private var notThere: Set<String> = []
    private var loading: [String: Task<CGImage?, Never>] = [:]

    public convenience init(directory: URL = SenderPictures.defaultDirectory, loader: @escaping Loader) {
        self.init(directory: directory, stills: NSCache(), loader: loader)
    }

    /// Keeps stills in memory in `stills`: the app's own `NSCache`, or in tests a stand-in that keeps every still or
    /// none, since what a real one keeps depends on the whole Mac (a critical memory-pressure event empties it).
    init(directory: URL, stills: NSCache<NSString, CGImage>, loader: @escaping Loader) {
        self.directory = directory
        self.loader = loader
        self.stills = stills
        // A still is at most 64 × 64 pixels, about 16 KB: a few hundred are a few megabytes.
        stills.countLimit = 400
    }

    /// Loads through `client`, the store's own, with the device's token.
    public convenience init(client: APIClient, directory: URL = SenderPictures.defaultDirectory) {
        self.init(directory: directory) { try await client.avatar(id: $0) }
    }

    /// The still already in memory for this picture, without waiting: a view shows it at once rather than fading it
    /// in again.
    public func cached(_ picture: SenderPicture) -> CGImage? {
        picture.id.flatMap { stills.object(forKey: $0 as NSString) }
    }

    /// The still for this picture, from memory, from disk, or from the server; nil means initials.
    public func still(for picture: SenderPicture) async -> CGImage? {
        guard let id = picture.id else { return nil }
        if let still = stills.object(forKey: id as NSString) { return still }
        if notThere.contains(id) { return nil }
        if let running = loading[id] { return await running.value }
        let task = Task { await load(id) }
        loading[id] = task
        return await task.value
    }

    /// Whether a failed load means the server doesn't have the picture (`not_found`), rather than that it couldn't be
    /// asked or failed for a while.
    public nonisolated static func isGone(_ error: any Error) -> Bool {
        guard case .server(let code, _, let status, _)? = error as? APIError else { return false }
        return status == 404 || code == .notFound
    }

    private func load(_ id: String) async -> CGImage? {
        defer { loading[id] = nil }
        let file = directory.appending(path: id, directoryHint: .notDirectory)
        if let still = await Self.read(file) {
            stills.setObject(still, forKey: id as NSString)
            return still
        }
        let answer: AttachmentData
        do {
            answer = try await loader(id)
        } catch {
            if Self.isGone(error) { notThere.insert(id) }
            return nil
        }
        guard let still = await Self.still(of: answer) else {
            notThere.insert(id)
            return nil
        }
        stills.setObject(still, forKey: id as NSString)
        await Self.keep(answer.data, at: file, in: directory)
        return still
    }

    /// The still of what was kept on disk; a file that isn't a picture this app draws is removed, so the server is
    /// asked again.
    @concurrent private nonisolated static func read(_ file: URL) async -> CGImage? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        if let still = SenderPictureStill.make(from: data) { return still }
        try? FileManager.default.removeItem(at: file)
        return nil
    }

    @concurrent private nonisolated static func still(of answer: AttachmentData) async -> CGImage? {
        guard let type = answer.mimeType else { return nil }
        return SenderPictureStill.make(from: answer.data, type: type)
    }

    /// Writes the server's bytes as they came; a failure only means the next launch fetches them again.
    @concurrent private nonisolated static func keep(_ data: Data, at file: URL, in directory: URL) async {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
}

/// Turns a sender picture's bytes into the small still a 16-point avatar draws, or refuses them.
public enum SenderPictureStill {
    /// The types the picture route serves (core's `AVATAR_TYPES`), each with the type ImageIO must find in the bytes.
    public static let types: [String: String] = [
        "image/png": "public.png", "image/jpeg": "public.jpeg", "image/webp": "org.webmproject.webp",
    ]
    /// A picture wider or taller than this, read from its header without decoding it, is refused.
    public static let largestSide = 4096
    /// The still's longer side: 16 points at up to 4× with room to spare.
    public static let stillSide = 64

    /// A still of the picture's first frame, at most `stillSide` pixels a side, its orientation applied. Nil when the
    /// bytes aren't PNG, JPEG or WebP, aren't the type `type` (a Content-Type) names, can't be decoded, or are over
    /// `largestSide` either way. The full-size picture is never decoded.
    public static func make(from data: Data, type: String? = nil) -> CGImage? {
        let allowed: Set<String>
        if let type {
            let named = type.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            guard let found = named.flatMap({ types[$0] }) else { return nil }
            allowed = [found]
        } else {
            allowed = Set(types.values)
        }
        let noCache = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, noCache),
            let found = CGImageSourceGetType(source) as String?, allowed.contains(found),
            CGImageSourceGetCount(source) > 0, CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, noCache) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? Int,
            let height = properties[kCGImagePropertyPixelHeight] as? Int,
            (1...largestSide).contains(width), (1...largestSide).contains(height)
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: stillSide,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}
