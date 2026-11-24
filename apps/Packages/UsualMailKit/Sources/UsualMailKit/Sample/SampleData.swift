import Foundation

/// The made-up server state in `core/fixtures/sample.json` (shaped by `core/src/sample.ts`), for previews
/// and tests. The package bundles a copy; `scripts/copy-sample.sh` refreshes it.
public struct SampleData: Codable, Sendable {
    /// The moment the sample pretends is "now". Times in it are relative to this.
    public var now: Date
    /// In the inbox list's order, by `position`.
    public var inboxes: [Inbox]
    public var threads: [MailThread]
    public var messages: [Message]
    public var drafts: [Draft]
    public var actions: [ActionRecord]
    public var rules: [Rule]
    public var brief: Brief
    /// The AI's settings as a person's device gets them: never the key.
    public var ai: AiSettings
    public var aiStatus: AiStatus
    /// As a person's device gets it from `GET /v1/first-sync`.
    public var firstSync: FirstSyncWindow
    /// As a person's device gets it from `GET /v1/ai/usage?tz=Europe/Berlin`.
    public var aiUsage: AiUsage
    /// As a person's device gets them: every inbox.
    public var counts: Counts
    /// As a person's device gets them from `GET /v1/senders?state=blocked`: every inbox, the newest block first.
    public var blockedSenders: [BlockedSender]
    /// Mail a Gmail inbox's mailbox holds from before its first sync's window, which the server doesn't hold: what the
    /// server's demo mode finds when the mailbox itself is searched. Never in `threads` or `messages`.
    public var olderMail: [SampleOlderMail]
    /// Sentences asked of search with the server's answers (`POST /v1/search/ask`), for previews and tests; the sample
    /// mode answers them (`SampleSearch.ask`).
    public var searchAsks: [SampleSearchAsk]

    /// The bundled copy of sample.json.
    public static var bundledURL: URL {
        guard let url = Bundle.module.url(forResource: "sample", withExtension: "json") else {
            preconditionFailure("UsualMailKit is missing its sample.json resource; run scripts/copy-sample.sh")
        }
        return url
    }

    public static func load(from url: URL = bundledURL) throws -> SampleData {
        try MailJSON.decoder().decode(SampleData.self, from: Data(contentsOf: url))
    }

    /// The bundled sample. Stops the program if it doesn't decode, which a test catches first.
    public static let bundled: SampleData = {
        do {
            return try load()
        } catch {
            preconditionFailure("The bundled sample.json doesn't decode: \(error)")
        }
    }()

    /// Each thread with its messages and drafts, as `GET /v1/threads/:id` would return it: a sent draft only with a
    /// note (the sample's are within their day).
    public func detail(threadId: String) -> ThreadDetail? {
        guard let thread = threads.first(where: { $0.id == threadId }) else { return nil }
        return ThreadDetail(
            thread: thread,
            messages: messages.filter { $0.threadId == threadId }.sorted { $0.date < $1.date },
            drafts: drafts.filter { $0.threadId == threadId && $0.isKept })
    }

    /// The sample's action records with their threads, as Handled rows.
    public var handledItems: [HandledItem] {
        actions.compactMap { record in
            threads.first { $0.id == record.threadId }.map { HandledItem(record: record, thread: $0) }
        }
    }
}

/// One message of the sample's older mail, as its mailbox has it (`SampleOlderMail` in core). Messages with the same
/// `threadKey` are one conversation.
public struct SampleOlderMail: Codable, Hashable, Sendable {
    public var inboxId: String
    public var threadKey: String
    public var from: Address
    public var to: [Address]
    public var subject: String
    public var date: Date
    public var text: String
    /// Out of the mailbox's inbox.
    public var archived: Bool
    /// Written only when present.
    public var attachments: [AttachmentMeta]?
}

/// One sentence asked of search and the server's answer to it (`SampleSearchAsk` in core).
public struct SampleSearchAsk: Codable, Hashable, Sendable {
    public var question: String
    /// The time zone the sentence was read in: its periods are days there.
    public var tz: String
    public var answer: SearchAskResult
}
