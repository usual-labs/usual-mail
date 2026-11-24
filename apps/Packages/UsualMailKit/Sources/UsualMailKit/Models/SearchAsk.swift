import Foundation

// Mirrors of `SearchAskInput` and `SearchAskResult` in `core/src/search.ts` (docs/contract-search.md, "Asking in a
// sentence"): a search asked in a sentence, which the server's AI turns into the filters a search takes.

/// A sentence for the server's AI to turn into a search (`SearchAskInput` in core). Person only, and only on the
/// person's explicit action: what is typed otherwise never goes to the AI.
public struct SearchAskInput: Codable, Hashable, Sendable {
    /// The sentence as written, 1 to `maxQuestion` characters.
    public var question: String
    /// The inboxes the search will cover: checked and echoed, never sent to the AI. Nil: every inbox.
    public var inboxIds: [String]?
    /// The IANA time zone "last month" and the like are read in.
    public var tz: String?

    /// Core's `SEARCH_ASK_MAX`: the longest sentence the server takes, counted as the server counts (UTF-16 units).
    public static let maxQuestion = 200

    public init(question: String, inboxIds: [String]? = nil, tz: String? = nil) {
        self.question = question
        self.inboxIds = inboxIds
        self.tz = tz
    }

    /// The sentence as the server reads it: spaces and line breaks one space, none at the ends.
    public static func oneLine(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Whether the server takes the sentence (already `oneLine`): 1 to 200 characters.
    public static func accepts(_ question: String) -> Bool {
        !question.isEmpty && question.utf16.count <= maxQuestion
    }
}

/// What the server's AI made of a sentence (`SearchAskResult` in core), every field checked by the server. No mail:
/// a client shows `understood` as chips with `text` in the field and runs `GET /v1/search` with them. Whatever
/// happened, they are a search that can be run: when the AI isn't working or found nothing, the sentence as typed.
public struct SearchAskResult: Codable, Hashable, Sendable {
    /// The filters and free text to search with, in exactly the shape a search echoes.
    public var understood: SearchUnderstood
    /// What stands in the search field: `understood.text`, then each excluded word as `-word`.
    public var text: String
    /// True when the AI turned something in the sentence into a filter or an excluded word.
    public var found: Bool
    /// `working` when the AI answered this sentence; otherwise why it wasn't asked or didn't answer.
    public var ai: AiState
    /// Why `ai` isn't `working`, in words a person can act on. Written only when present.
    public var detail: String?

    public init(understood: SearchUnderstood, text: String, found: Bool, ai: AiState, detail: String? = nil) {
        self.understood = understood
        self.text = text
        self.found = found
        self.ai = ai
        self.detail = detail
    }
}
