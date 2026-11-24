import Foundation
import GRDB

/// Changes to the on-device copy, made inside one `LocalStore.write` transaction.
///
/// Inboxes, threads, action records, drafts, rules, the counts and the AI's status and settings carry a `version`;
/// writing one never replaces a stored copy with a higher version, so an older answer can arrive after a newer event without undoing it. An equal version replaces
/// the copy, so the server's copy can take back a change shown before it answered. There are no foreign keys:
/// events can name a thread before its inbox arrives, so removing an inbox or a thread removes what belongs to it.
public struct LocalWriter {
    let db: Database

    // MARK: Inboxes

    /// Inserts or updates inboxes, unless the stored copy has a higher version. The inbox list is ordered by each
    /// inbox's `position`; when the server moves one, every inbox whose position changed comes with a higher version.
    public func upsert(inboxes: [Inbox]) throws {
        for inbox in inboxes {
            try db.execute(
                sql: """
                    INSERT INTO inbox (id, position, version, json) VALUES (?, ?, ?, ?)
                    ON CONFLICT (id) DO UPDATE SET
                        position = excluded.position, version = excluded.version, json = excluded.json
                    WHERE excluded.version >= inbox.version
                    """,
                arguments: [inbox.id, inbox.position, inbox.version, try StoredJSON.encode(inbox)])
        }
    }

    /// Makes the stored inboxes `inboxes`, removing the others and their mail. A stored copy with a higher version
    /// stays. Ids in `keeping` changed while the list was on its way: a stored one isn't removed for being missing,
    /// and one no longer stored was removed meanwhile and isn't brought back.
    public func replaceInboxes(_ inboxes: [Inbox], keeping: Set<String> = []) throws {
        let listed = Set(inboxes.map(\.id))
        let stored = Set(try String.fetchAll(db, sql: "SELECT id FROM inbox"))
        for id in stored where !listed.contains(id) && !keeping.contains(id) {
            try deleteInbox(id: id)
        }
        try upsert(inboxes: inboxes.filter { stored.contains($0.id) || !keeping.contains($0.id) })
    }

    /// Removes an inbox and everything stored for it, its counts included (`all` is lowered to match until the
    /// server's next counts arrive).
    public func deleteInbox(id: String) throws {
        for table in ["thread", "message", "action", "rule", "draft"] {
            try db.execute(sql: "DELETE FROM \(table) WHERE inboxId = ?", arguments: [id])
        }
        try db.execute(sql: "DELETE FROM inbox WHERE id = ?", arguments: [id])
        if let counts: Counts = try LocalReader(db: db).state(.counts) {
            try saveState(.counts, counts.keepingOnly(inboxes: Set(counts.inboxes.map(\.inboxId)).subtracting([id])))
        }
    }

    // MARK: Threads and messages

    /// Stores threads, unless the stored copy has a higher version.
    public func upsert(threads: [MailThread]) throws {
        for thread in threads {
            try db.execute(
                sql: """
                    INSERT INTO thread (
                        id, inboxId, category, screened, done, stack, comeBackAt, lastMessageAt, trashed, version,
                        json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (id) DO UPDATE SET
                        inboxId = excluded.inboxId, category = excluded.category, screened = excluded.screened,
                        done = excluded.done, stack = excluded.stack, comeBackAt = excluded.comeBackAt,
                        lastMessageAt = excluded.lastMessageAt, trashed = excluded.trashed,
                        version = excluded.version, json = excluded.json
                    WHERE excluded.version >= thread.version
                    """,
                arguments: [
                    thread.id, thread.inboxId, thread.category.listed.rawValue, thread.screened, thread.done,
                    thread.stack?.rawValue, thread.comeBackAt?.timeIntervalSince1970,
                    thread.lastMessageAt.timeIntervalSince1970, thread.trashed, thread.version,
                    try StoredJSON.encode(thread),
                ])
        }
    }

    /// Takes a thread and its messages off the device. Its action records stay, as the server keeps them.
    public func deleteThread(id: String) throws {
        try db.execute(sql: "DELETE FROM message WHERE threadId = ?", arguments: [id])
        try db.execute(sql: "DELETE FROM thread WHERE id = ?", arguments: [id])
    }

