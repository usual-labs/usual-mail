import Foundation
import GRDB

/// The tables of the on-device copy. Each keeps the server's object as JSON plus the columns the lists filter
/// and sort on, and the `version` that writes compare.
enum LocalSchema {
    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        // The first build's tables, kept so a copy made by it migrates.
        migrator.registerMigration("v1") { db in
            try db.execute(
                sql: """
                    CREATE TABLE inbox (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json BLOB NOT NULL);
                    CREATE TABLE thread (
                        id TEXT PRIMARY KEY, inboxId TEXT NOT NULL, pile TEXT NOT NULL, done INTEGER NOT NULL,
                        stack TEXT, comeBackAt REAL, lastMessageAt REAL NOT NULL, json BLOB NOT NULL);
                    CREATE TABLE message (
                        id TEXT PRIMARY KEY, threadId TEXT NOT NULL, inboxId TEXT NOT NULL, date REAL NOT NULL,
                        json BLOB NOT NULL);
                    CREATE TABLE action (
                        id TEXT PRIMARY KEY, threadId TEXT NOT NULL, inboxId TEXT NOT NULL, state TEXT NOT NULL,
                        actorKind TEXT NOT NULL, at REAL NOT NULL, json BLOB NOT NULL);
                    CREATE TABLE rule (id TEXT PRIMARY KEY, inboxId TEXT NOT NULL, createdAt REAL NOT NULL, json BLOB NOT NULL);
                    CREATE TABLE draft (
                        id TEXT PRIMARY KEY, inboxId TEXT NOT NULL, threadId TEXT, updatedAt REAL NOT NULL,
                        json BLOB NOT NULL);
                    """)
        }
        // Each revision of the contract changed the JSON so an older copy no longer decodes (v2: `trashed` and
        // `version` on threads; v3: versions on inboxes and drafts, `silent` and `note` on records; v4: `connection`
        // on inboxes, `version` and `createdBy` on rules; v5: categories, screening and summaries on threads, icons,
        // positions and AI processing on inboxes, the AI's records, and the counts and the AI's status and settings).
        // The copy is a cache of the server, so it starts again empty and the next refresh fills it.
        migrator.registerMigration("v2") { db in try recreate(db) }
        migrator.registerMigration("v3") { db in try recreate(db) }
        migrator.registerMigration("v4") { db in try recreate(db) }
        migrator.registerMigration("v5") { db in try recreate(db) }
        return migrator
    }

    private static let tables = ["inbox", "thread", "message", "action", "rule", "draft", "brief", "state"]

    /// Drops every table and creates the current ones, empty.
    private static func recreate(_ db: Database) throws {
        for table in tables {
            try db.execute(sql: "DROP TABLE IF EXISTS \(table)")
        }
        try db.execute(
            sql: """
                CREATE TABLE inbox (
                    id TEXT PRIMARY KEY, position INTEGER NOT NULL, version INTEGER NOT NULL, json BLOB NOT NULL);
                CREATE TABLE thread (
                    id TEXT PRIMARY KEY, inboxId TEXT NOT NULL, category TEXT NOT NULL, screened INTEGER NOT NULL,
                    done INTEGER NOT NULL, stack TEXT, comeBackAt REAL, lastMessageAt REAL NOT NULL,
                    trashed INTEGER NOT NULL, version INTEGER NOT NULL, json BLOB NOT NULL);
                CREATE INDEX thread_category ON thread (category, done, lastMessageAt);
                CREATE INDEX thread_stack ON thread (stack, lastMessageAt);
                CREATE INDEX thread_come_back ON thread (comeBackAt);
                CREATE INDEX thread_inbox ON thread (inboxId);
                CREATE TABLE message (
                    id TEXT PRIMARY KEY, threadId TEXT NOT NULL, inboxId TEXT NOT NULL, date REAL NOT NULL,
                    json BLOB NOT NULL);
                CREATE INDEX message_thread ON message (threadId, date);
                CREATE TABLE action (
                    id TEXT PRIMARY KEY, threadId TEXT NOT NULL, inboxId TEXT NOT NULL, state TEXT NOT NULL,
                    actorKind TEXT NOT NULL, at REAL NOT NULL, silent INTEGER NOT NULL, attention INTEGER NOT NULL,
                    version INTEGER NOT NULL, json BLOB NOT NULL);
                CREATE INDEX action_state ON action (state, at);
                CREATE INDEX action_thread ON action (threadId);
                CREATE TABLE rule (
                    id TEXT PRIMARY KEY, inboxId TEXT NOT NULL, createdAt REAL NOT NULL, version INTEGER NOT NULL,
                    json BLOB NOT NULL);
                CREATE INDEX rule_inbox ON rule (inboxId);
                CREATE TABLE draft (
                    id TEXT PRIMARY KEY, inboxId TEXT NOT NULL, threadId TEXT, state TEXT NOT NULL,
                    updatedAt REAL NOT NULL, version INTEGER NOT NULL, json BLOB NOT NULL);
                CREATE INDEX draft_thread ON draft (threadId);
                CREATE TABLE brief (id TEXT PRIMARY KEY, createdAt REAL NOT NULL, json BLOB NOT NULL);
                CREATE TABLE state (key TEXT PRIMARY KEY, version INTEGER NOT NULL, json BLOB NOT NULL);
                """)
    }
}

