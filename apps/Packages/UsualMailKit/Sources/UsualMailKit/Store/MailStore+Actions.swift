import Foundation

extension MailStore {
    /// Does `action` to threads as the person. The threads change on screen at once; the server's answer, which
    /// carries every named thread as it is now, replaces them, and a refusal takes the change back. The server
    /// may answer a correction with a teach prompt.
    public func perform(_ action: ActionInput, on threadIDs: [String], reason: String? = nil) async {
        await act(action, on: threadIDs, reason: reason, asked: true)
    }

    /// Marks a thread read because the person opened it. It shows at once like any action, but it isn't offered
    /// as the last action to undo, asks no teach question, and an unreachable server takes it back quietly. Nothing
    /// is done while `markRead(opening:)` is already marking it.
    func markRead(_ threadID: String) async {
        guard !readsOnTheirWay.contains(threadID) else { return }
        await act(.read, on: [threadID], reason: nil, asked: false)
    }

    /// Marks threads read because the person opened them together: a notification group's row, which stands for every
    /// thread in the group (docs/contract.md, "Notification groups"); or ticked a Notifications row seen. One action for
    /// all of them, done as opening one thread does it: shown at once, not offered to undo, no teach question, taken
    /// back quietly when the server can't be reached. Opening one of them meanwhile (`open(threadID:)`, the row's
    /// newest) doesn't mark it a second time.
    public func markRead(opening threadIDs: [String]) async {
        let ids = threadIDs.filter { !readsOnTheirWay.contains($0) }
        guard !ids.isEmpty else { return }
        readsOnTheirWay.formUnion(ids)
        await act(.read, on: ids, reason: nil, asked: false)
        readsOnTheirWay.subtract(ids)
    }

    /// Marks threads unread again as `markRead(opening:)` marks them read: a Notifications row's seen tick taken back
    /// (owner's words of 2026-11-20). One action for all of them, shown at once, not offered to undo, no teach question,
    /// taken back quietly when the server can't be reached. The row menu's "Mark as unread" is the person's own action
    /// instead (`perform`), with its undo.
    public func markUnread(_ threadIDs: [String]) async {
        await act(.unread, on: threadIDs, reason: nil, asked: false)
    }

    /// `asked` is false for what the app does on the person's behalf, such as marking an opened thread read.
    private func act(_ action: ActionInput, on threadIDs: [String], reason: String?, asked: Bool) async {
        guard !threadIDs.isEmpty else { return }
        let token = UUID()
        var before: [String: ThreadPlacement] = [:]
        var shown: [MailThread] = []
        for id in threadIDs {
            guard let current = await currentThread(id: id) else { continue }
            before[id] = current.placement
            shown.append(pendingThreads.add({ $0.applying(action) }, to: id, current: current, token: token))
        }
        // Letting a sender in or blocking them changes every thread of theirs in that inbox; show it on all of them
        // at once. The server answers with the named threads; the others are confirmed by their events.
        let siblings = await senderSiblings(of: threadIDs, for: action)
        for id in siblings {
            guard let current = await currentThread(id: id) else { continue }
            shown.append(pendingThreads.add({ $0.applying(action) }, to: id, current: current, token: token))
        }
        await save(threads: shown)
        await reloadLists()

        do {
            let result = try await client.act(ActInput(threadIds: threadIDs, action: action, reason: reason))
            let threads = settle(threadIDs + siblings, token: token, with: result.threads)
            let records = result.records.map { pendingRecords.serverSent($0, for: $0.id) }
            for record in records {
                if let placement = before[record.threadId] { undoSnapshots[record.id] = placement }
            }
            await save(threads: threads, actions: records)
            if asked {
                let undoable = records.filter { $0.state == .applied && $0.undoable }
                lastAction = undoable.isEmpty ? nil : RecentAction(action: action, records: undoable)
                show(result.teach)
            }
        } catch {
            let restored = (threadIDs + siblings).compactMap { pendingThreads.refused(token, for: $0) }
            await save(threads: restored)
            report(error, quietlyIfOffline: !asked)
        }
        await reloadLists()
    }

    /// Undoes an applied action. The record shows as undone at once; for the person's own actions the thread
    /// goes back at once too. Undoing a rule's or an agent's action may bring a teach prompt.
    public func undo(_ record: ActionRecord) async {
        let token = UUID()
        let now = clock()
        let shownRecord = pendingRecords.add(
            { record in
                var record = record
                record.state = .undone
                record.undoneAt = now
                record.undoable = false
                return record
            }, to: record.id, current: record, token: token)
        var shownThreads: [MailThread] = []
        if let placement = undoSnapshots[record.id], let current = await currentThread(id: record.threadId) {
            // Undoing a categorize puts the category back and makes the person, who undid it, its decider.
            let recategorized = if case .categorize = record.action { true } else { false }
            shownThreads.append(
                pendingThreads.add(
                    { thread in
                        var thread = thread
                        thread.placement = placement
                        if recategorized {
                            thread.categorizedBy = .person
                            thread.categorizedByActor = nil
                        }
                        return thread
                    }, to: record.threadId, current: current, token: token))
        }
        await save(threads: shownThreads, actions: [shownRecord])
        await reloadLists()

        do {
            let result = try await client.undo(actionId: record.id)
            let records = settle(records: [record.id], token: token, with: result.records)
            let threads = settle([record.threadId], token: token, with: result.threads)
            undoSnapshots[record.id] = nil
            forgetFromLastAction(record.id)
            restoreUnblocked(record.id)
            await save(threads: threads, actions: records)
            show(result.teach)
        } catch {
            let restoredRecord = pendingRecords.refused(token, for: record.id)
            let restoredThread = pendingThreads.refused(token, for: record.threadId)
            await save(threads: [restoredThread].compactMap { $0 }, actions: [restoredRecord].compactMap { $0 })
            report(error)
        }
        await reloadLists()
    }

