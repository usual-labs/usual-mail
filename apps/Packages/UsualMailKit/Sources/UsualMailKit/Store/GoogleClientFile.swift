import Foundation

/// The client file a person drops or chooses, read before anything is sent: a regular file of at most `maxBytes`
/// (core's `GOOGLE_CLIENT_FILE_MAX_BYTES`), its bytes kept exactly as they are.
public enum GoogleClientFile {
    /// The largest file the server takes. Google's own is well under 1 KiB.
    public static let maxBytes = 16_384

    public enum Read: Hashable, Sendable {
        case file(Data)
        case tooLarge
        case unreadable
    }

    /// Reads the file at `url`, following a symbolic link: only a regular file, and at most one byte more than
    /// `maxBytes`, so a large file is never read whole. It is opened without waiting, so a named pipe or a device is
    /// refused at once instead of never answering. A file the system's picker granted is read while the sandbox lets
    /// the app. It blocks while it reads: call it off the main actor.
    public static func read(at url: URL) -> Read {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let descriptor = url.withUnsafeFileSystemRepresentation { path in
            path.map { open($0, O_RDONLY | O_NONBLOCK | O_CLOEXEC) } ?? -1
        }
        guard descriptor >= 0 else { return .unreadable }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        var status = stat()
        guard fstat(descriptor, &status) == 0, status.st_mode & S_IFMT == S_IFREG else { return .unreadable }
        do {
            return checked(try handle.read(upToCount: maxBytes + 1) ?? Data())
        } catch {
            return .unreadable
        }
    }

    /// The file as it is, unless it is larger than the server takes.
    public static func checked(_ data: Data) -> Read {
        data.count > maxBytes ? .tooLarge : .file(data)
    }
}
