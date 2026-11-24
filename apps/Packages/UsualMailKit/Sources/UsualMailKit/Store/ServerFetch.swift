import Foundation

/// Fetches what a refresh needs from the server into a `ServerSnapshot`.
///
/// Every thread that isn't done is in its category's list or, screened, in the screening list, so those eight lists
/// read to their end say what is gone. Home, the stacks and waiting are read too, as the server lists them; the app
/// works its lists out from the on-device copy. Each paged list is read up to `maxPages`; a list cut short is marked
/// incomplete, so the copy keeps what it can't confirm is gone. Handled is its newest page only, silent records
/// included, and so are the records that need a look (`attentionOnly`), which come from every state. The counts and
/// the AI's status come with every refresh; the AI's settings and the first sync's window too, unless the server
/// refuses them.
struct ServerFetch: Sendable {
    let client: APIClient
    var pageSize = 200
    var maxPages = 10

    func snapshot() async throws -> ServerSnapshot {
        async let inboxes = client.listInboxes()
        async let open = openThreads()
        async let listed = listedThreads()
        // Silent records too: the copy keeps them, and Handled shows them when the person asks, offline as well.
        async let handled = client.handled(HandledQuery(list: ListQuery(limit: pageSize), includeSilent: true))
        // Records that went wrong or carry a note, from every state: Handled's default page leaves out failed ones.
        async let attention = client.handled(HandledQuery(list: ListQuery(limit: pageSize), attentionOnly: true))
        async let proposals = all { cursor in
            try await client.handled(
                HandledQuery(list: ListQuery(cursor: cursor, limit: pageSize), states: [.proposed]))
        }
        async let drafts = all { cursor in try await client.listDrafts(ListQuery(cursor: cursor, limit: pageSize)) }
        async let brief = client.latestBrief()
        async let counts = client.counts()
        async let aiStatus = client.aiStatus()
        // Person only: a refusal (or a server without it) leaves the stored settings as they are.
        async let aiSettings = try? client.aiSettings()
        // Person only, the same way: an agent's token gets `needs_person`, which leaves the window as it was.
        async let firstSync = try? client.firstSync()

        let inboxList = try await inboxes
        let rules = try await withThrowingTaskGroup(of: (String, [Rule]).self) { group in
            for inbox in inboxList {
                group.addTask { (inbox.id, try await client.listRules(inboxId: inbox.id)) }
            }
            var byInbox: [String: [Rule]] = [:]
            for try await (inboxId, list) in group { byInbox[inboxId] = list }
            return byInbox
        }
        let (openList, openComplete) = try await open
        let (proposalList, proposalsComplete) = try await proposals
        let (draftList, draftsComplete) = try await drafts
        return ServerSnapshot(
            inboxes: inboxList, openThreads: openList, openThreadsComplete: openComplete,
            listedThreads: try await listed, handled: try await handled.items, proposals: proposalList,
            proposalsComplete: proposalsComplete, attention: try await attention.items, drafts: draftList,
            draftsComplete: draftsComplete, rules: rules, brief: try await brief, briefFetched: true,
            counts: try await counts, aiStatus: try await aiStatus, aiSettings: await aiSettings,
            firstSyncWindow: await firstSync)
    }

    /// Every category's threads that aren't done and every screened one; complete only when each list was read to
    /// its end.
    private func openThreads() async throws -> ([MailThread], Bool) {
        var threads: [MailThread] = []
        var complete = true
        for category in Category.known {
            let (items, done) = try await all { cursor in
                try await client.category(category, ListQuery(cursor: cursor, limit: pageSize))
            }
            threads += items
            complete = complete && done
        }
        let (screened, done) = try await all { cursor in
            try await client.screening(ListQuery(cursor: cursor, limit: pageSize))
        }
        return (threads + screened, complete && done)
    }

    /// Home, each stack and waiting.
    private func listedThreads() async throws -> [MailThread] {
        var threads = try await all { cursor in try await client.home(ListQuery(cursor: cursor, limit: pageSize)) }.0
        for stack in Stack.known {
            threads += try await all { cursor in
                try await client.stack(stack, ListQuery(cursor: cursor, limit: pageSize))
            }.0
        }
        threads += try await all { cursor in try await client.waiting(ListQuery(cursor: cursor, limit: pageSize)) }.0
        return threads
    }

    private func all<Item>(_ fetch: @Sendable (String?) async throws -> Page<Item>) async throws -> ([Item], Bool) {
        var items: [Item] = []
        var cursor: String?
        for _ in 0..<maxPages {
            let page = try await fetch(cursor)
            items += page.items
            guard let next = page.nextCursor else { return (items, true) }
            cursor = next
        }
        return (items, false)
    }
}
