import Foundation

/// The blocked senders (docs/contract.md, "Blocked senders"), for Settings' Blocked tab, and what the server says it is,
/// for its About tab.
extension MailStore {
    /// How many pages of blocked senders a load reads at most, 200 each.
    static let blockedSenderPages = 50

    /// Fetches every blocked sender in every inbox, page by page; the tab filters by profile. `sender.changed` and
    /// `unsubscribe.changed` events that arrive meanwhile are applied on top of the answer, so the newest event still
    /// wins. A person's device only:
    /// `needs_person` and an unreachable server leave the list as it was, quietly. A load asked for while one runs
    /// changes nothing.
    public func loadBlockedSenders() async {
        guard senderChangesWhileLoading == nil else { return }
        senderChangesWhileLoading = []
        defer { senderChangesWhileLoading = nil }
        do {
            var items: [BlockedSender] = []
            var cursor: String?
            for _ in 0..<Self.blockedSenderPages {
                let page = try await client.senders(ListQuery(cursor: cursor, limit: 200))
                items += page.items
                cursor = page.nextCursor
                if cursor == nil { break }
            }
            var list = BlockedSenderList(items)
            for change in senderChangesWhileLoading ?? [] {
                switch change {
                case .sender(let change): list.apply(change)
                case .unsubscribe(let unsubscribe): list.apply(unsubscribe)
                }
            }
            blockedSenders = list
        } catch {
            reportPersonOnly(error)
        }
    }

    /// Unblocks a sender: their row goes at once, then `POST /v1/senders/allow` lets them in. When the server made a
    /// record, the undo strip offers to undo it (`lastAction`, "Unblocked."); when it made none (no thread of theirs
    /// is left), nothing can be undone and the strip doesn't show. A refusal puts the row back and returns its words.
    @discardableResult
    public func unblock(_ sender: BlockedSender) async -> String? {
        blockedSenders?.remove(sender.id)
        do {
            let result = try await client.allowSender(inboxId: sender.inboxId, address: sender.address)
            let records = result.records.map { pendingRecords.serverSent($0, for: $0.id) }
            let threads = result.threads.map { pendingThreads.serverSent($0, for: $0.id) }
            await save(threads: threads, actions: records)
            let undoable = records.filter { $0.state == .applied && $0.undoable }
            for record in undoable { unblockedRows[record.id] = sender }
            lastAction =
                undoable.isEmpty ? nil : RecentAction(action: .allowSender, records: undoable, words: "Unblocked.")
            await reloadLists()
            return nil
        } catch {
            if blockedSenders?.contains(sender.id) == false { blockedSenders?.insert(sender) }
            report(error)
            return (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// `sender.changed`: puts the sender in or takes them out of the list, once it is loaded; while it loads, the
    /// change waits for the answer.
    func apply(_ change: SenderChange) {
        senderChangesWhileLoading?.append(.sender(change))
        blockedSenders?.apply(change)
    }

    /// `unsubscribe.changed`, or the answer to asking: the sender's row shows it, once the list is loaded (kept for a
    /// row still to come); while it loads, it waits for the answer. Before the list is loaded there is nothing to
    /// keep: the load brings each sender's newest.
    func apply(_ unsubscribe: Unsubscribe) {
        senderChangesWhileLoading?.append(.unsubscribe(unsubscribe))
        blockedSenders?.apply(unsubscribe)
    }

    /// After undoing an unblock: the row comes back at once, unless an event has already put the sender back as they
    /// are now.
    func restoreUnblocked(_ recordID: String) {
        guard let sender = unblockedRows.removeValue(forKey: recordID) else { return }
        if blockedSenders?.contains(sender.id) == false { blockedSenders?.insert(sender) }
    }

    /// Asks the server what it is (`GET /v1/info`, no token needed): its version and API version. Quiet when it can't
    /// be reached; the last answer stays.
    public func loadServerInfo() async {
        guard !isSample else { return }
        if let info = try? await client.info() { serverInfo = info }
    }
}

/// What changes the blocked senders while they load: `sender.changed`, or an unsubscribe moving on.
enum BlockedSenderChange: Sendable {
    case sender(SenderChange)
    case unsubscribe(Unsubscribe)
}
