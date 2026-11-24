import Foundation

/// Older mail in the mailbox for one query (docs/contract-search.md, "Older mail in the mailbox"): asked for only on a
/// button, never as the person types, and shown as its own section after the local results.
public struct RemoteSection: Hashable, Sendable {
    public enum Status: Hashable, Sendable {
        /// Not asked yet: the button shows.
        case offered
        case searching
        case answered
        /// The search failed as a whole, in words; the button offers it again.
        case failed(String)
    }

    public var status = Status.offered
    /// Every page loaded so far, newest first per page, each once.
    public var hits: [RemoteHit] = []
    /// How each inbox answered the first page, in the inbox list's order.
    public var inboxes: [RemoteInboxState] = []
    public var nextCursor: String?
    public var isLoadingMore = false
    /// The hit being brought in, if one is.
    public var opening: String?
    /// Why opening a hit failed, by its id.
    public var problems: [String: String] = [:]

    public init() {}
}

extension SearchModel {
    /// The inboxes older mail is searched in: the profile's, or every inbox, less those whose mailbox can't be
    /// searched: an IMAP inbox (the contract's `unsupported`, "IMAP for now") or one that answered `unsupported`.
    public var remoteScope: [String] {
        let candidates = scope.map { [$0] } ?? inboxes.map(\.id)
        return candidates.filter { id in
            !unsupported.contains(id) && inboxes.first { $0.id == id }?.provider != .imap
        }
    }

    /// Whether the button shows: there is a query and an inbox whose mailbox can be searched.
    public var offersRemote: Bool {
        requested != nil && !remoteScope.isEmpty
    }

    /// Whether remote search and opening wait at `now`, after the server said too many were asked.
    public func remoteWaits(at now: Date) -> Bool {
        remoteWaitsUntil.map { $0 > now } ?? false
    }

    /// The button: the current query sent to the mailboxes in `remoteScope`, the first page. Nothing happens while one
    /// runs, while the server asks to wait, or with nothing to search. Returns the search, for tests.
    @discardableResult
    public func searchRemote() -> Task<Void, Never>? {
        guard var query = requested, offersRemote, remote.status != .searching, !remoteWaits(at: clock()),
            let service
        else { return nil }
        let inboxIds = remoteScope
        query.filters.inboxIds = scope == nil && inboxIds.count == inboxes.count ? nil : inboxIds
        remote = RemoteSection()
        remote.status = .searching
        remoteQuery = query
        let current = generation
        return Task {
            do {
                let result = try await service.searchRemote(query)
                guard current == generation else { return }
                for state in result.inboxes where state.state == .unsupported { unsupported.insert(state.inboxId) }
                remote.hits = result.items
                remote.inboxes = result.inboxes
                remote.nextCursor = result.nextCursor
                remote.status = .answered
            } catch {
                guard current == generation, !(error is CancellationError) else { return }
                if let seconds = Self.waitSeconds(error) {
                    waitForRemote(seconds)
                    remote.status = .offered
                } else {
                    remote.status = .failed(Self.words(for: error))
                }
            }
        }
    }

    /// More older mail, on a button (each page is a search of the mailbox, which is limited). Returns the loading, for
    /// tests.
    @discardableResult
    public func loadMoreRemote() -> Task<Void, Never>? {
        guard remote.status == .answered, let cursor = remote.nextCursor, !remote.isLoadingMore,
            !remoteWaits(at: clock()), let query = remoteQuery, let service
        else { return nil }
        remote.isLoadingMore = true
        let current = generation
        return Task {
            defer { if current == generation { remote.isLoadingMore = false } }
            do {
                let page = try await service.searchRemote(query.continuing(at: cursor))
                guard current == generation else { return }
                let known = Set(remote.hits.map(\.id))
                remote.hits += page.items.filter { !known.contains($0.id) }
                remote.nextCursor = page.nextCursor
            } catch {
                guard current == generation, let seconds = Self.waitSeconds(error) else { return }
                waitForRemote(seconds)
            }
        }
    }

    /// Brings a hit in from the mailbox (`openRemote`) and answers its thread's id, for the mail page to show; nil when
    /// it couldn't, the reason then in `remote.problems`. Opening the same hit again answers the same thread.
    public func open(_ hit: RemoteHit) async -> String? {
        guard remote.opening == nil, !remoteWaits(at: clock()), let service else { return nil }
        remote.opening = hit.id
        remote.problems[hit.id] = nil
        defer { if remote.opening == hit.id { remote.opening = nil } }
        do {
            return try await service.openRemote(id: hit.id).thread.id
        } catch {
            if error is CancellationError { return nil }
            if let seconds = Self.waitSeconds(error) { waitForRemote(seconds) }
            remote.problems[hit.id] = Self.words(for: error)
            return nil
        }
    }

    /// Waits as long as the server said (`Retry-After`), then offers remote search again.
    func waitForRemote(_ seconds: Int) {
        let until = clock().addingTimeInterval(TimeInterval(seconds))
        remoteWaitsUntil = until
        waiting?.cancel()
        let sleep = self.sleep
        waiting = Task {
            do { try await sleep(.seconds(seconds)) } catch { return }
            if remoteWaitsUntil == until { remoteWaitsUntil = nil }
        }
    }

    /// The seconds to wait after `rate_limited`: its `Retry-After`, or a minute (the limit is per minute) without one.
    static func waitSeconds(_ error: any Error) -> Int? {
        guard let apiError = error as? APIError, apiError.code == .rateLimited else { return nil }
        return max(1, apiError.retryAfter ?? 60)
    }
}