    /// A thread the server removed (`thread.removed`): it goes with its messages, and its records leave Handled.
    public func removeThread(id: String) throws {
        try deleteThread(id: id)
        try db.execute(sql: "DELETE FROM action WHERE threadId = ?", arguments: [id])
    }

    public func upsert(messages: [Message]) throws {
        for message in messages {
            try db.execute(
                sql: """
                    INSERT INTO message (id, threadId, inboxId, date, json) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (id) DO UPDATE SET
                        threadId = excluded.threadId, inboxId = excluded.inboxId, date = excluded.date,
                        json = excluded.json
                    """,
                arguments: [
                    message.id, message.threadId, message.inboxId, message.date.timeIntervalSince1970,
                    try StoredJSON.encode(message),
                ])
        }
    }

    /// Stores a thread as `GET /v1/threads/:id` returned it: its messages and drafts replace the stored ones.
    public func save(_ detail: ThreadDetail) throws {
        try upsert(threads: [detail.thread])
        let messageIDs = Set(detail.messages.map(\.id))
        for id in try String.fetchAll(
            db, sql: "SELECT id FROM message WHERE threadId = ?", arguments: [detail.thread.id])
        where !messageIDs.contains(id) {
            try db.execute(sql: "DELETE FROM message WHERE id = ?", arguments: [id])
        }
        try upsert(messages: detail.messages)
        let draftIDs = Set(detail.drafts.map(\.id))
        for id in try String.fetchAll(db, sql: "SELECT id FROM draft WHERE threadId = ?", arguments: [detail.thread.id])
        where !draftIDs.contains(id) {
            try deleteDraft(id: id)
        }
        try upsert(drafts: detail.drafts)
    }

    // MARK: Actions, rules, drafts and briefs

    /// Stores action records, unless the stored copy has a higher version.
    public func upsert(actions: [ActionRecord]) throws {
        for record in actions {
            try db.execute(
                sql: """
                    INSERT INTO action (id, threadId, inboxId, state, actorKind, at, silent, attention, version, json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (id) DO UPDATE SET
                        threadId = excluded.threadId, inboxId = excluded.inboxId, state = excluded.state,
                        actorKind = excluded.actorKind, at = excluded.at, silent = excluded.silent,
                        attention = excluded.attention, version = excluded.version, json = excluded.json
                    WHERE excluded.version >= action.version
                    """,
                arguments: [
                    record.id, record.threadId, record.inboxId, record.state.rawValue, record.actor.kind,
                    record.at.timeIntervalSince1970, record.silent, record.needsALook, record.version,
                    try StoredJSON.encode(record),
                ])
        }
    }

    /// Stores rules, unless the stored copy has a higher version.
    public func upsert(rules: [Rule]) throws {
        for rule in rules {
            try db.execute(
                sql: """
                    INSERT INTO rule (id, inboxId, createdAt, version, json) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (id) DO UPDATE SET
                        inboxId = excluded.inboxId, createdAt = excluded.createdAt, version = excluded.version,
                        json = excluded.json
                    WHERE excluded.version >= rule.version
                    """,
                arguments: [
                    rule.id, rule.inboxId, rule.createdAt.timeIntervalSince1970, rule.version,
                    try StoredJSON.encode(rule),
                ])
        }
    }

    /// Makes an inbox's stored rules `rules`, each by version. Ids in `keeping` changed on this device or through an
    /// event while the list was on its way: a stored one isn't removed for being missing, and one no longer stored was
    /// removed meanwhile and isn't brought back.
    public func replaceRules(_ rules: [Rule], inboxId: String, keeping: Set<String> = []) throws {
        let listed = Set(rules.map(\.id))
        let stored = Set(try String.fetchAll(db, sql: "SELECT id FROM rule WHERE inboxId = ?", arguments: [inboxId]))
        for id in stored where !listed.contains(id) && !keeping.contains(id) {
            try deleteRule(id: id)
        }
        try upsert(rules: rules.filter { !keeping.contains($0.id) || stored.contains($0.id) })
    }

    public func deleteRule(id: String) throws {
        try db.execute(sql: "DELETE FROM rule WHERE id = ?", arguments: [id])
    }

