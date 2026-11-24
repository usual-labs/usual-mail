import CoreGraphics
import Foundation
import Testing

@testable import UsualMailKit

/// Sender pictures kept on this device (`SenderPictures`): loaded through the stand-in server, once per id, kept on
/// disk by id, a gone picture not asked for again, and anything that isn't a small PNG, JPEG or WebP refused.
@MainActor
struct SenderPicturesTests {
    /// The sample's `thr_4` picture, which the stand-in server draws.
    let weeklyBuild = SampleData.bundled.threads.first { $0.id == "thr_4" }!.avatar!
    let server = SampleServer()
    let directory = FileManager.default.temporaryDirectory.appending(
        path: "SenderPicturesTests-\(UUID().uuidString)", directoryHint: .isDirectory)

    /// With the app's own memory, an `NSCache`, unless a test gives `stills`. What an `NSCache` keeps depends on the
    /// whole Mac (a critical memory-pressure event empties it), so a test that says what is in memory gives
    /// `KeptStills` or `ForgottenStills`.
    private func pictures(stills: NSCache<NSString, CGImage>? = nil) -> SenderPictures {
        guard let stills else { return SenderPictures(client: server.client(), directory: directory) }
        let client = server.client()
        return SenderPictures(directory: directory, stills: stills) { try await client.avatar(id: $0) }
    }

    private func picture(_ id: String, fit: SenderPictureFit = .fill) -> SenderPicture {
        SenderPicture(picture: "/v1/avatars/\(id)", fit: fit, size: 64)
    }

    private func cleanUp() {
        try? FileManager.default.removeItem(at: directory)
    }

    @Test func aPictureIsAStillOfAtMost64Pixels() async throws {
        defer { cleanUp() }
        let still = try #require(await pictures().still(for: weeklyBuild))
        #expect(max(still.width, still.height) <= SenderPictureStill.stillSide)
        #expect(still.width > 0)
        // The bytes are kept under the id, and nothing else is written there.
        let id = try #require(weeklyBuild.id)
        let kept = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        #expect(kept == [id])
    }

    /// Starts two loads of `picture` that are both waiting inside `SenderPictures` before either is answered: both
    /// tasks run on the main actor in the order made, each up to its first wait, before the load the first one starts.
    private func twoLoadsAtOnce(
        _ pictures: SenderPictures, _ picture: SenderPicture
    ) async throws -> (CGImage?, CGImage?) {
        let id = try #require(picture.id)
        let gate = server.hold("GET /v1/avatars/\(id)")
        let first = Task { await pictures.still(for: picture) }
        let second = Task { await pictures.still(for: picture) }
        try await waitUntil("the picture is asked for") { server.avatarRequests(id) >= 1 }
        // A second request, were one made, is counted whenever it comes: both loads end before the count is read.
        await gate.open()
        return (await first.value, await second.value)
    }

    @Test func twoLoadsAtOnceMakeOneRequest() async throws {
        defer { cleanUp() }
        let id = try #require(weeklyBuild.id)
        let pictures = self.pictures(stills: KeptStills())
        let (a, b) = try await twoLoadsAtOnce(pictures, weeklyBuild)
        #expect(a != nil && b != nil)
        #expect(server.avatarRequests(id) == 1)
        // In memory now, at once, and asked for no more.
        #expect(pictures.cached(weeklyBuild) != nil)
        #expect(await pictures.still(for: weeklyBuild) != nil)
        #expect(server.avatarRequests(id) == 1)
    }

    /// A load that starts after the request went out, while it is still unanswered, waits for that request rather than
    /// making its own: the load in flight is forgotten only once it has ended.
    @Test func aLoadStartedWhileTheRequestIsOutJoinsIt() async throws {
        defer { cleanUp() }
        let id = try #require(weeklyBuild.id)
        let pictures = self.pictures(stills: KeptStills())
        let gate = server.hold("GET /v1/avatars/\(id)")
        let first = Task { await pictures.still(for: weeklyBuild) }
        try await waitUntil("the picture is asked for") { server.avatarRequests(id) >= 1 }
        // Queued on the main actor now, so it runs before the answer can come back there.
        let later = Task { await pictures.still(for: weeklyBuild) }
        await gate.open()
        let (a, b) = (await first.value, await later.value)
        #expect(a != nil && b != nil)
        #expect(server.avatarRequests(id) == 1)
    }

