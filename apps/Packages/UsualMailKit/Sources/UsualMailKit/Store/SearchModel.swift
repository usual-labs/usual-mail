import Foundation
import Observation

/// Where a search's answers come from: the store (the server, and the copy for a conversation it brings in), or a
/// stand-in in tests.
@MainActor
public protocol SearchService: AnyObject {
    /// `GET /v1/search`.
    func search(_ query: SearchQuery) async throws -> SearchResult
    /// `GET /v1/search/remote`.
    func searchRemote(_ query: SearchQuery) async throws -> RemoteSearchResult
    /// `POST /v1/search/remote/:id/open`, kept on the device so the mail page can show it.
    func openRemote(id: String) async throws -> ThreadDetail
    /// `POST /v1/search/ask`: a sentence turned into a search by the server's AI.
    func askSearch(_ input: SearchAskInput) async throws -> SearchAskResult
}

/// The search page's state, without a view (docs/contract-search.md): what is typed and chosen, the newest answer, the
/// next page, older mail in the mailbox (SearchModel+Remote.swift), and a search asked in a sentence
/// (SearchModel+Ask.swift).
///
/// - **As the person types** it waits `debounce` (about 150 ms) after the last change, cancels the request before, and
///   shows only the newest answer: an answer for anything but the latest query is dropped.
/// - **Text starts at two characters** (a one-letter word matches only whole); shorter text is sent only as nothing,
///   so filters alone still search. The text goes as typed, operators included: the server reads them, and says what
///   it understood. A finished operator it took then moves into a chip (`SearchText.settle`).
/// - **The scope** is the profile: one inbox (`inboxIds`), or nil for every inbox. The time zone goes with every
///   search, for typed dates.
@MainActor
@Observable
public final class SearchModel {
    /// What a search shows, as a whole.
    public enum Phase: Hashable, Sendable {
        /// Nothing to search: no text of two characters or more and no filter.
        case idle
        /// Asked, and no answer for it yet; the answer before stays on screen meanwhile.
        case searching
        case answered
        /// The search failed, in words.
        case failed(String)
    }

    /// What the person typed, operators included.
    public var text = "" {
        didSet { if text != oldValue, !batching { changed(typing: true) } }
    }
    /// The filters chosen: kinds by their chips, `from` by a person, and operators once settled. Never `inboxIds`: that
    /// is `scope`.
    public internal(set) var filters = SearchFilters()
    /// The profile: one inbox, or nil for every inbox.
    public var scope: String? {
        didSet { if scope != oldValue, !batching { changed(typing: false) } }
    }
    /// The inboxes, in the profile switch's order: which can be searched for older mail, and their names.
    public var inboxes: [Inbox] = []
    /// The person chosen from People, so their chip can carry their name.
    public internal(set) var chosenPerson: SearchPerson?

    public internal(set) var phase = Phase.idle
    /// The newest answer's threads, every page loaded so far, each once.
    public internal(set) var hits: [SearchHit] = []
    /// The newest answer's people, from its first page.
    public internal(set) var people: [SearchPerson] = []
    /// What the server understood of the newest answer's query.
    public internal(set) var understood: SearchUnderstood?
    /// Where the next page starts; nil on the last.
    public internal(set) var nextCursor: String?
    public internal(set) var isLoadingMore = false
    /// Older mail in the mailbox, asked for on a button, for the current query.
    public internal(set) var remote = RemoteSection()
    /// Until when remote search and opening wait, after the server said too many were asked (`Retry-After`).
    public internal(set) var remoteWaitsUntil: Date?

    /// Where answers come from; the page sets the store.
    @ObservationIgnored public weak var service: (any SearchService)?
    @ObservationIgnored let debounce: Duration
    @ObservationIgnored let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored let timeZone: @Sendable () -> String
    @ObservationIgnored let clock: @Sendable () -> Date
    /// The search being typed or run, cancelled by the next.
    @ObservationIgnored var running: Task<Void, Never>?
    /// Rises with every new query; an answer for an older one is dropped.
    @ObservationIgnored var generation = 0
    /// The latest query asked for (or settled to), without a cursor: nil when there is nothing to search.
    @ObservationIgnored public internal(set) var requested: SearchQuery?
    /// Several changes made as one, searched once.
    @ObservationIgnored var batching = false
    /// Inboxes that answered `unsupported`: their mailbox can't be searched, so the button leaves them out.
    @ObservationIgnored var unsupported: Set<String> = []
    @ObservationIgnored var remoteQuery: SearchQuery?
    @ObservationIgnored var waiting: Task<Void, Never>?

    /// True while a sentence is with the server's AI (`ask()`); any change the person makes cancels it.
    public internal(set) var isAsking = false
    /// What came of the latest sentence asked, until the person changes the search.
    public internal(set) var askOutcome: SearchAskOutcome?
    /// Until when Ask waits, after the server said too many sentences were asked (`Retry-After`).
    public internal(set) var askWaitsUntil: Date?
    /// The sentence on its way to the server.
    @ObservationIgnored var asking: Task<Void, Never>?
    @ObservationIgnored var askWaiting: Task<Void, Never>?

    /// Text shorter than this isn't sent (a one-letter word matches only whole, so results would jump).
    public nonisolated static let minimumText = 2

    public init(
        service: (any SearchService)? = nil, debounce: Duration = .milliseconds(150),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        timeZone: @escaping @Sendable () -> String = { TimeZone.current.identifier },
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.debounce = debounce
        self.sleep = sleep
        self.timeZone = timeZone
        self.clock = clock
    }

