import Foundation

/// A filter a search shows as a chip: one the person chose (a kind by its chip, a person from People), one the server
/// understood from an operator they typed, or one its AI understood from a sentence. Removing it removes both.
public enum SearchChip: Hashable, Sendable {
    case from(String)
    case to(String)
    case subject(String)
    case hasAttachment(Bool)
    case unread(Bool)
    case after(Date)
    case before(Date)
    /// `after` and `before` together, as one period: from `after` (inclusive) up to `before` (exclusive).
    case period(after: Date, before: Date)

    /// The filters it stands for: one, or a period's two.
    public var keys: [SearchText.Key] {
        switch self {
        case .from: [.from]
        case .to: [.to]
        case .subject: [.subject]
        case .hasAttachment: [.hasAttachment]
        case .unread: [.unread]
        case .after: [.after]
        case .before: [.before]
        case .period: [.after, .before]
        }
    }

    /// The chips for a set of filters, in a fixed order: from, to, subject, attachment, unread, then the dates: one
    /// period when `after` comes before `before`, else after and before apart. Kinds and inboxes have their own
    /// controls.
    public static func chips(for filters: SearchFilters) -> [SearchChip] {
        var chips: [SearchChip] = []
        if let from = filters.from { chips.append(.from(from)) }
        if let to = filters.to { chips.append(.to(to)) }
        if let subject = filters.subject { chips.append(.subject(subject)) }
        if let hasAttachment = filters.hasAttachment { chips.append(.hasAttachment(hasAttachment)) }
        if let unread = filters.unread { chips.append(.unread(unread)) }
        if let after = filters.after, let before = filters.before, after < before {
            chips.append(.period(after: after, before: before))
        } else {
            if let after = filters.after { chips.append(.after(after)) }
            if let before = filters.before { chips.append(.before(before)) }
        }
        return chips
    }
}

/// What a person typed, read the way the server reads it (`tokens` and `parseSearch` in server/src/search/terms.ts),
/// for two things only: moving an operator the server took into a chip once it is finished, and taking an operator out
/// when its chip is removed. Which operators count is always the server's answer (`SearchUnderstood`); the text is sent
/// as typed.
public enum SearchText {
    /// The filters an operator can set.
    public enum Key: Hashable, Sendable, CaseIterable {
        case from, to, subject, hasAttachment, unread, after, before
    }

    struct Token: Equatable {
        /// Where it is in the text, its minus and quotes included.
        var range: Range<String.Index>
        /// Without its minus; a quoted phrase without its quotes.
        var value: String
        var quoted: Bool
        var negated: Bool
        /// Followed by a space: the person has finished it.
        var complete: Bool
    }

    /// The text's words, "quoted phrases" and operators whose value is quoted (`subject:"weekly report"`), each
    /// possibly with a leading minus. An unclosed quote runs to the end.
    static func tokens(_ text: String) -> [Token] {
        var tokens: [Token] = []
        var index = text.startIndex
        while index < text.endIndex {
            while index < text.endIndex, text[index].isWhitespace { index = text.index(after: index) }
            guard index < text.endIndex else { break }
            let start = index
            var negated = false
            let next = text.index(after: index)
            if text[index] == "-", next < text.endIndex, !text[next].isWhitespace {
                negated = true
                index = next
            }
            if text[index] == "\"" {
                let open = text.index(after: index)
                let close = text[open...].firstIndex(of: "\"")
                let value = String(text[open..<(close ?? text.endIndex)])
                    .split(whereSeparator: \.isWhitespace).joined(separator: " ")
                let end = close.map { text.index(after: $0) } ?? text.endIndex
                tokens.append(
                    Token(
                        range: start..<end, value: value, quoted: true, negated: negated,
                        complete: end < text.endIndex))
                index = end
                continue
            }
            let valueStart = index
            var end = index
            while end < text.endIndex, !text[end].isWhitespace {
                // An operator's quoted value runs to its closing quote.
                if text[end] == "\"", end > valueStart, text[text.index(before: end)] == ":" {
                    let open = text.index(after: end)
                    end = text[open...].firstIndex(of: "\"").map { text.index(after: $0) } ?? text.endIndex
                    continue
                }
                end = text.index(after: end)
            }
            tokens.append(
                Token(
                    range: start..<end, value: String(text[valueStart..<end]), quoted: false, negated: negated,
                    complete: end < text.endIndex))
            index = end
        }
        return tokens
    }