/// The list queries, as docs/contract.md defines the lists ("Lists"): every thread list leaves out trashed
/// threads and orders newest first, equal times by id, descending.
struct LocalReader {
    let db: Database

    func inboxes() throws -> [Inbox] {
        try Data.fetchAll(db, sql: "SELECT json FROM inbox ORDER BY position, id").map(StoredJSON.decode)
    }

    /// Home: conversation and uncategorized threads (core's `HOME_CATEGORIES`; notifications have their own tab since
    /// the owner's decision of 2026-11-19) that are let in, not done, on no stack and with no come-back time in the
    /// future, by the later of the last message and a come-back time that has passed.
    func home(at now: Date, inboxId: String?) throws -> [MailThread] {
        try threads(
            where: """
                category IN ('conversation', 'unknown') AND screened = 0 AND done = 0 AND stack IS NULL
                AND (comeBackAt IS NULL OR comeBackAt <= ?)
                """,
            arguments: [now.timeIntervalSince1970], inboxId: inboxId,
            order: "MAX(lastMessageAt, COALESCE(comeBackAt, lastMessageAt)) DESC, id DESC")
    }

    /// A category's threads that are let in and not done, stacked and waiting ones included. A category this app
    /// doesn't know is stored as `unknown`, so it lists with the uncategorized ones.
    func category(_ category: Category, inboxId: String?) throws -> [MailThread] {
        try threads(
            where: "category = ? AND screened = 0 AND done = 0", arguments: [category.listed.rawValue],
            inboxId: inboxId)
    }

    /// Threads on a stack that are let in. A thread on a stack is never done.
    func stack(_ stack: Stack, inboxId: String?) throws -> [MailThread] {
        try threads(where: "stack = ? AND screened = 0", arguments: [stack.rawValue], inboxId: inboxId)
    }

    /// Threads whose come-back time is after `now`, not done and let in, soonest first, equal times by id ascending.
    func waiting(at now: Date, inboxId: String?) throws -> [MailThread] {
        try threads(
            where: "comeBackAt > ? AND done = 0 AND screened = 0", arguments: [now.timeIntervalSince1970],
            inboxId: inboxId, order: "comeBackAt ASC, id ASC")
    }

    /// Screened threads that aren't done.
    func screening(inboxId: String?) throws -> [MailThread] {
        try threads(where: "screened = 1 AND done = 0", arguments: [], inboxId: inboxId)
    }

    /// Records made by rules, agents and the server's AI, in `states`, by their time, each with its thread. Records of a trashed
    /// thread stay, so the trash can still be undone from Handled. Silent records only with `includeSilent`: the
    /// server marks a record silent, and never one that failed or carries a note, so filtering on the flag is all.
    func handled(states: [ActionState], inboxId: String?, limit: Int, includeSilent: Bool) throws -> [HandledItem] {
        guard !states.isEmpty else { return [] }
        var (condition, arguments) = handledCondition(states: states, inboxId: inboxId)
        if !includeSilent { condition += " AND action.silent = 0" }
        let sql = """
            SELECT action.json AS record, thread.json AS thread FROM action
            JOIN thread ON thread.id = action.threadId
            WHERE \(condition) ORDER BY action.at DESC, action.id DESC LIMIT ?
            """
        arguments += [limit]
        return try Row.fetchAll(db, sql: sql, arguments: arguments).map { row in
            HandledItem(record: try StoredJSON.decode(row["record"]), thread: try StoredJSON.decode(row["thread"]))
        }
    }