    /// Undoes the person's last action, on every thread it touched.
    public func undoLastAction() async {
        guard let recent = lastAction else { return }
        lastAction = nil
        for record in recent.records {
            await undo(record)
        }
    }

    /// Says yes to proposals: each shows as applied, and its thread as changed, at once.
    public func approve(_ records: [ActionRecord]) async {
        await answer(records, approving: true)
    }

    /// Says no to proposals: each shows as rejected at once and its thread stays as it is.
    public func reject(_ records: [ActionRecord]) async {
        await answer(records, approving: false)
    }

    /// Answers the teach prompt. Yes creates the rule, which is stored with the inbox's other rules.
    public func answerTeach(accept: Bool) async {
        guard let prompt = teachPrompt else { return }
        teachPrompt = nil
        do {
            if let rule = try await client.answerTeach(id: prompt.id, accept: accept) {
                await write(RefreshKeep(rules: [rule.id])) { try $0.upsert(rules: [rule]) }
                await reloadLists()
            }
        } catch {
            if prompt.expiresAt > clock() { teachPrompt = prompt }
            report(error)
        }
    }

    /// Shows a teach prompt unless it has already expired.
    func show(_ teach: TeachPrompt?) {
        guard let teach, teach.expiresAt > clock() else { return }
        teachPrompt = teach
    }

    private func answer(_ records: [ActionRecord], approving: Bool) async {
        let proposals = records.filter { $0.state == .proposed }
        guard !proposals.isEmpty else { return }
        let token = UUID()
        var shownRecords: [ActionRecord] = []
        var shownThreads: [MailThread] = []
        for record in proposals {
            shownRecords.append(
                pendingRecords.add(
                    { record in
                        var record = record
                        record.state = approving ? .applied : .rejected
                        record.undoable = approving
                        return record
                    }, to: record.id, current: record, token: token))
            if approving, let current = await currentThread(id: record.threadId) {
                // A proposed category keeps its proposer as the decider.
                let (action, source) = (record.action, CategorySource(record.actor))
                shownThreads.append(
                    pendingThreads.add(
                        { $0.applying(action, by: source) }, to: record.threadId, current: current, token: token))
            }
        }
        await save(threads: shownThreads, actions: shownRecords)
        await reloadLists()

        let ids = proposals.map(\.id)
        do {
            let result =
                approving ? try await client.approve(actionIds: ids) : try await client.reject(actionIds: ids)
            let records = settle(records: ids, token: token, with: result.records)
            let threads = settle(proposals.map(\.threadId), token: token, with: result.threads)
            await save(threads: threads, actions: records)
        } catch {
            let restoredRecords = proposals.compactMap { pendingRecords.refused(token, for: $0.id) }
            let restoredThreads = proposals.compactMap { pendingThreads.refused(token, for: $0.threadId) }
            await save(threads: restoredThreads, actions: restoredRecords)
            if (error as? APIError)?.code == .conflict {
                problem = Problem(message: "The thread has changed since this was suggested, so it wasn't applied.")
                await refresh()
            } else {
                report(error)
            }
        }
        await reloadLists()
    }

    /// The server accepted the change with `token` for these threads and answered with `copies`. Returns what to
    /// show: each thread as the server has it, with any other pending change on top, and any copy that had
    /// nothing pending.
    private func settle(_ threadIDs: [String], token: UUID, with copies: [MailThread]) -> [MailThread] {
        var shown: [String: MailThread] = [:]
        for id in threadIDs {
            let copy = copies.first { $0.id == id }
            if let value = pendingThreads.accepted(token, for: id, copy: copy) { shown[id] = value }
        }
        for copy in copies where shown[copy.id] == nil {
            shown[copy.id] = pendingThreads.serverSent(copy, for: copy.id)
        }
        return Array(shown.values)
    }

    private func settle(records ids: [String], token: UUID, with copies: [ActionRecord]) -> [ActionRecord] {
        var shown: [String: ActionRecord] = [:]
        for id in ids {
            let copy = copies.first { $0.id == id }
            if let value = pendingRecords.accepted(token, for: id, copy: copy) { shown[id] = value }
        }
        for copy in copies where shown[copy.id] == nil {
            shown[copy.id] = pendingRecords.serverSent(copy, for: copy.id)
        }
        return Array(shown.values)
    }

    /// The other threads the copy's lists hold from the same sender in the same inbox as `threadIDs`, for letting in
    /// and blocking, which the contract applies to all of them together; none for any other action.
    private func senderSiblings(of threadIDs: [String], for action: ActionInput) async -> [String] {
        guard action == .allowSender || action == .blockSender else { return [] }
        var senders = Set<String>()
        for id in threadIDs {
            if let thread = await currentThread(id: id), let sender = thread.sender {
                senders.insert(Self.senderKey(inboxId: thread.inboxId, sender: sender))
            }
        }
        guard !senders.isEmpty else { return [] }
        let named = Set(threadIDs)
        return lists.everyThread.filter { thread in
            guard !named.contains(thread.id), let sender = thread.sender else { return false }
            return senders.contains(Self.senderKey(inboxId: thread.inboxId, sender: sender))
        }.map(\.id)
    }

    private static func senderKey(inboxId: String, sender: String) -> String {
        "\(inboxId)\u{0}\(sender.lowercased())"
    }

    private func forgetFromLastAction(_ recordID: String) {
        guard var recent = lastAction else { return }
        recent.records.removeAll { $0.id == recordID }
        lastAction = recent.records.isEmpty ? nil : recent
    }
}