    /// The query for what is typed and chosen in a scope: the text when it has two characters or more, the filters,
    /// the inbox, the time zone. Nil when there is nothing to search.
    public nonisolated static func query(text: String, filters: SearchFilters, scope: String?, timeZone: String)
        -> SearchQuery?
    {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = trimmed.count >= minimumText ? trimmed : nil
        var filters = filters
        filters.inboxIds = nil
        if filters.kinds?.isEmpty == true { filters.kinds = nil }
        guard words != nil || !filters.isEmpty else { return nil }
        filters.inboxIds = scope.map { [$0] }
        return SearchQuery(text: words, filters: filters, timeZone: timeZone)
    }

    /// The query for what is shown now.
    public var currentQuery: SearchQuery? {
        Self.query(text: text, filters: filters, scope: scope, timeZone: timeZone())
    }

    /// True while there is something typed or chosen, which Esc clears first.
    public var hasQuery: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !filters.isEmpty
    }

    /// The chips: what the newest answer understood, typed or chosen, and what was chosen since.
    public var chips: [SearchChip] {
        var shown = filters
        if let understood {
            for key in SearchText.Key.allCases where SearchText.value(of: key, in: understood.filters) {
                SearchText.copy(key, from: understood.filters, into: &shown)
            }
        }
        return SearchChip.chips(for: shown)
    }

    // MARK: Changes

    /// A kind's chip: on or off.
    public func toggle(_ kind: SearchKind) {
        var kinds = filters.kinds ?? []
        if let index = kinds.firstIndex(of: kind) { kinds.remove(at: index) } else { kinds.append(kind) }
        filters.kinds = kinds.isEmpty ? nil : kinds
        changed(typing: false)
    }

    /// A chip's ×: the filter goes (a period's two), chosen, typed or asked, so it doesn't come back from the text. An
    /// ordinary search, never another sentence asked.
    public func remove(_ chip: SearchChip) {
        update {
            for key in chip.keys {
                filters = SearchText.clearing(key, in: filters)
                text = SearchText.removing(key, from: text)
            }
            if chip.keys.contains(.from) { chosenPerson = nil }
        }
    }

    /// A person from People: everything from them, the `from` filter with their address, instead of the text.
    public func choose(_ person: SearchPerson) {
        update {
            filters.from = person.email
            chosenPerson = person
            text = ""
        }
    }

    /// Esc's first press: the field and every filter cleared.
    public func clear() {
        update {
            text = ""
            filters = SearchFilters()
            chosenPerson = nil
        }
    }

    /// Asks the current query again at once, keeping what shows until the answer: coming back from a mail read from
    /// the results, where it may have changed. Not while a sentence is asked: its answer searches anew.
    public func refresh() {
        guard !isAsking, let query = requested else { return }
        start(query, generation: generation + 1, typing: false)
    }

    /// The next page, when there is one and none is loading. Returns the loading, for tests.
    @discardableResult
    public func loadMore() -> Task<Void, Never>? {
        guard phase == .answered, let cursor = nextCursor, !isLoadingMore, let query = requested, let service else {
            return nil
        }
        isLoadingMore = true
        let current = generation
        return Task {
            defer { if current == generation { isLoadingMore = false } }
            guard let page = try? await service.search(query.continuing(at: cursor)), current == generation else {
                return
            }
            let known = Set(hits.map(\.id))
            hits += page.items.filter { !known.contains($0.id) }
            nextCursor = page.nextCursor
        }
    }

    /// Several changes searched once, at once.
    func update(_ changes: () -> Void) {
        batching = true
        changes()
        batching = false
        changed(typing: false)
    }

    /// Something typed or chosen changed: search again after the pause when typing, at once otherwise. Nothing is
    /// asked when the query is the one already asked, unless `force` (an asked sentence's answer) or the change
    /// cancelled a sentence on its way, whose search was dropped. Any change ends what the last sentence said.
    func changed(typing: Bool, force: Bool = false) {
        let stopped = stopAsking()
        let query = currentQuery
        guard force || stopped || query != requested else { return }
        requested = query
        isLoadingMore = false
        // Older mail is for one query: a new one offers the button again.
        remote = RemoteSection()
        remoteQuery = nil
        guard let query else {
            generation += 1
            running?.cancel()
            running = nil
            phase = .idle
            hits = []
            people = []
            understood = nil
            nextCursor = nil
            return
        }
        start(query, generation: generation + 1, typing: typing)
    }

    private func start(_ query: SearchQuery, generation next: Int, typing: Bool) {
        generation = next
        running?.cancel()
        phase = .searching
        let pause = typing ? debounce : nil
        let sleep = self.sleep
        running = Task {
            if let pause {
                do { try await sleep(pause) } catch { return }
            }
            await run(query, generation: next)
        }
    }

    private func run(_ query: SearchQuery, generation current: Int) async {
        guard current == generation, let service else { return }
        do {
            let result = try await service.search(query)
            guard current == generation else { return }
            hits = result.items
            people = result.people ?? []
            understood = result.understood
            nextCursor = result.nextCursor
            phase = .answered
            settle(result.understood)
        } catch {
            guard current == generation, !(error is CancellationError) else { return }
            phase = .failed(Self.words(for: error))
        }
    }

    /// Moves finished operators the server took into chips (`SearchText.settle`). The query means the same, so nothing
    /// is asked again.
    private func settle(_ understood: SearchUnderstood) {
        let settled = SearchText.settle(text: text, filters: filters, understood: understood)
        guard settled.text != text || settled.filters != filters else { return }
        batching = true
        filters = settled.filters
        text = settled.text
        batching = false
        requested = currentQuery
    }

    /// A failure in words: the server's, or why it couldn't be asked.
    static func words(for error: any Error) -> String {
        if let apiError = error as? APIError {
            if apiError.code == .notFound { return "It's no longer in the mailbox." }
            return apiError.localizedDescription
        }
        return error.localizedDescription
    }
}
