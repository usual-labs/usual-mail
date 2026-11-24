import SwiftUI

/// Where each stack's list was scrolled to, kept while the window is open, so coming back to a stack, or to its list
/// from a mail, finds it where it was left (the coordinator's spec of 2026-11-20). A list is its place, and in the mail
/// stack the profile it showed: choosing another tab or profile there starts the list at the top, as before. Not
/// observed: scrolling writes here without redrawing the window.
@MainActor
final class ScrollPlaces {
    struct Key: Hashable, Sendable {
        let place: Place
        let inbox: String?
    }

    private var offsets: [Key: CGFloat] = [:]
    private var tops: [Key: String] = [:]

    /// How far down the list was, for a list of rows of known height (`keepsScroll`).
    func offset(_ key: Key) -> CGFloat { offsets[key] ?? 0 }

    func keep(_ offset: CGFloat, at key: Key) {
        offsets[key] = offset
    }

    /// The row at the top of a lazy list whose rows find their height late (the Feed's posts, the Inbox page's
    /// thousands), for `scrollPosition(id:)`.
    func top(_ key: Key) -> Binding<String?> {
        Binding(get: { self.tops[key] }, set: { self.tops[key] = $0 })
    }

    /// The list starts at the top next time.
    func forget(_ key: Key) {
        offsets[key] = nil
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

extension View {
    /// For a scroll view: starts it where the environment's `keptScroll` was left, and keeps where it is as it scrolls.
    /// Nothing without one.
    func keepsScroll() -> some View {
        modifier(KeepsScroll())
    }
}

private struct KeepsScroll: ViewModifier {
    @Environment(\.keptScroll) private var kept
    @State private var position = ScrollPosition(edge: .top)
    /// Whether the kept place was asked for: until then, the first layout at the top isn't taken for a scroll.
    @State private var started = false

    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                max(0, geometry.contentOffset.y + geometry.contentInsets.top)
            } action: { _, offset in
                if started, let kept { kept.places.keep(offset, at: kept.key) }
            }
            .onAppear {
                if let kept, case let offset = kept.places.offset(kept.key), offset > 0 {
                    position.scrollTo(y: offset)
                }
                started = true
            }
    }
}