    /// A critical memory-pressure event empties the app's `NSCache`, which then keeps no new stills until the pressure
    /// is back to normal: still one request, and the picture again from disk.
    @Test func whenMemoryKeepsNothingTwoLoadsStillMakeOneRequestAndTheDiskServesTheNext() async throws {
        defer { cleanUp() }
        let id = try #require(weeklyBuild.id)
        let pictures = self.pictures(stills: ForgottenStills())
        let (a, b) = try await twoLoadsAtOnce(pictures, weeklyBuild)
        #expect(a != nil && b != nil)
        #expect(server.avatarRequests(id) == 1)
        // Initials until the view's own load brings the still, from disk.
        #expect(pictures.cached(weeklyBuild) == nil)
        #expect(await pictures.still(for: weeklyBuild) != nil)
        #expect(server.avatarRequests(id) == 1)
    }

    @Test func aNewInstanceReadsItBackFromDisk() async throws {
        defer { cleanUp() }
        let id = try #require(weeklyBuild.id)
        #expect(await pictures().still(for: weeklyBuild) != nil)
        let again = pictures(stills: KeptStills())
        #expect(again.cached(weeklyBuild) == nil)
        #expect(await again.still(for: weeklyBuild) != nil)
        #expect(server.avatarRequests(id) == 1)
        // What was read back from disk is in memory now.
        #expect(again.cached(weeklyBuild) != nil)
    }

    @Test func aDamagedFileOnDiskIsFetchedAgain() async throws {
        defer { cleanUp() }
        let id = try #require(weeklyBuild.id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not a picture".utf8).write(to: directory.appending(path: id))
        #expect(await pictures().still(for: weeklyBuild) != nil)
        #expect(server.avatarRequests(id) == 1)
        #expect(SenderPictureStill.make(from: try Data(contentsOf: directory.appending(path: id))) != nil)
    }

    @Test func aGonePictureIsNotAskedForAgainButANewIDIs() async throws {
        defer { cleanUp() }
        let gone = String(repeating: "a", count: 32)
        let pictures = self.pictures()
        #expect(await pictures.still(for: picture(gone)) == nil)
        #expect(await pictures.still(for: picture(gone, fit: .inset)) == nil)
        #expect(server.avatarRequests(gone) == 1)
        // The thread's picture changed: a new id is asked for.
        let next = String(repeating: "b", count: 32)
        server.answerAvatar(next, with: .picture(TestPicture.png(width: 16, height: 16), type: "image/png"))
        #expect(await pictures.still(for: picture(next)) != nil)
        #expect(server.avatarRequests(next) == 1)
        // A new start forgets what wasn't there.
        #expect(await self.pictures().still(for: picture(gone)) == nil)
        #expect(server.avatarRequests(gone) == 2)
    }

    @Test func aServerErrorOrNoConnectionIsTriedAgainNextTime() async throws {
        defer { cleanUp() }
        let id = try #require(weeklyBuild.id)
        let pictures = self.pictures()
        server.failOnce("GET /v1/avatars/\(id)", with: .error("internal", "Something broke", status: 500))
        #expect(await pictures.still(for: weeklyBuild) == nil)
        #expect(await pictures.still(for: weeklyBuild) != nil)
        #expect(server.avatarRequests(id) == 2)

        let offline = SenderPictures(directory: directory) { _ in throw APIError.unreachable("Offline") }
        let other = String(repeating: "c", count: 32)
        #expect(await offline.still(for: picture(other)) == nil)
    }

