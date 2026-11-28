import SwiftUI

/// Where each stack's list was scrolled to, kept while the window is open, so coming back to a stack, or to its list
/// from a mail, finds it where it was left (the coordinator's spec of 2026-11-20). A list is its place, and in the mail
/// stack the profile it showed: choosing another tab or profile there starts the list at the top, as before. Not
/// observed: scrolling writes here without redrawing the window.
///
/// A place is the row at the list's top, not a distance: the lists are lazy, and a fresh lazy list only guesses the
/// height of the rows it hasn't built, so a distance landed dozens of rows off far down a long list (the review of
/// 2026-11-28).
@MainActor
final class ScrollPlaces {
    struct Key: Hashable, Sendable {
        let place: Place
        let inbox: String?
    }

    /// The row at a list's top (`keepsTopRow`), where it is in the list and the row under it: to find its place when
    /// it has gone, and to tell rows coming or going above it, which move it with the rows around it, from the row
    /// moving on its own (new mail sorting it to the top).
    private struct Top {
        let id: ListRowID
        let index: Int?
        let next: ListRowID?

        init(_ id: ListRowID, in ids: [ListRowID], at index: Int? = nil) {
            self.id = id
            self.index = index ?? ids.firstIndex(of: id)
            next = self.index.flatMap { ids.indices.contains($0 + 1) ? ids[$0 + 1] : nil }
        }
    }

    /// How far a kept row may be from its place, on its own, and still be the list's place: about a screenful.
    static let nearby = 15

    private var tops: [Key: Top] = [:]

    /// The row at the top of a lazy list whose rows find their height late (the Feed's posts, the Inbox page's
    /// thousands), for `scrollPosition(id:)`.
    func top(_ key: Key) -> Binding<String?> {
        Binding(
            get: {
                guard case .row(let id, nil)? = self.tops[key]?.id else { return nil }
                return id
            },
            set: { self.tops[key] = $0.map { Top(.row($0), in: []) } })
    }

    /// The row at the top of a lazy list of rows `ids`, in order, for `scrollPosition(id:)` (`keepsTopRow`): the one
    /// kept last, where it is now; or, once it has left the list (read and moved to Seen, archived) or moved away on
    /// its own (new mail sorting it to the top, the review of 2026-11-28), the row now in its place, so the list stays
    /// where it was and doesn't go with it.
    func top(_ key: Key, in ids: [ListRowID]) -> Binding<ListRowID?> {
        Binding(
            get: { self.found(key, in: ids) },
            set: { id in self.tops[key] = id.map { Top($0, in: ids) } })
    }

    /// The kept row of `key` in `ids` (`top(_:in:)`), keeping where it is up to date, so rows that came above it don't
    /// put a later place off; the row taking its place becomes the kept one.
    private func found(_ key: Key, in ids: [ListRowID]) -> ListRowID? {
        guard let top = tops[key] else { return nil }
        // Kept without a place (words above the rows): the list's top.
        guard let index = top.index else { return ids.contains(top.id) ? top.id : nil }
        let fresh =
            ids.indices.contains(index) && ids[index] == top.id ? index : ids.firstIndex(of: top.id)
        if let at = fresh {
            let next = ids.indices.contains(at + 1) ? ids[at + 1] : nil
            // Near its place, or moved with the row under it: rows came or went above it.
            if abs(at - index) <= Self.nearby || (top.next != nil && next == top.next) {
                if at != index || next != top.next { tops[key] = Top(top.id, in: ids, at: at) }
                return top.id
            }
        }
        guard !ids.isEmpty else { return nil }
        // Gone, or away on its own: the row that was under it while that is still near, else whatever is there now.
        let near = top.next.flatMap { ids.firstIndex(of: $0) }.flatMap { abs($0 - index) <= Self.nearby ? $0 : nil }
        let place = near ?? min(index, ids.count - 1)
        tops[key] = Top(ids[place], in: ids, at: place)
        return ids[place]
    }

    /// The list starts at the top next time.
    func forget(_ key: Key) {
        tops[key] = nil
    }

    /// One list's kept place, for the views under it (`keptScroll`).
    func kept(_ key: Key) -> KeptScroll {
        KeptScroll(places: self, key: key)
    }
}

/// One list's kept place in `ScrollPlaces`.
struct KeptScroll: Sendable {
    let places: ScrollPlaces
    let key: ScrollPlaces.Key
}

extension EnvironmentValues {
    /// The kept place of the list below, set by the window for each stack's list.
    @Entry var keptScroll: KeptScroll? = nil
}

/// A view in a lazy list kept by the row at its top (`keepsTopRow`), by kind, so ids of different kinds never meet: a
/// row (a thread's, a notification group's, a sender's), in its section where the list has them; a section's title;
/// words above or under the rows (the count, the empty list's, the AI's note). Every view in the list's stack has one:
/// a view with none above the rows (Screening's count), or rows that were each one of two views, kept the list from
/// coming back to a kept row (`scrollPosition(id:)`, `KeptPlaceTests`).
enum ListRowID: Hashable, Sendable {
    case row(String, section: String? = nil)
    case title(String)
    case words(String)
}

extension Identifiable where ID == String {
    /// Its row's id in a list without sections (`ListRowID`).
    var rowID: ListRowID { .row(id) }
}

extension View {
    /// For a scroll view around a lazy stack with `scrollTargetLayout()` whose views are `ids`, in order (`ListRowID`,
    /// one on every view in it): starts it with the row the environment's `keptScroll` kept at its top, and keeps the
    /// row at its top as it scrolls (`ScrollPlaces.top(_:in:)`). Nothing without one.
    func keepsTopRow(_ ids: [ListRowID]) -> some View {
        modifier(KeepsTopRow(ids: ids))
    }
}

private struct KeepsTopRow: ViewModifier {
    let ids: [ListRowID]
    @Environment(\.keptScroll) private var kept

    func body(content: Content) -> some View {
        content.scrollPosition(id: kept.map { $0.places.top($0.key, in: ids) } ?? .constant(nil), anchor: .top)
    }
}
