import Foundation

extension MailStore {
    /// Applies a server event at once. A copy older than the stored one is ignored, so events and a refresh may
    /// arrive in any order.
    public func receive(_ event: MailEvent) async {
        switch event {
        case .inboxChanged(let inbox):
            await write(RefreshKeep(inboxes: [inbox.id])) { try $0.upsert(inboxes: [inbox]) }
        case .inboxRemoved(let inboxId):
            await write(RefreshKeep(inboxes: [inboxId])) { try $0.deleteInbox(id: inboxId) }
            triagePending[inboxId] = nil
        case .threadChanged(let thread):
            // A newer copy of the open thread: its messages, and their sender pictures, come only with its detail.
            let stored = try? await local.thread(id: thread.id)
            let refetch = openThreadID == thread.id && thread.version > (stored?.version ?? 0)
            let shown = pendingThreads.serverSent(thread, for: thread.id)
            await write(RefreshKeep(threads: [thread.id])) { try $0.upsert(threads: [shown]) }
            if refetch {
                let threadID = thread.id
                Task { await self.reloadOpenThread(threadID) }
            }
        case .threadRemoved(let threadId, _):
            pendingThreads.forget(threadId)
            // Its records leave Handled with it (docs/contract.md, "Lists").
            await write(RefreshKeep(threads: [threadId])) { try $0.removeThread(id: threadId) }
            if openThreadID == threadId { await open(threadID: nil) }
        case .actionRecorded(let record):
            let shown = pendingRecords.serverSent(record, for: record.id)
            await write(RefreshKeep(records: [record.id])) { try $0.upsert(actions: [shown]) }
            // Handled shows a record with its thread; fetch a thread this device hasn't seen.
            if (try? await local.thread(id: record.threadId)) == nil {
                let threadID = record.threadId
                Task { await self.fetchThread(threadID) }
            }
        case .draftChanged(let draft):
            // A sent draft without a note goes at once: the server doesn't keep it, and `draft.removed` follows.
            await write(RefreshKeep(drafts: [draft.id])) { try $0.upsert(drafts: [draft]) }
        case .draftRemoved(let draftId, _):
            // A sent draft's note at the end of its day, or a draft deleted or sent elsewhere.
            await write(RefreshKeep(drafts: [draftId])) { try $0.deleteDraft(id: draftId) }
        case .ruleChanged(let rule):
            await write(RefreshKeep(rules: [rule.id])) { try $0.upsert(rules: [rule]) }
        case .ruleRemoved(let ruleId, _):
            await write(RefreshKeep(rules: [ruleId])) { try $0.deleteRule(id: ruleId) }
        case .triagePending(let inboxId, let count):
            triagePending[inboxId] = count
        case .countsChanged(let counts):
            await write(RefreshKeep()) { try $0.save(counts: counts) }
        case .aiStatusChanged(let status):
            await write(RefreshKeep()) { try $0.save(aiStatus: status) }
        case .aiSettingsChanged(let settings):
            await write(RefreshKeep()) { try $0.save(aiSettings: settings) }
        case .briefReady(let briefId):
            Task { await self.fetchBrief(briefId) }
        case .senderChanged(let change):
            apply(change)
            return
        case .unsubscribeChanged(let unsubscribe):
            apply(unsubscribe)
            return
        case .unknown:
            break
        }
        await reloadLists()
    }

    /// Fetches and stores a thread the copy doesn't have.
    func fetchThread(_ id: String) async {
        do {
            let detail = try await client.thread(id: id)
            let thread = pendingThreads.serverSent(detail.thread, for: id)
            await write(RefreshKeep(threads: [id])) { try $0.upsert(threads: [thread]) }
            await reloadLists()
        } catch {
            report(error, quietlyIfOffline: true)
        }
    }

    /// Fetches and stores a new brief.
    func fetchBrief(_ id: String) async {
        do {
            let brief = try await client.brief(id: id)
            await write(RefreshKeep(brief: true)) { try $0.save(brief: brief) }
            await reloadLists()
        } catch {
            report(error, quietlyIfOffline: true)
        }
    }
}
