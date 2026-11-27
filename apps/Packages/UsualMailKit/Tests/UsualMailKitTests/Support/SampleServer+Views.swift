import Foundation

@testable import UsualMailKit

/// The stand-in server's lists, Handled, inboxes, the AI's settings and usage and the first sync's window, as
/// docs/contract.md and its pages define them.
extension SampleServer {
    /// A thread list as the contract orders it: no trashed threads, newest first, equal times by id descending.
    func listed(_ threads: [MailThread]) -> [MailThread] {
        threads.filter { !$0.trashed }.sorted { ($0.lastMessageAt, $0.id) > ($1.lastMessageAt, $1.id) }
    }

    /// The threads in the query's inbox, or all, that hold `condition`.
    func threads(_ query: [String: String], _ condition: (MailThread) -> Bool) -> [MailThread] {
        data.threads.filter { (query["inboxId"] == nil || $0.inboxId == query["inboxId"]) && condition($0) }
    }

    /// Home: conversation and unknown threads that are let in, not done, on no stack and not waiting, by the later of
    /// the last message and a come-back time that has passed.
    func home(_ query: [String: String] = [:]) -> [MailThread] {
        let now = data.now
        return threads(query) { thread in
            [.conversation, .uncategorized].contains(thread.category) && !thread.screened && !thread.done
                && thread.stack == nil && !thread.trashed && !thread.isWaiting(at: now)
        }
        .sorted { a, b in
            (max(a.lastMessageAt, a.comeBackAt ?? .distantPast), a.id)
                > (max(b.lastMessageAt, b.comeBackAt ?? .distantPast), b.id)
        }
    }

    func page(_ items: [MailThread], _ query: [String: String]) -> Page<MailThread> {
        paged(items, cursor: query["cursor"], limit: query["limit"].flatMap { Int($0) })
    }

    /// One page of `items`: the cursor is an opaque offset here; the default limit is the contract's 50.
    func paged<Item>(_ items: [Item], cursor: String?, limit: Int?) -> Page<Item> {
        let start = min(cursor.flatMap { Int($0.dropFirst("page-".count)) } ?? 0, items.count)
        let end = min(start + (limit ?? 50), items.count)
        return Page(items: Array(items[start..<end]), nextCursor: end < items.count ? "page-\(end)" : nil)
    }

    /// Rules', agents' and the AI's records in `states`, each with its thread, trashed or not; silent ones only when
    /// asked; with `attentionOnly`, only those that failed or carry an error or a note, whoever made them.
    func handled(states: [ActionState], includeSilent: Bool, attentionOnly: Bool) -> [HandledItem] {
        data.handledItems
            .filter { attentionOnly || ["rule", "agent", "ai"].contains($0.record.actor.kind) }
            .filter { states.contains($0.record.state) }
            .filter { includeSilent || !$0.record.silent }
            .filter { !attentionOnly || $0.record.needsALook }
            .sorted { ($0.record.at, $0.record.id) > ($1.record.at, $1.record.id) }
    }

    func paused(_ inboxId: String?) -> Bool {
        data.inboxes.first { $0.id == inboxId }?.status == .paused
    }

    /// Who wrote the newest incoming message of a thread: its sender.
    static func sender(of threadId: String, in data: SampleData) -> String? {
        data.messages.filter { $0.threadId == threadId && !$0.outgoing }.max { $0.date < $1.date }?.from.email
    }

    /// Applies a settings patch as the contract says: credentials replace the stored ones (only whether they are set
    /// and the connection come back), `null` removes them, models and the rest change as named. A browser agent's key
    /// is tested at once and answered with `browserAgentTest` (working, unless a test says otherwise), never the key;
    /// `null` removes it.
    func updateAi(_ patch: JSONValue) -> AiSettings {
        state.withLock { state in
            state.aiPatch = patch
            var ai = state.data.ai
            switch patch["credentials"] {
            case .null?:
                ai.credentialsSet = false
                ai.connection = nil
            case let credentials?:
                ai.credentialsSet = true
                var shown = credentials
                if case .object(var fields) = credentials {
                    fields["apiKey"] = nil
                    shown = .object(fields)
                }
                ai.connection = try? MailJSON.decoder().decode(
                    AiConnection.self, from: MailJSON.encoder().encode(shown))
            case nil: break
            }
            if case .object(let models)? = patch["models"] {
                for (job, model) in models {
                    guard let index = ai.jobs.firstIndex(where: { $0.job.rawValue == job }) else { continue }
                    ai.jobs[index].model = model.stringValue
                }
            }
            if case .bool(let paused)? = patch["paused"] { ai.paused = paused }
            switch patch["browserAgent"] {
            case .null?: ai.browserAgent = nil
            case .some: ai.browserAgent = state.browserAgentTest
            case nil: break
            }
            ai.version += 1
            state.data.ai = ai
            return ai
        }
    }

