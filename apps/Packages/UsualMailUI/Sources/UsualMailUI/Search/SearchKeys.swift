import UsualMailKit

/// A row of the search page the arrows move through: a person, a found thread, an older mail in the mailbox.
enum SearchRow: Hashable {
    case person(String)
    case thread(String)
    case remote(String)

    var isThread: Bool {
        if case .thread = self { true } else { false }
    }
}

/// The search page's keys, without a view: the down arrow selects the next row (the first when none is), the up arrow
/// the one before (from the first, back to the field: none); Enter opens the selected row, or with none the first
/// thread found; Esc clears what is typed and chosen, and when nothing is left, leaves the page.
struct SearchKeys: Equatable {
    /// The selected row, if one is.
    var selected: SearchRow?

    enum Escape: Equatable {
        /// Clear the field and the filters.
        case clear
        /// Nothing to clear: go back to where the person came from.
        case leave
    }

    /// The rows in the page's order: People, the threads found, then older mail.
    static func rows(people: [SearchPerson], hits: [SearchHit], remote: [RemoteHit]) -> [SearchRow] {
        people.map { .person($0.email) } + hits.map { .thread($0.id) } + remote.map { .remote($0.id) }
    }

    mutating func down(in rows: [SearchRow]) {
        guard let index = selected.flatMap(rows.firstIndex(of:)) else {
            selected = rows.first
            return
        }
        selected = rows[min(index + 1, rows.count - 1)]
    }

    mutating func up(in rows: [SearchRow]) {
        guard let index = selected.flatMap(rows.firstIndex(of:)) else {
            selected = nil
            return
        }
        selected = index == 0 ? nil : rows[index - 1]
    }

    /// What Enter opens: the selected row while it is there, else the first thread found.
    func target(in rows: [SearchRow]) -> SearchRow? {
        if let selected, rows.contains(selected) { return selected }
        return rows.first(where: \.isThread)
    }

    /// The selection, kept only while its row is still listed (a new answer may not have it).
    mutating func keep(in rows: [SearchRow]) {
        if let selected, !rows.contains(selected) { self.selected = nil }
    }

    /// Esc: clear first, leave once nothing is typed or chosen.
    static func escape(hasQuery: Bool) -> Escape {
        hasQuery ? .clear : .leave
    }
}
