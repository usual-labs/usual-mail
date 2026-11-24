import Foundation

extension MailStore {
    /// Changes the server's AI settings: new credentials, models or pause. Person only. It waits for the server and
    /// keeps the settings it answers with; the key goes in the request body only and is never stored on the device. Saving credentials or a model makes the server test them at once, and `ai.status.changed` brings the
    /// outcome. Returns false when the server refused or couldn't be reached (the problem says why, without the key).
    @discardableResult
    public func updateAiSettings(_ patch: AiSettingsPatch) async -> Bool {
        do {
            let settings = try await client.updateAiSettings(patch)
            await write(RefreshKeep()) { try $0.save(aiSettings: settings) }
            await reloadLists()
            return true
        } catch {
            report(error, withoutSecrets: patch.secrets)
            return false
        }
    }

    /// Asks the server to test the AI: one small request per job's model, with no mail in it. Person only. Returns the
    /// status that follows, which is also kept, or nil when the server refused or couldn't be reached.
    @discardableResult
    public func testAi() async -> AiStatus? {
        do {
            let status = try await client.testAi()
            await write(RefreshKeep()) { try $0.save(aiStatus: status) }
            await reloadLists()
            return status
        } catch {
            report(error)
            return nil
        }
    }

    /// Fetches what the server's AI used of the person's account, cut at midnight in `timeZone` (this Mac's, unless a
    /// test says otherwise). Person only: an agent's token gets `needs_person`, which leaves `aiUsage` as it was (nil)
    /// without a problem. There is no event for it; Settings asks again when the AI's status changes.
    public func loadAiUsage(timeZone: TimeZone = .current) async {
        do {
            let usage = try await client.aiUsage(timeZone: timeZone.identifier)
            if usage != aiUsage { aiUsage = usage }
        } catch {
            reportPersonOnly(error)
        }
    }

    /// Reports a failed fetch of something only a person's device gets: an agent's `needs_person` says nothing, nor
    /// does a server that can't be reached.
    func reportPersonOnly(_ error: any Error) {
        if (error as? APIError)?.code == .needsPerson { return }
        report(error, quietlyIfOffline: true)
    }

    /// Reports an error with every secret the person typed taken out of its words.
    private func report(_ error: any Error, withoutSecrets secrets: [String]) {
        report(error)
        if let shown = problem, !secrets.isEmpty {
            problem = Problem(message: Self.withoutSecrets(shown.message, secrets))
        }
    }
}
