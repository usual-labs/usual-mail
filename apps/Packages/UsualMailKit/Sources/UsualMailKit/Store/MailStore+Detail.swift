import Foundation

extension MailStore {
    /// A thread with its messages, only to look at (the feed shows each newsletter's mail this way): the server's copy,
    /// stored on the device as `open` stores it, so the lists stay right, or the device's own copy when the server
    /// can't be asked. Unlike `open`, it never marks the thread read and leaves `openThreadID` and `openThread` alone.
    /// A failure raises no problem, since nobody asked for this thread; a lost connection or token still shows.
    public func detail(threadID: String) async -> ThreadDetail? {
        let stored = try? await local.detail(threadId: threadID)
        do {
            var detail = try await client.thread(id: threadID)
            detail.thread = pendingThreads.serverSent(detail.thread, for: threadID)
            let fetched = detail
            await write(RefreshKeep(threads: [threadID], drafts: Set(detail.drafts.map(\.id)))) {
                try $0.save(fetched)
            }
            // The lists read threads and drafts, not messages: reload them only when one of those changed.
            if stored?.thread != fetched.thread || stored?.drafts != fetched.drafts { await reloadLists() }
            return fetched
        } catch {
            if let apiError = error as? APIError, apiError.isOffline || apiError.code == .unauthorized {
                report(apiError, quietlyIfOffline: true)
            }
            return stored
        }
    }

    /// Fetches the open thread's detail again after a newer copy of it arrived (`thread.changed`), as `open` does but
    /// without marking it read: its messages, and their sender pictures, come only with the detail. Nothing happens
    /// once the thread is closed; failing quietly, as `detail(threadID:)` does, leaves the copy shown.
    func reloadOpenThread(_ threadID: String) async {
        guard openThreadID == threadID, await detail(threadID: threadID) != nil, openThreadID == threadID,
            let stored = try? await local.detail(threadId: threadID)
        else { return }
        openThread = stored
    }
}