    /// Records that need a person's look, from every state and whoever made them, the person's own refused changes
    /// included: those that failed, or carry an `error` or a `note` (Handled with `attentionOnly`), newest first, each
    /// with its thread. Such a record is never silent; one marked silent is left out all the same, as the server does.
    func attention(inboxId: String?, limit: Int) throws -> [HandledItem] {
        var sql = """
            SELECT action.json AS record, thread.json AS thread FROM action
            JOIN thread ON thread.id = action.threadId
            WHERE action.attention = 1 AND action.silent = 0
            """
        var arguments = StatementArguments()
        if let inboxId {
            sql += " AND action.inboxId = ?"
            arguments += [inboxId]
        }
        sql += " ORDER BY action.at DESC, action.id DESC LIMIT ?"
        arguments += [limit]
        return try Row.fetchAll(db, sql: sql, arguments: arguments).map { row in
            HandledItem(record: try StoredJSON.decode(row["record"]), thread: try StoredJSON.decode(row["thread"]))
        }
    }

    /// How many silent records Handled leaves out, in `states`.
    func silentCount(states: [ActionState], inboxId: String?) throws -> Int {
        guard !states.isEmpty else { return 0 }
        let (condition, arguments) = handledCondition(states: states, inboxId: inboxId)
        return try Int.fetchOne(
            db,
            sql: """
                SELECT COUNT(*) FROM action JOIN thread ON thread.id = action.threadId
                WHERE \(condition) AND action.silent = 1
                """, arguments: arguments) ?? 0
    }

    /// Drafts in state `draft` or `failed`, newest first.
    func drafts(inboxId: String?) throws -> [Draft] {
        var sql = "SELECT json FROM draft WHERE state IN ('draft', 'failed')"
        var arguments = StatementArguments()
        if let inboxId {
            sql += " AND inboxId = ?"
            arguments += [inboxId]
        }
        sql += " ORDER BY updatedAt DESC, id DESC"
        return try Data.fetchAll(db, sql: sql, arguments: arguments).map(StoredJSON.decode)
    }

    /// Every inbox's rules, oldest first, by inbox id.
    func rules() throws -> [String: [Rule]] {
        let rules: [Rule] = try Data.fetchAll(db, sql: "SELECT json FROM rule ORDER BY createdAt, id")
            .map(StoredJSON.decode)
        return Dictionary(grouping: rules, by: \.inboxId)
    }

    /// The newest stored brief.
    func latestBrief() throws -> Brief? {
        try Data.fetchOne(db, sql: "SELECT json FROM brief ORDER BY createdAt DESC, id DESC LIMIT 1")
            .map(StoredJSON.decode)
    }

    /// The counts and the AI's status and settings, as last stored.
    func status() throws -> ServerStatus {
        ServerStatus(
            counts: try state(.counts), aiStatus: try state(.aiStatus), aiSettings: try state(.aiSettings))
    }

    func state<Value: Decodable & Sendable>(_ key: StateKey) throws -> Value? {
        try Data.fetchOne(db, sql: "SELECT json FROM state WHERE key = ?", arguments: [key.rawValue])
            .map(StoredJSON.decode)
    }

    private func handledCondition(states: [ActionState], inboxId: String?) -> (String, StatementArguments) {
        var condition = """
            action.actorKind IN ('rule', 'agent', 'ai') \
            AND action.state IN (\(Array(repeating: "?", count: states.count).joined(separator: ", ")))
            """
        var arguments = StatementArguments(states.map(\.rawValue))
        if let inboxId {
            condition += " AND action.inboxId = ?"
            arguments += [inboxId]
        }
        return (condition, arguments)
    }

    private func threads(
        where condition: String, arguments: StatementArguments, inboxId: String?,
        order: String = "lastMessageAt DESC, id DESC"
    ) throws -> [MailThread] {
        var sql = "SELECT json FROM thread WHERE trashed = 0 AND \(condition)"
        var arguments = arguments
        if let inboxId {
            sql += " AND inboxId = ?"
            arguments += [inboxId]
        }
        sql += " ORDER BY \(order)"
        return try Data.fetchAll(db, sql: sql, arguments: arguments).map(StoredJSON.decode)
    }
}

/// The rows of the `state` table: one thing each, kept by version.
enum StateKey: String {
    case counts, aiStatus, aiSettings
}

/// How objects are kept in the `json` columns. Times are stored as numbers, which round-trip exactly.
enum StoredJSON {
    static func encode(_ value: some Encodable) throws -> Data {
        try JSONEncoder().encode(value)
    }

    static func decode<Value: Decodable>(_ data: Data) throws -> Value {
        try JSONDecoder().decode(Value.self, from: data)
    }
}