    /// Bytes the route must never serve, each with the type it came as: initials, and not asked for again.
    nonisolated static let refused: [(String, Data, String?)] = [
        ("PNG bytes called JPEG", TestPicture.png(width: 16, height: 16), "image/jpeg"),
        ("JPEG bytes called PNG", TestPicture.jpeg(width: 16, height: 16), "image/png"),
        ("a GIF's type", TestPicture.png(width: 16, height: 16), "image/gif"),
        ("SVG", Data(#"<svg xmlns="http://www.w3.org/2000/svg"/>"#.utf8), "image/svg+xml"),
        ("no type", TestPicture.png(width: 16, height: 16), nil),
        ("undecodable", Data("not a picture".utf8), "image/png"),
        ("a truncated PNG", TestPicture.png(width: 64, height: 64).prefix(40), "image/png"),
        ("too wide", TestPicture.png(width: 4097, height: 1), "image/png"),
        ("too tall", TestPicture.png(width: 1, height: 4097), "image/png"),
    ]

    @Test(arguments: refused)
    func whatIsNotASmallPictureMeansInitials(_ what: String, _ bytes: Data, _ type: String?) async throws {
        defer { cleanUp() }
        let id = String(repeating: "d", count: 32)
        var reply = StubReply.picture(bytes, type: type ?? "")
        if type == nil { reply.headers["Content-Type"] = nil }
        server.answerAvatar(id, with: reply)
        let pictures = self.pictures()
        #expect(await pictures.still(for: picture(id)) == nil, "\(what)")
        #expect(await pictures.still(for: picture(id)) == nil, "\(what)")
        #expect(server.avatarRequests(id) == 1, "\(what)")
        #expect(!FileManager.default.fileExists(atPath: directory.appending(path: id).path), "\(what)")
    }

    @Test func theLargestAllowedSideAndEachTypeAreDrawn() throws {
        let widest = TestPicture.png(width: 4096, height: 2)
        let wide = try #require(SenderPictureStill.make(from: widest, type: "image/png"))
        #expect(wide.width == SenderPictureStill.stillSide)
        #expect(SenderPictureStill.make(from: TestPicture.jpeg(width: 20, height: 20), type: "image/jpeg") != nil)
        // A type's parameters and case don't matter.
        #expect(SenderPictureStill.make(from: TestPicture.png(width: 8, height: 8), type: "Image/PNG; q=1") != nil)
        // From disk there is no type: any of the three.
        #expect(SenderPictureStill.make(from: TestPicture.jpeg(width: 20, height: 20)) != nil)
        #expect(Set(SenderPictureStill.types.keys) == ["image/png", "image/jpeg", "image/webp"])
    }

    @Test func aPathThatIsNotTheRouteIsNeverAskedFor() async throws {
        defer { cleanUp() }
        let pictures = self.pictures()
        let elsewhere = SenderPicture(
            picture: "https://brand.example/v1/avatars/\(String(repeating: "e", count: 32))", fit: .fill, size: 64)
        #expect(await pictures.still(for: elsewhere) == nil)
        #expect(pictures.cached(elsewhere) == nil)
        #expect(server.requests.isEmpty)
    }
}

/// Memory that keeps every still it is given, as an `NSCache` does while the Mac has room; a real one, after a critical
/// memory-pressure event, keeps none until the pressure is back to normal (known-issues.md), so a test that counts on
/// memory can't use one. Every way in to an `NSCache`'s contents is answered here; none reaches the real cache.
final class KeptStills: NSCache<NSString, CGImage>, @unchecked Sendable {
    private let lock = NSLock()
    private var kept: [String: CGImage] = [:]

    override func object(forKey key: NSString) -> CGImage? {
        lock.withLock { kept[key as String] }
    }

    override func setObject(_ still: CGImage, forKey key: NSString) {
        lock.withLock { kept[key as String] = still }
    }

    override func setObject(_ still: CGImage, forKey key: NSString, cost: Int) {
        setObject(still, forKey: key)
    }

    override func removeObject(forKey key: NSString) {
        lock.withLock { kept[key as String] = nil }
    }

    override func removeAllObjects() {
        lock.withLock { kept.removeAll() }
    }
}

/// Memory that keeps nothing, as an `NSCache` after a critical memory-pressure event until the pressure is back to
/// normal. Every way in to an `NSCache`'s contents is answered here; none reaches the real cache.
final class ForgottenStills: NSCache<NSString, CGImage>, @unchecked Sendable {
    override func object(forKey key: NSString) -> CGImage? { nil }

    override func setObject(_ still: CGImage, forKey key: NSString) {}

    override func setObject(_ still: CGImage, forKey key: NSString, cost: Int) {}

    override func removeObject(forKey key: NSString) {}

    override func removeAllObjects() {}
}
