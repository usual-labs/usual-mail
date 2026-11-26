import Foundation

/// What became of new credentials for an inbox.
public enum CredentialsAnswer: Hashable, Sendable {
    /// The provider took them and the server keeps them. The inbox is `connecting` until its next good sync, or
    /// stays `paused` if it was, and connects once resumed.
    case saved(Inbox)
    /// Nothing changed. What to show: the provider's words when it refused them, the server's when they are for
    /// another mailbox, or why the server couldn't be asked. No secret that was typed is in it.
    case refused(String)
}

extension MailStore {
    /// Changes an inbox's settings: its guide, trust, agent access and so on. It waits for the server and keeps the
    /// inbox it answers with, whose version is higher, so nothing older replaces it. Returns false when the server
    /// refused or couldn't be reached (the problem says why); the inbox stays as it was.
    @discardableResult
    public func updateInbox(_ inboxId: String, _ patch: InboxPatch) async -> Bool {
        do {
            let inbox = try await client.updateInbox(id: inboxId, patch: patch)
            await write(RefreshKeep(inboxes: [inbox.id])) { try $0.upsert(inboxes: [inbox]) }
            await reloadLists()
            return true
        } catch {
            report(error)
            return false
        }
    }

    /// Turns a rule on or off. Only a person may turn a rule on, and this device is a person's: turning on an
    /// agent's rule accepts its suggestion. Waits for the server and keeps its answer.
    @discardableResult
    public func setRule(_ rule: Rule, enabled: Bool) async -> Bool {
        do {
            let updated = try await client.updateRule(id: rule.id, patch: RulePatch(enabled: enabled))
            await write(RefreshKeep(rules: [updated.id])) { try $0.upsert(rules: [updated]) }
            await reloadLists()
            return true
        } catch {
            report(error)
            return false
        }
    }

    /// Deletes a rule, for example an agent's suggestion the person turns down. It can't be undone.
    @discardableResult
    public func deleteRule(_ rule: Rule) async -> Bool {
        do {
            try await client.deleteRule(id: rule.id)
        } catch let error as APIError where error.code == .notFound {
            // Already gone on the server.
        } catch {
            report(error)
            return false
        }
        let id = rule.id
        await write(RefreshKeep(rules: [id])) { try $0.deleteRule(id: id) }
        await reloadLists()
        return true
    }

    /// Checking for new mail, as pulling a list down does on the iPhone: asks the server to sync `inboxId`, or every
    /// inbox when nil, from the mailbox now, and fetches everything again (`refresh`) meanwhile, not after: the syncs
    /// only queue the work, and what they find comes as events. A paused inbox isn't asked (the server reads nothing
    /// from its mailbox). The refresh runs in a task of its own, so leaving the list mid-pull, which cancels the pull,
    /// doesn't cancel a refresh another caller's has joined (`refresh` runs once for overlapping calls; one already
    /// running when the pull starts makes the pull end at once, and runs again for it).
    ///
    /// Returns why the server couldn't be reached, when it couldn't (the refresh or a sync went offline), and says so
    /// in `problem` too, so a pull never ends without a word; nil otherwise. A sync the server refused (a `conflict` for
    /// an inbox paused meanwhile, an error) is said nowhere: the refresh brings the inbox's state.
    @discardableResult
    public func checkForMail(inboxId: String? = nil) async -> String? {
        let asked = lists.inboxes.filter { ($0.id == inboxId || inboxId == nil) && $0.status != .paused }.map(\.id)
        async let offline = Self.askToSync(asked, client: client)
        await Task { await refresh() }.value
        let reason: String
        if case .offline(let words) = connection {
            // Leaving the scope cancels the syncs still waiting on an unreachable server.
            reason = words
        } else if let words = await offline {
            reason = words
        } else {
            return nil
        }
        problem = Problem(message: reason)
        return reason
    }

    /// Asks the server to sync each inbox, all at once; the words of the first that couldn't reach it, if any.
    private nonisolated static func askToSync(_ ids: [String], client: APIClient) async -> String? {
        await withTaskGroup(of: String?.self) { group in
            for id in ids {
                group.addTask {
                    do {
                        try await client.syncInbox(id: id)
                        return nil
                    } catch let error as APIError where error.isOffline {
                        return error.message
                    } catch {
                        return nil
                    }
                }
            }
            for await words in group {
                if let words {
                    group.cancelAll()
                    return words
                }
            }
            return nil
        }
    }

    /// Gives an inbox new credentials, in place: its mail, rules and history stay. Person only. They replace the
    /// stored ones whole, so they carry what the form showed from `Inbox.connection` as well as the secrets. The server
    /// checks them with the provider before it keeps them, and nothing changes if the provider refuses. The answer is
    /// for the form to show, so no problem is raised; a refused token still signs out.
    public func changeCredentials(_ inboxId: String, to credentials: InboxCredentials) async -> CredentialsAnswer {
        do {
            let inbox = try await client.updateInbox(id: inboxId, patch: InboxPatch(credentials: try credentials.json))
            await write(RefreshKeep(inboxes: [inbox.id])) { try $0.upsert(inboxes: [inbox]) }
            await reloadLists()
            return .saved(inbox)
        } catch {
            if let apiError = error as? APIError {
                if apiError.code == .unauthorized { onUnauthorized?() }
                if apiError.isOffline { connection = .offline(apiError.message) }
            }
            let words = (error as? APIError)?.message ?? error.localizedDescription
            return .refused(Self.withoutSecrets(words, credentials.secrets))
        }
    }

    /// Takes every secret the person typed out of words about to be shown, whatever the provider said.
    nonisolated static func withoutSecrets(_ words: String, _ secrets: [String]) -> String {
        secrets.filter { $0.count >= 4 }.reduce(words) { $0.replacingOccurrences(of: $1, with: "•••") }
    }

    /// The inbox's page in the server's web dashboard (`DASHBOARD_PATHS.inbox` in core: `/inboxes/<id>` under the
    /// server's root, the id percent-encoded). It shows the inbox's state, connection, trust, agent access and guide.
    public func dashboardURL(inboxId: String) -> URL {
        client.server.url("/inboxes/\(APIClient.segment(inboxId))")
    }
}
