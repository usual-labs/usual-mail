import Foundation

extension MailStore {
    /// Fetches an attachment from the server's attachment route into a temporary file named after it, for the
    /// system to show or open. Returns nil if the server couldn't be asked or refused (the problem says why, in words
    /// when the inbox is paused).
    public func file(for attachment: AttachmentMeta, in message: Message) async -> URL? {
        do {
            let file = try await client.attachment(messageId: message.id, attachmentId: attachment.id)
            let folder = Self.attachmentFolder.appending(
                path: Self.safeName(message.id, fallback: "message"), directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appending(path: Self.safeName(attachment.filename, fallback: "attachment"))
            try file.data.write(to: url, options: .atomic)
            return url
        } catch {
            report(error, inboxId: message.inboxId, ifPaused: .fetchingFile)
            return nil
        }
    }

    /// Where fetched attachments go. The system clears the temporary folder on its own.
    public nonisolated static var attachmentFolder: URL {
        FileManager.default.temporaryDirectory.appending(path: "Usual Mail attachments", directoryHint: .isDirectory)
    }

    /// A file name that stays inside its folder: no path separators, no leading dots, not empty.
    nonisolated static func safeName(_ name: String, fallback: String) -> String {
        let cleaned = name.map { "/\\:\0".contains($0) || $0.isNewline ? "_" : $0 }
        let trimmed = String(cleaned).trimmingCharacters(in: .whitespaces).drop { $0 == "." }
        return trimmed.isEmpty ? fallback : String(trimmed.prefix(200))
    }
}
