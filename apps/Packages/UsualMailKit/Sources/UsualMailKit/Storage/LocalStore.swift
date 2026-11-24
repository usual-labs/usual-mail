import Foundation
import GRDB

/// The on-device copy of mail: an SQLite file, so the app opens instantly and works offline.
///
/// The lists follow docs/contract.md's definitions of Home, the categories, stacks, waiting, screening, Handled and
/// drafts (`LocalReader`), so what the app shows offline matches what the server would answer. Writes keep whichever
/// copy has the higher `version` (`LocalWriter`). The server's counts and its AI's status and settings are kept too,
/// so they show offline.
public final class LocalStore: Sendable {
    private let database: DatabaseQueue

    /// Opens (or creates) the copy at `url`.
    public init(url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        database = try DatabaseQueue(path: url.path(percentEncoded: false))
        try LocalSchema.migrator.migrate(database)
    }

    /// A copy that lives only in memory, for previews and tests.
    public init() throws {
        database = try DatabaseQueue()
        try LocalSchema.migrator.migrate(database)
    }

    /// A copy filled with `sample`, for previews and tests.
    public static func sample(_ sample: SampleData = .bundled) async throws -> LocalStore {
        let store = try LocalStore()
        try await store.write { writer in
            try writer.replaceInboxes(sample.inboxes)
            try writer.upsert(threads: sample.threads)
            try writer.upsert(messages: sample.messages)
            try writer.upsert(actions: sample.actions)
            try writer.upsert(rules: sample.rules)
            try writer.upsert(drafts: sample.drafts)
            try writer.save(brief: sample.brief)
            try writer.save(counts: sample.counts)
            try writer.save(aiStatus: sample.aiStatus)
            try writer.save(aiSettings: sample.ai)
        }
        return store
    }

    /// Runs `updates` in one transaction.
    public func write(_ updates: @escaping @Sendable (LocalWriter) throws -> Void) async throws {
        try await database.write { db in try updates(LocalWriter(db: db)) }
    }

    // MARK: Lists

    /// Everything the lists show, read in one transaction. Handled leaves silent records out unless
    /// `includeSilent`, and counts the ones it leaves out.
    public func lists(at now: Date, includeSilent: Bool = false, handledLimit: Int = 500) async throws -> MailLists {
        try await database.read { db in
            let reader = LocalReader(db: db)
            let states: [ActionState] = [.proposed, .applied]
            var lists = MailLists(
                inboxes: try reader.inboxes(), home: try reader.home(at: now, inboxId: nil),
                waiting: try reader.waiting(at: now, inboxId: nil), screening: try reader.screening(inboxId: nil))
            for category in Category.known { lists.categories[category] = try reader.category(category, inboxId: nil) }
            for stack in Stack.known { lists.stacks[stack] = try reader.stack(stack, inboxId: nil) }
            lists.handled = try reader.handled(
                states: states, inboxId: nil, limit: handledLimit, includeSilent: includeSilent)
            lists.includesSilent = includeSilent
            lists.silentCount = try reader.silentCount(states: states, inboxId: nil)
            lists.attention = try reader.attention(inboxId: nil, limit: handledLimit)
            lists.drafts = try reader.drafts(inboxId: nil)
            lists.rules = try reader.rules()
            lists.brief = try reader.latestBrief()
            return lists
        }
    }

    public func inboxes() async throws -> [Inbox] {
        try await database.read { try LocalReader(db: $0).inboxes() }
    }

    /// Home at `now`: see `LocalReader.home`.
    public func home(at now: Date, inboxId: String? = nil) async throws -> [MailThread] {
        try await database.read { try LocalReader(db: $0).home(at: now, inboxId: inboxId) }
    }

    /// A category's threads that are let in and not done, newest first.
    public func category(_ category: Category, inboxId: String? = nil) async throws -> [MailThread] {
        try await database.read { try LocalReader(db: $0).category(category, inboxId: inboxId) }
    }

    /// Threads on `stack` that are let in, newest first.
    public func stack(_ stack: Stack, inboxId: String? = nil) async throws -> [MailThread] {
        try await database.read { try LocalReader(db: $0).stack(stack, inboxId: inboxId) }
    }

    /// Threads whose come-back time is after `now`, soonest first.
    public func waiting(at now: Date, inboxId: String? = nil) async throws -> [MailThread] {
        try await database.read { try LocalReader(db: $0).waiting(at: now, inboxId: inboxId) }
    }