    /// Stores drafts, unless the stored copy has a higher version. A sent draft without a note is removed instead:
    /// the server doesn't keep it either (`draft.removed` follows).
    public func upsert(drafts: [Draft]) throws {
        for draft in drafts {
            guard draft.isKept else {
                try deleteDraft(id: draft.id)
                continue
            }
            try db.execute(
                sql: """
                    INSERT INTO draft (id, inboxId, threadId, state, updatedAt, version, json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (id) DO UPDATE SET
                        inboxId = excluded.inboxId, threadId = excluded.threadId, state = excluded.state,
                        updatedAt = excluded.updatedAt, version = excluded.version, json = excluded.json
                    WHERE excluded.version >= draft.version
                    """,
                arguments: [
                    draft.id, draft.inboxId, draft.threadId, draft.state.rawValue,
                    draft.updatedAt.timeIntervalSince1970, draft.version, try StoredJSON.encode(draft),
                ])
        }
    }

    public func deleteDraft(id: String) throws {
        try db.execute(sql: "DELETE FROM draft WHERE id = ?", arguments: [id])
    }

    /// Removes sent drafts the server no longer keeps: their day is over (they were sent before `cutoff`), or they
    /// are new messages, with no thread to show their note in. Covers a `draft.removed` this device missed.
    public func dropSentDrafts(sentBefore cutoff: Date) throws {
        try db.execute(
            sql: "DELETE FROM draft WHERE state = 'sent' AND (threadId IS NULL OR updatedAt < ?)",
            arguments: [cutoff.timeIntervalSince1970])
    }

    /// Keeps `brief` as the one brief on the device, unless a newer one is already here.
    public func save(brief: Brief) throws {
        let newer = try Bool.fetchOne(
            db, sql: "SELECT EXISTS (SELECT 1 FROM brief WHERE createdAt > ? AND id != ?)",
            arguments: [brief.createdAt.timeIntervalSince1970, brief.id])
        guard newer != true else { return }
        try db.execute(sql: "DELETE FROM brief WHERE id != ?", arguments: [brief.id])
        try db.execute(
            sql: """
                INSERT INTO brief (id, createdAt, json) VALUES (?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET createdAt = excluded.createdAt, json = excluded.json
                """,
            arguments: [brief.id, brief.createdAt.timeIntervalSince1970, try StoredJSON.encode(brief)])
    }

    public func deleteBriefs() throws {
        try db.execute(sql: "DELETE FROM brief")
    }

    // MARK: Counts and the AI

    /// Keeps the counts, unless the stored copy has a higher version.
    public func save(counts: Counts) throws {
        try saveState(.counts, counts)
    }

    /// Keeps the AI's status, unless the stored copy has a higher version.
    public func save(aiStatus: AiStatus) throws {
        try saveState(.aiStatus, aiStatus)
    }

    /// Keeps the AI's settings, unless the stored copy has a higher version. They never hold the key.
    public func save(aiSettings: AiSettings) throws {
        try saveState(.aiSettings, aiSettings)
    }

    private func saveState(_ key: StateKey, _ value: some Encodable & Versioned) throws {
        try db.execute(
            sql: """
                INSERT INTO state (key, version, json) VALUES (?, ?, ?)
                ON CONFLICT (key) DO UPDATE SET version = excluded.version, json = excluded.json
                WHERE excluded.version >= state.version
                """,
            arguments: [key.rawValue, value.version, try StoredJSON.encode(value)])
    }

    // MARK: Refresh

