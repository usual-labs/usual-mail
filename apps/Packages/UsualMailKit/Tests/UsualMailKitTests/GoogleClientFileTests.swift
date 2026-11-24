import Foundation
import Testing

@testable import UsualMailKit

/// Reading the Google client file a person chose or dropped: a regular file only, no further than one byte past what
/// the server takes, and never waiting on something that isn't a file.
struct GoogleClientFileTests {
    private let folder = FileManager.default.temporaryDirectory.appending(path: "google-client-\(UUID().uuidString)")

    private func make() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    private func clean() {
        try? FileManager.default.removeItem(at: folder)
    }

    @Test func aFileIsReadNoFurtherThanTheServerTakes() throws {
        try make()
        defer { clean() }
        #expect(GoogleClientFile.maxBytes == 16_384)
        #expect(GoogleClientFile.checked(Data(count: 16_384)) == .file(Data(count: 16_384)))
        #expect(GoogleClientFile.checked(Data(count: 16_385)) == .tooLarge)

        let small = folder.appending(path: "client_secret_1.json")
        try GoogleSetupServer.file.write(to: small)
        #expect(GoogleClientFile.read(at: small) == .file(GoogleSetupServer.file))
        let large = folder.appending(path: "large.json")
        try Data(repeating: 0x20, count: 1_000_000).write(to: large)
        #expect(GoogleClientFile.read(at: large) == .tooLarge)
        let empty = folder.appending(path: "empty.json")
        try Data().write(to: empty)
        #expect(GoogleClientFile.read(at: empty) == .file(Data()))
        #expect(GoogleClientFile.read(at: folder.appending(path: "gone.json")) == .unreadable)
    }

    @Test func aFolderIsNotAFile() throws {
        try make()
        defer { clean() }
        let inside = folder.appending(path: "client_secret_2.json")
        try FileManager.default.createDirectory(at: inside, withIntermediateDirectories: true)
        #expect(GoogleClientFile.read(at: inside) == .unreadable)
        #expect(GoogleClientFile.read(at: folder) == .unreadable)
    }

    @Test func aSymbolicLinkIsFollowedToARegularFileOnly() throws {
        try make()
        defer { clean() }
        let real = folder.appending(path: "real.json")
        try GoogleSetupServer.file.write(to: real)
        let link = folder.appending(path: "client_secret_link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        #expect(GoogleClientFile.read(at: link) == .file(GoogleSetupServer.file))

        let toFolder = folder.appending(path: "folder_link.json")
        try FileManager.default.createSymbolicLink(at: toFolder, withDestinationURL: folder)
        #expect(GoogleClientFile.read(at: toFolder) == .unreadable)

        let dangling = folder.appending(path: "dangling.json")
        try FileManager.default.createSymbolicLink(at: dangling, withDestinationURL: folder.appending(path: "none"))
        #expect(GoogleClientFile.read(at: dangling) == .unreadable)
    }

    /// A named pipe called `*.json` would never answer a plain read: it is refused at once, as is a link to one.
    @Test(.timeLimit(.minutes(1))) func aNamedPipeIsRefusedAtOnce() throws {
        try make()
        defer { clean() }
        let pipe = folder.appending(path: "client_secret_pipe.json")
        #expect(mkfifo(pipe.path(percentEncoded: false), 0o600) == 0)
        #expect(GoogleClientFile.read(at: pipe) == .unreadable)
        let link = folder.appending(path: "pipe_link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: pipe)
        #expect(GoogleClientFile.read(at: link) == .unreadable)
        #expect(GoogleClientFile.read(at: URL(filePath: "/dev/null")) == .unreadable)
    }
}
