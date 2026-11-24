import Foundation

extension MailStore {
    /// Saves a draft, new or changed, and keeps the server's copy. Returns it, or nil if the server refused (the
    /// problem says why).
    @discardableResult
    public func saveDraft(_ input: DraftInput) async -> Draft? {
        do {
            let draft = try await client.saveDraft(input)
            await store(draft)
            return draft
        } catch {
            report(error)
            return nil
        }
    }

    /// Saves the draft, then sends it. Returns the draft as the server answers: `sent` (with a `note` when the
    /// provider added one), `sending`, or `failed` with its `error`. A refused send is not an error: the draft comes
    /// back failed and stays, with the reason, in its thread and among the drafts. Nil means the draft couldn't be
    /// saved or the server couldn't be asked.
    @discardableResult
    public func send(_ input: DraftInput) async -> Draft? {
        guard let saved = await saveDraft(input) else { return nil }
        return await send(draftID: saved.id)
    }

    /// Sends a saved draft. See `send(_:)`. A paused inbox sends nothing; the server answers `conflict`, which the
    /// problem says in words.
    @discardableResult
    public func send(draftID: String) async -> Draft? {
        do {
            let draft = try await client.sendDraft(id: draftID)
            await store(draft)
            return draft
        } catch {
            let inboxId = try? await local.draft(id: draftID)?.inboxId
            report(error, inboxId: inboxId, ifPaused: .sending)
            return nil
        }
    }

    /// Deletes a draft. Returns false if the server refused.
    @discardableResult
    public func deleteDraft(_ draft: Draft) async -> Bool {
        do {
            try await client.deleteDraft(id: draft.id)
        } catch let error as APIError where error.code == .notFound {
            // Already gone on the server.
        } catch {
            report(error)
            return false
        }
        let id = draft.id
        await write(RefreshKeep(drafts: [id])) { try $0.deleteDraft(id: id) }
        await reloadLists()
        return true
    }

    /// Keeps the server's copy. A sent draft without a note goes at once, as the server doesn't keep it; one with a
    /// note stays in its thread for a day.
    private func store(_ draft: Draft) async {
        await write(RefreshKeep(drafts: [draft.id])) { try $0.upsert(drafts: [draft]) }
        await reloadLists()
    }
}