    /// Brings the copy in line with what a refresh fetched.
    ///
    /// Everything with a version is written by version, so a newer copy from an event or an answer survives.
    /// What versions can't settle is removal: the refresh learns that something is gone only because a list no
    /// longer has it. That removal skips everything in `keeping` (the ids that changed on this device or through
    /// an event while the refresh was on its way), and a kept id that is no longer stored was removed meanwhile, so
    /// the refresh doesn't bring it back.
    public func reconcile(_ snapshot: ServerSnapshot, keeping: RefreshKeep = RefreshKeep()) throws {
        try replaceInboxes(snapshot.inboxes, keeping: keeping.inboxes)
        // Nothing of an inbox that is gone (or was removed while the lists were on their way) is written back.
        let inboxes = Set(try String.fetchAll(db, sql: "SELECT id FROM inbox"))
        var snapshot = snapshot
        snapshot.keepOnly(inboxes: inboxes)

        let fetched = snapshot.allThreads
        // Every thread that isn't done is in its category's list or, screened, in the screening list. So a thread
        // stored as not done, or trashed, that the refresh didn't see was done, trashed or removed elsewhere. A trashed thread stays while the copy holds a record for it, so Handled can still show the
        // record and undo the trash (docs/contract.md, "Lists"); the server lists no trashed thread anywhere else.
        if snapshot.openThreadsComplete {
            let seen = Set(fetched.map(\.id)).union(keeping.threads)
            let candidates = try String.fetchAll(
                db,
                sql: """
                    SELECT id FROM thread WHERE (done = 0 OR trashed = 1)
                    AND NOT (trashed = 1 AND EXISTS (SELECT 1 FROM action WHERE action.threadId = thread.id))
                    """)
            for id in candidates where !seen.contains(id) {
                try deleteThread(id: id)
            }
        }
        let storedThreads = Set(try String.fetchAll(db, sql: "SELECT id FROM thread"))
        try upsert(threads: fetched.filter { !keeping.threads.contains($0.id) || storedThreads.contains($0.id) })
        try upsert(actions: (snapshot.handled + snapshot.proposals + snapshot.attention).map(\.record))

        // A stored proposal the server no longer lists was answered elsewhere.
        if snapshot.proposalsComplete {
            let proposed = Set(snapshot.proposals.map(\.record.id)).union(keeping.records)
            for id in try String.fetchAll(db, sql: "SELECT id FROM action WHERE state = 'proposed'")
            where !proposed.contains(id) {
                try db.execute(sql: "DELETE FROM action WHERE id = ?", arguments: [id])
            }
        }

        // The drafts list holds drafts and failed sends; one stored in those states that it lacks is gone.
        if snapshot.draftsComplete {
            let drafts = Set(snapshot.drafts.map(\.id)).union(keeping.drafts)
            for id in try String.fetchAll(db, sql: "SELECT id FROM draft WHERE state IN ('draft', 'failed')")
            where !drafts.contains(id) {
                try deleteDraft(id: id)
            }
        }
        let storedDrafts = Set(try String.fetchAll(db, sql: "SELECT id FROM draft"))
        try upsert(drafts: snapshot.drafts.filter { !keeping.drafts.contains($0.id) || storedDrafts.contains($0.id) })

        for (inboxId, rules) in snapshot.rules {
            try replaceRules(rules, inboxId: inboxId, keeping: keeping.rules)
        }

        if snapshot.briefFetched {
            if let brief = snapshot.brief { try save(brief: brief) } else if !keeping.brief { try deleteBriefs() }
        }

        // Each by version: an event's newer copy stays.
        if let counts = snapshot.counts { try save(counts: counts) }
        if let aiStatus = snapshot.aiStatus { try save(aiStatus: aiStatus) }
        if let aiSettings = snapshot.aiSettings { try save(aiSettings: aiSettings) }
    }
}

/// What a refresh must not remove for being missing from its lists, or bring back: ids that changed on this device
/// or through an event while it was fetching. Versions decide every overwrite; these ids are only about removal.
public struct RefreshKeep: Hashable, Sendable {
    public var threads: Set<String> = []
    public var records: Set<String> = []
    public var drafts: Set<String> = []
    public var inboxes: Set<String> = []
    public var rules: Set<String> = []
    /// A brief arrived through an event.
    public var brief = false

    public init(
        threads: Set<String> = [], records: Set<String> = [], drafts: Set<String> = [], inboxes: Set<String> = [],
        rules: Set<String> = [], brief: Bool = false
    ) {
        self.threads = threads
        self.records = records
        self.drafts = drafts
        self.inboxes = inboxes
        self.rules = rules
        self.brief = brief
    }

    mutating func formUnion(_ other: RefreshKeep) {
        threads.formUnion(other.threads)
        records.formUnion(other.records)
        drafts.formUnion(other.drafts)
        inboxes.formUnion(other.inboxes)
        rules.formUnion(other.rules)
        brief = brief || other.brief
    }
}
