import Foundation

/// Search through the store (docs/contract-search.md): the server's search as the search page asks for it
/// (`SearchModel`), and older mail brought in from the mailbox kept in the copy, so the mail page shows it as any other.
/// Search needs the server: the copy on the device doesn't hold done mail, nor what only the mailbox holds.
extension MailStore: SearchService {
    public func search(_ query: SearchQuery) async throws -> SearchResult {
        do {
            return try await client.search(query)
        } catch {
            noteSearchFailure(error)
            throw error
        }
    }

    public func searchRemote(_ query: SearchQuery) async throws -> RemoteSearchResult {
        do {
            return try await client.searchRemote(query)
        } catch {
            noteSearchFailure(error)
            throw error
        }
    }

    /// Brings a conversation in from the mailbox and keeps it in the copy, as opening a thread keeps its detail, so the
    /// mail page finds it. A done one (archived in the mailbox) is kept too: the copy keeps done threads it holds.
    public func openRemote(id: String) async throws -> ThreadDetail {
        do {
            var detail = try await client.openRemote(id: id)
            let threadID = detail.thread.id
            detail.thread = pendingThreads.serverSent(detail.thread, for: threadID)
            let fetched = detail
            await write(RefreshKeep(threads: [threadID], drafts: Set(fetched.drafts.map(\.id)))) {
                try $0.save(fetched)
            }
            await reloadLists()
            return fetched
        } catch {
            noteSearchFailure(error)
            throw error
        }
    }

    /// A sentence for the server's AI to turn into a search; it searches nothing. In the sample mode, the sample's own
    /// sentences answer (`SampleSearch.ask`).
    public func askSearch(_ input: SearchAskInput) async throws -> SearchAskResult {
        do {
            return try await client.askSearch(input)
        } catch {
            noteSearchFailure(error)
            throw error
        }
    }

    /// A refused token signs out, and an unreachable server shows as offline, as everywhere; any other refusal is the
    /// search page's to put in words, so it raises no problem here.
    private func noteSearchFailure(_ error: any Error) {
        guard let apiError = error as? APIError, apiError.isOffline || apiError.code == .unauthorized else { return }
        report(apiError, quietlyIfOffline: true)
    }
}
