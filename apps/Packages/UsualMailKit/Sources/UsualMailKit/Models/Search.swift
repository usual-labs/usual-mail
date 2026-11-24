import Foundation

// Mirrors of `core/src/search.ts` (docs/contract-search.md): what a search takes, what the server understood, and what
// a local search answers. Remote search's shapes are in RemoteSearch.swift.

/// What the kind filter takes (`SearchKind` in core): a category, `screened` (only screened threads) or `done` (only
/// done, that is archived, threads). Categories among themselves are "any of"; `screened` and `done` each narrow what
/// the categories found.
public enum SearchKind: Codable, Hashable, Sendable {
    case category(Category)
    case screened
    case done

    /// Core's `SEARCH_KINDS`: the seven categories in the contract's order, then screened and done.
    public static let all: [SearchKind] = Category.known.map(SearchKind.category) + [.screened, .done]

    public init(rawValue: String) {
        switch rawValue {
        case "screened": self = .screened
        case "done": self = .done
        default: self = .category(Category(rawValue: rawValue))
        }
    }

    public var rawValue: String {
        switch self {
        case .category(let category): category.rawValue
        case .screened: "screened"
        case .done: "done"
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// The filters a search takes, all optional and combined (all must hold), as plain values (`SearchFilters` in core).
/// Fields left nil are not sent, and not written.
public struct SearchFilters: Codable, Hashable, Sendable {
    /// One or more inboxes. Nil: every inbox the caller may see.
    public var inboxIds: [String]?
    public var kinds: [SearchKind]?
    /// Who wrote: an address (exact), a domain, or a word's start of a sender's name or address.
    public var from: String?
    /// Who it was sent to (To and Cc), read like `from`.
    public var to: String?
    /// Words the subject holds.
    public var subject: String?
    /// True: only threads with an attachment (inline pictures don't count). False: only threads without.
    public var hasAttachment: Bool?
    /// Only threads whose newest mail a person sees is at or after this time.
    public var after: Date?
    /// Only threads whose newest mail a person sees is before this time.
    public var before: Date?
    /// True: only unread threads. False: only read ones.
    public var unread: Bool?

    public init(
        inboxIds: [String]? = nil, kinds: [SearchKind]? = nil, from: String? = nil, to: String? = nil,
        subject: String? = nil, hasAttachment: Bool? = nil, after: Date? = nil, before: Date? = nil,
        unread: Bool? = nil
    ) {
        self.inboxIds = inboxIds
        self.kinds = kinds
        self.from = from
        self.to = to
        self.subject = subject
        self.hasAttachment = hasAttachment
        self.after = after
        self.before = before
        self.unread = unread
    }

    /// True when no filter is set.
    public var isEmpty: Bool { self == SearchFilters() }
}

/// What the server understood (`SearchUnderstood` in core): the filters it applied, given or typed as operators (a
/// typed one wins over the same filter given), the free text left once operators and excluded words were taken out
/// (phrases in quotes), and the words to leave out. Echoed with every answer, so the filters can show as chips.
public struct SearchUnderstood: Codable, Hashable, Sendable {
    public var filters: SearchFilters
    public var text: String
    /// Words typed with a leading minus. Nil when there are none, and then not written.
    public var exclude: [String]?

    public init(filters: SearchFilters = SearchFilters(), text: String = "", exclude: [String]? = nil) {
        self.filters = filters
        self.text = text
        self.exclude = exclude
    }

    private enum CodingKeys: String, CodingKey {
        case text, exclude
    }

    /// One flat JSON object: the filters' fields beside `text` and `exclude`.
    public init(from decoder: any Decoder) throws {
        filters = try SearchFilters(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        exclude = try container.decodeIfPresent([String].self, forKey: .exclude)
    }

    public func encode(to encoder: any Encoder) throws {
        try filters.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(text, forKey: .text)
        try container.encodeIfPresent(exclude, forKey: .exclude)
    }
}

/// Where a search's text matched (`SearchField` in core), most telling first in `SearchMatch.fields`.
public enum SearchField: OpenEnum {
    case subject, sender, people, summary, facts, attachments, body
    case unknown(String)

    public static let known: [SearchField] = [.subject, .sender, .people, .summary, .facts, .attachments, .body]

    public var rawValue: String {
        switch self {
        case .subject: "subject"
        case .sender: "sender"
        case .people: "people"
        case .summary: "summary"
        case .facts: "facts"
        case .attachments: "attachments"
        case .body: "body"
        case .unknown(let raw): raw
        }
    }
}

/// A piece of plain text, matched or not (`SearchRun` in core). Drawn in order, the matched ones marked; the text is
/// never markup, so it is drawn as text.
public struct SearchRun: Codable, Hashable, Sendable {
    public var text: String
    public var match: Bool

    public init(_ text: String, match: Bool = false) {
        self.text = text
        self.match = match
    }
}

/// A short excerpt around the best match outside the subject, and the field it came from.
public struct SearchExcerpt: Codable, Hashable, Sendable {
    public var field: SearchField
    public var runs: [SearchRun]

    public init(field: SearchField, runs: [SearchRun]) {
        self.field = field
        self.runs = runs
    }
}

/// Where the text matched in one thread (`SearchMatch` in core).
public struct SearchMatch: Codable, Hashable, Sendable {
    /// Every field the text matched, most telling first.
    public var fields: [SearchField]
    /// The subject in runs, when it matched. Written only when present.
    public var subject: [SearchRun]?
    /// An excerpt from the first of body, summary, facts, attachments, people and sender that matched. Absent when only
    /// the subject matched.
    public var excerpt: SearchExcerpt?

    public init(fields: [SearchField], subject: [SearchRun]? = nil, excerpt: SearchExcerpt? = nil) {
        self.fields = fields
        self.subject = subject
        self.excerpt = excerpt
    }
}

/// One local result (`SearchHit` in core): the thread exactly as lists give it, plus where the text matched. `match`
/// is absent for a search with filters and no text.
public struct SearchHit: Codable, Hashable, Sendable, Identifiable {
    public var thread: MailThread
    public var match: SearchMatch?

    public var id: String { thread.id }

    public init(thread: MailThread, match: SearchMatch? = nil) {
        self.thread = thread
        self.match = match
    }

    private enum CodingKeys: String, CodingKey {
        case match
    }

    /// One flat JSON object: the thread's fields beside `match`.
    public init(from decoder: any Decoder) throws {
        thread = try MailThread(from: decoder)
        match = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(SearchMatch.self, forKey: .match)
    }

    public func encode(to encoder: any Encoder) throws {
        try thread.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(match, forKey: .match)
    }
}

/// A sender whose name or address matches the text (`SearchPerson` in core). "Everything from them" is the `from`
/// filter with `email`.
public struct SearchPerson: Codable, Hashable, Sendable, Identifiable {
    public var email: String
    /// The name they last wrote under, when they gave one.
    public var name: String?
    /// How many threads (not trashed) in the inboxes searched hold mail from them.
    public var threads: Int
    public var lastMessageAt: Date

    public var id: String { email }

    public init(email: String, name: String? = nil, threads: Int, lastMessageAt: Date) {
        self.email = email
        self.name = name
        self.threads = threads
        self.lastMessageAt = lastMessageAt
    }
}

/// The answer of `GET /v1/search` (`SearchResult` in core).
public struct SearchResult: Codable, Hashable, Sendable {
    public var items: [SearchHit]
    /// Pass back as `cursor`, with the same query, for the next page. Nil on the last page.
    public var nextCursor: String?
    public var understood: SearchUnderstood
    /// On the first page of a search with text: up to five senders whose name or address matches it.
    public var people: [SearchPerson]?

    public init(
        items: [SearchHit], nextCursor: String? = nil, understood: SearchUnderstood = SearchUnderstood(),
        people: [SearchPerson]? = nil
    ) {
        self.items = items
        self.nextCursor = nextCursor
        self.understood = understood
        self.people = people
    }
}

/// A search as `GET /v1/search` and `GET /v1/search/remote` take it (`SearchQuery` in core): the text as typed,
/// operators included (the server reads them), the filters, the time zone typed dates are days in, and the page.
public struct SearchQuery: Hashable, Sendable {
    /// `q`: at most `maxText` characters; nil or empty sends none.
    public var text: String?
    public var filters: SearchFilters
    /// An IANA time zone, such as `Europe/Berlin`.
    public var timeZone: String?
    public var cursor: String?
    public var limit: Int?

    /// The longest `q` the server takes.
    public static let maxText = 200

    public init(
        text: String? = nil, filters: SearchFilters = SearchFilters(), timeZone: String? = nil, cursor: String? = nil,
        limit: Int? = nil
    ) {
        self.text = text
        self.filters = filters
        self.timeZone = timeZone
        self.cursor = cursor
        self.limit = limit
    }

    /// The same search one page on.
    public func continuing(at cursor: String?) -> SearchQuery {
        var next = self
        next.cursor = cursor
        return next
    }

    /// The query parameters, in the contract's order: `q`, `inboxIds` and `kinds` comma-separated, `from`, `to`,
    /// `subject`, `hasAttachment`, `unread`, `after` and `before` as times, `tz`, `cursor`, `limit`.
    public var parameters: [(String, String)] {
        var items: [(String, String)] = []
        if let text, !text.isEmpty { items.append(("q", String(text.prefix(Self.maxText)))) }
        if let ids = filters.inboxIds, !ids.isEmpty { items.append(("inboxIds", ids.joined(separator: ","))) }
        if let kinds = filters.kinds, !kinds.isEmpty {
            items.append(("kinds", kinds.map(\.rawValue).joined(separator: ",")))
        }
        if let from = filters.from { items.append(("from", from)) }
        if let to = filters.to { items.append(("to", to)) }
        if let subject = filters.subject { items.append(("subject", subject)) }
        if let hasAttachment = filters.hasAttachment { items.append(("hasAttachment", String(hasAttachment))) }
        if let unread = filters.unread { items.append(("unread", String(unread))) }
        if let after = filters.after { items.append(("after", MailJSON.formatTime(after))) }
        if let before = filters.before { items.append(("before", MailJSON.formatTime(before))) }
        if let timeZone { items.append(("tz", timeZone)) }
        if let cursor { items.append(("cursor", cursor)) }
        if let limit { items.append(("limit", String(limit))) }
        return items
    }
}