    /// The sample's usage, cut in the time zone asked for (`UTC` without one); `invalid` for a zone that isn't one.
    func usage(timeZone: String?) -> StubReply {
        let zone = timeZone ?? "UTC"
        guard TimeZone(identifier: zone) != nil else { return .error("invalid", "No time zone \(zone)", status: 400) }
        var usage = data.aiUsage
        usage.timeZone = zone
        return .json(usage)
    }

    /// Applies a first-sync patch as the contract says: whole days from 1 to the most, else `invalid`; `conflict`
    /// while the window isn't changeable; the same number changes nothing.
    func updateFirstSync(_ patch: JSONValue) -> StubReply {
        state.withLock { state in
            guard state.data.firstSync.changeable else {
                return .error("conflict", "The first sync's window is set where the server runs", status: 409)
            }
            guard case .number(let value)? = patch["days"], value == value.rounded(),
                (1...Double(FirstSyncWindow.maxDays)).contains(value)
            else { return .error("invalid", "Days must be a whole number from 1 to 36500", status: 400) }
            state.data.firstSync.days = Int(value)
            state.data.firstSync.setBy = .settings
            return .json(state.data.firstSync)
        }
    }

    /// Applies an inbox patch as the contract says. New credentials (taken as good here) replace the connection and
    /// make the inbox `connecting` until its next good sync; a paused inbox stays paused. Resuming makes it
    /// `connecting` too.
    func updateInbox(_ id: String, _ patch: InboxPatch) -> Inbox? {
        state.withLock { state in
            guard let index = state.data.inboxes.firstIndex(where: { $0.id == id }) else { return nil }
            var inbox = state.data.inboxes[index]
            inbox.name = patch.name ?? inbox.name
            inbox.color = patch.color ?? inbox.color
            inbox.trust = patch.trust ?? inbox.trust
            inbox.guide = patch.guide ?? inbox.guide
            inbox.agentAccess = patch.agentAccess ?? inbox.agentAccess
            inbox.icon = patch.icon ?? inbox.icon
            let wasPaused = inbox.status == .paused
            if let paused = patch.paused, paused != wasPaused {
                inbox.status = paused ? .paused : .connecting
                inbox.statusDetail = nil
            }
            if let credentials = patch.credentials {
                state.credentials[id] = credentials
                inbox.connection = Self.connection(of: credentials, kind: inbox.provider) ?? inbox.connection
                if inbox.status != .paused {
                    inbox.status = .connecting
                    inbox.statusDetail = nil
                }
            }
            inbox.version += 1
            state.data.inboxes[index] = inbox
            if let position = patch.position {
                // Moves it there and renumbers the others, raising the version of each that moved.
                var ordered = state.data.inboxes.sorted { $0.position < $1.position }
                ordered.removeAll { $0.id == id }
                ordered.insert(inbox, at: min(max(position, 0), ordered.count))
                for (place, var moved) in ordered.enumerated() where moved.position != place {
                    moved.position = place
                    if moved.id != id { moved.version += 1 }
                    ordered[place] = moved
                }
                state.data.inboxes = ordered
                return ordered.first { $0.id == id }!
            }
            return inbox
        }
    }

    /// What a provider would say of credentials that isn't secret, as `MailProvider.connection()` does.
    static func connection(of credentials: JSONValue, kind: ProviderKind) -> InboxConnection? {
        func login(_ value: JSONValue?) -> ServerLogin? {
            guard let value, let host = value["host"]?.stringValue, case .number(let port) = value["port"],
                case .bool(let secure) = value["secure"], let user = value["user"]?.stringValue
            else { return nil }
            return ServerLogin(host: host, port: Int(port), secure: secure, user: user)
        }
        switch kind {
        case .imap:
            guard let imap = login(credentials["imap"]), let smtp = login(credentials["smtp"]) else { return nil }
            let saveSent: Bool = if case .bool(let value) = credentials["saveSent"] { value } else { true }
            return .imap(imap: imap, smtp: smtp, saveSent: saveSent)
        case .gmail: return credentials["clientId"]?.stringValue.map { .gmail(clientId: $0) }
        case .unknown: return nil
        }
    }
}