    /// The filter an operator of this shape would set, if the server takes it: `from:`, `to:`, `subject:`,
    /// `has:attachment` (and `-has:attachment`), `is:unread`, `is:read`, `before:` and `after:` (and `older:`, `newer:`),
    /// names in any case. Whether a date can be read is the server's to say.
    static func key(of token: Token) -> Key? {
        guard !token.quoted, let colon = token.value.firstIndex(of: ":") else { return nil }
        let name = token.value[..<colon].lowercased()
        let value = token.value[token.value.index(after: colon)...]
        guard !name.isEmpty, name.allSatisfy({ $0.isASCII && $0.isLetter }), !value.isEmpty else { return nil }
        let bare = value.trimmingCharacters(in: CharacterSet(charactersIn: "\"")).trimmingCharacters(
            in: .whitespaces
        ).lowercased()
        guard !bare.isEmpty else { return nil }
        switch name {
        case "has": return bare == "attachment" ? .hasAttachment : nil
        case "is": return bare == "unread" || bare == "read" ? .unread : nil
        default: break
        }
        if token.negated { return nil }
        switch name {
        case "from": return .from
        case "to": return .to
        case "subject": return .subject
        case "before", "older": return .before
        case "after", "newer": return .after
        default: return nil
        }
    }

    /// Moves every finished operator the server took (`understood`) out of the text into the filters, with the value
    /// the server understood. The search means the same afterwards, since a typed operator wins over the same filter
    /// given, so it needn't be asked again. An operator still being typed (no space after it) stays, as does anything
    /// the server read as plain text (`before:soon`) or as a word to leave out.
    public static func settle(text: String, filters: SearchFilters, understood: SearchUnderstood) -> (
        text: String, filters: SearchFilters
    ) {
        let plain = Set(tokens(understood.text).filter { !$0.quoted }.map(\.value))
        let excluded = Set(understood.exclude ?? [])
        var filters = filters
        var taken: [Token] = []
        for token in tokens(text) where token.complete {
            guard let key = key(of: token), value(of: key, in: understood.filters), !plain.contains(token.value),
                !(token.negated && excluded.contains(token.value))
            else { continue }
            copy(key, from: understood.filters, into: &filters)
            taken.append(token)
        }
        return (removing(taken, from: text), filters)
    }

    /// The text without any operator setting `key`, finished or not, so a removed chip doesn't come back from it.
    public static func removing(_ key: Key, from text: String) -> String {
        removing(tokens(text).filter { Self.key(of: $0) == key }, from: text)
    }

    /// The text without these tokens and the spaces after each.
    private static func removing(_ removed: [Token], from text: String) -> String {
        guard !removed.isEmpty else { return text }
        var result = ""
        var index = text.startIndex
        for token in removed {
            result += text[index..<token.range.lowerBound]
            index = token.range.upperBound
            while index < text.endIndex, text[index].isWhitespace { index = text.index(after: index) }
        }
        result += text[index...]
        return String(result.drop { $0.isWhitespace })
    }

    /// Sets `key` in `filters` to the value `source` has for it; false when `source` has none.
    @discardableResult
    static func copy(_ key: Key, from source: SearchFilters, into filters: inout SearchFilters) -> Bool {
        switch key {
        case .from: filters.from = source.from
        case .to: filters.to = source.to
        case .subject: filters.subject = source.subject
        case .hasAttachment: filters.hasAttachment = source.hasAttachment
        case .unread: filters.unread = source.unread
        case .after: filters.after = source.after
        case .before: filters.before = source.before
        }
        return value(of: key, in: source)
    }

    /// Whether `filters` sets `key`.
    static func value(of key: Key, in filters: SearchFilters) -> Bool {
        switch key {
        case .from: filters.from != nil
        case .to: filters.to != nil
        case .subject: filters.subject != nil
        case .hasAttachment: filters.hasAttachment != nil
        case .unread: filters.unread != nil
        case .after: filters.after != nil
        case .before: filters.before != nil
        }
    }

    /// `filters` without `key`.
    static func clearing(_ key: Key, in filters: SearchFilters) -> SearchFilters {
        var filters = filters
        copy(key, from: SearchFilters(), into: &filters)
        return filters
    }
}
