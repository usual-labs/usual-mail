import Foundation
import Observation

/// Settings' browser agent for unsubscribing (docs/contract.md, "Unsubscribing"): saving a Browser Use key and removing
/// it, through `PATCH /v1/ai` (`AiSettingsPatch.browserAgent`). An interface shows `BrowserAgentDisclosure` before it
/// offers Save, since saving is the person's yes to it. The server tests a key before it answers, so the settings it
/// answers with, which the store keeps, say whether the key works (`settings.state`).
///
/// The key is used for that one request only: this type never keeps it, and the store keeps it out of any words it
/// shows (`updateAiSettings`). A refusal is said here (`refusal`), in the server's words, instead of over the lists.
@MainActor
@Observable
public final class BrowserAgentSetup {
    /// What is under way.
    public enum Step: Hashable, Sendable {
        case idle, saving, removing
    }

    public private(set) var step = Step.idle
    /// Why the last save or removal didn't go through, in words; nil once one does.
    public private(set) var refusal: String?

    @ObservationIgnored private let store: MailStore

    public init(store: MailStore) {
        self.store = store
    }

    /// The browser agent as the server has it, without its key; nil while none is set up.
    public var settings: BrowserAgentSettings? { store.aiSettings?.browserAgent }

    public var isBusy: Bool { step != .idle }

    /// Saves `key` as the server's Browser Use key, replacing any stored one. True when the server kept it; whether it
    /// works is then `settings.state`.
    @discardableResult
    public func save(key: String) async -> Bool {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isBusy, !key.isEmpty else { return false }
        let patch = AiSettingsPatch(browserAgent: .set(BrowserAgentCredentials(service: .browserUse, apiKey: key)))
        return await send(patch, as: .saving, otherwise: "The key couldn't be saved. Try again.")
    }

    /// Removes the key, so a sender's page is left for the person to open. True when the server removed it.
    @discardableResult
    public func remove() async -> Bool {
        guard !isBusy else { return false }
        return await send(
            AiSettingsPatch(browserAgent: .remove), as: .removing, otherwise: "The key couldn't be removed. Try again.")
    }

    private func send(_ patch: AiSettingsPatch, as step: Step, otherwise: String) async -> Bool {
        self.step = step
        refusal = nil
        defer { self.step = .idle }
        let shown = store.problem?.id
        if await store.updateAiSettings(patch) { return true }
        refusal = takeProblem(since: shown) ?? otherwise
        return false
    }

    /// The store's words for a refusal it reported since `shown`, taken from it, since the setting shows them.
    private func takeProblem(since shown: UUID?) -> String? {
        guard let problem = store.problem, problem.id != shown else { return nil }
        store.dismissProblem()
        return problem.message
    }
}