    /// Screened threads that aren't done, newest first.
    public func screening(inboxId: String? = nil) async throws -> [MailThread] {
        try await database.read { try LocalReader(db: $0).screening(inboxId: inboxId) }
    }

    /// The server's counts and its AI's status and settings, as last stored.
    public func status() async throws -> ServerStatus {
        try await database.read { try LocalReader(db: $0).status() }
    }

    /// What rules, agents and the server's AI did or propose, in `states`, newest first. Silent records only with
    /// `includeSilent`.
    public func handled(
        states: [ActionState] = [.proposed, .applied], inboxId: String? = nil, limit: Int = 500,
        includeSilent: Bool = false
    ) async throws -> [HandledItem] {
        try await database.read {
            try LocalReader(db: $0).handled(
                states: states, inboxId: inboxId, limit: limit, includeSilent: includeSilent)
        }
    }

    /// Records that failed or carry an error or a note, from every state and whoever made them, newest first.
    public func attention(inboxId: String? = nil, limit: Int = 500) async throws -> [HandledItem] {
        try await database.read { try LocalReader(db: $0).attention(inboxId: inboxId, limit: limit) }
    }

    /// Drafts in state `draft` or `failed`, newest first, in one inbox or all.
    public func drafts(inboxId: String? = nil) async throws -> [Draft] {
        try await database.read { try LocalReader(db: $0).drafts(inboxId: inboxId) }
    }

    /// The newest brief on the device.
    public func latestBrief() async throws -> Brief? {
        try await database.read { try LocalReader(db: $0).latestBrief() }
    }

    // MARK: Single things

    public func thread(id: String) async throws -> MailThread? {
        try await database.read { db in
            try Data.fetchOne(db, sql: "SELECT json FROM thread WHERE id = ?", arguments: [id]).map(StoredJSON.decode)
        }
    }

    /// The thread with its stored messages (oldest first) and every stored draft for it, sent ones with a note
    /// included.
    public func detail(threadId: String) async throws -> ThreadDetail? {
        try await database.read { db in
            guard
                let thread: MailThread = try Data.fetchOne(
                    db, sql: "SELECT json FROM thread WHERE id = ?", arguments: [threadId]
                ).map(StoredJSON.decode)
            else { return nil }
            let messages: [Message] = try Data.fetchAll(
                db, sql: "SELECT json FROM message WHERE threadId = ? ORDER BY date, id", arguments: [threadId]
            ).map(StoredJSON.decode)
            let drafts: [Draft] = try Data.fetchAll(
                db, sql: "SELECT json FROM draft WHERE threadId = ? ORDER BY updatedAt, id", arguments: [threadId]
            ).map(StoredJSON.decode)
            return ThreadDetail(thread: thread, messages: messages, drafts: drafts)
        }
    }

    public func action(id: String) async throws -> ActionRecord? {
        try await database.read { db in
            try Data.fetchOne(db, sql: "SELECT json FROM action WHERE id = ?", arguments: [id]).map(StoredJSON.decode)
        }
    }

    /// Every stored record for a thread, newest first, the person's own included.
    public func actions(threadId: String) async throws -> [ActionRecord] {
        try await database.read { db in
            try Data.fetchAll(
                db, sql: "SELECT json FROM action WHERE threadId = ? ORDER BY at DESC, id DESC", arguments: [threadId]
            ).map(StoredJSON.decode)
        }
    }

    /// An inbox's rules, oldest first.
    public func rules(inboxId: String) async throws -> [Rule] {
        try await database.read { db in
            try Data.fetchAll(
                db, sql: "SELECT json FROM rule WHERE inboxId = ? ORDER BY createdAt, id", arguments: [inboxId]
            ).map(StoredJSON.decode)
        }
    }

    public func rule(id: String) async throws -> Rule? {
        try await database.read { db in
            try Data.fetchOne(db, sql: "SELECT json FROM rule WHERE id = ?", arguments: [id]).map(StoredJSON.decode)
        }
    }

    public func inbox(id: String) async throws -> Inbox? {
        try await database.read { db in
            try Data.fetchOne(db, sql: "SELECT json FROM inbox WHERE id = ?", arguments: [id]).map(StoredJSON.decode)
        }
    }

    public func draft(id: String) async throws -> Draft? {
        try await database.read { db in
            try Data.fetchOne(db, sql: "SELECT json FROM draft WHERE id = ?", arguments: [id]).map(StoredJSON.decode)
        }
    }
}
