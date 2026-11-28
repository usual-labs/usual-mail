import AppKit
import Foundation
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// A list comes back with the row that was at its top, fresh, on its first screen, near its start and far down it (the
/// review of 2026-11-28). The lists are lazy, and a fresh lazy list only guesses the height of the rows it hasn't built:
/// kept by distance, Home at 1,233 threads came back six rows off at 8,000 points and more near its end, so the lists
/// keep the row (`keepsTopRow`). Each list is laid out in an offscreen window as tall as an iPhone with its kept row,
/// then scrolled a point, and the first row the scroll view itself says is showing is the one at its top.
@MainActor
@Suite(.serialized)
struct KeptPlaceTests {
    @Test func aListComesBackWithTheRowThatWasAtItsTop() async throws {
        let store = try await heldStore(LongListTests.sample(threads: 1200))
        let now = store.now
        for list in LongListTests.List.allCases {
            switch list {
            case .home:
                let home = HomeList(store.lists, inbox: nil)
                try await check(
                    list, TitledRows([(title: "New", rows: home.new), (title: "Seen", rows: home.seen)]).ids, store)
            case .receipts:
                try await check(
                    list, CategoryList(store.lists, tab: .receipts, inbox: nil, now: now).threads.map(\.rowID), store)
            case .notifications:
                let sections = NotificationSections(
                    store.lists, inbox: nil, today: CalendarDay(now, in: .current), now: now)
                try await check(list, TitledRows(sections.parts.map { (title: $0.title, rows: $0.rows) }).ids, store)
            case .screening:
                try await check(list, ScreeningList(store.lists, inbox: nil).groups.map(\.rowID), store)
            case .pinned:
                try await check(list, RailList(store.lists, place: .pinned, inbox: nil).threads.map(\.rowID), store)
            }
        }
    }

    /// `list`, with rows `ids`, comes back with each kept row at its top: one on the first screen, one a tenth of the
    /// way down and one near the foot, with a screenful still under it so it can be at the top.
    private func check(_ list: LongListTests.List, _ ids: [ListRowID], _ store: MailStore) async throws {
        #expect(ids.count >= 40, "\(list): \(ids.count) rows")
        guard ids.count >= 40 else { return }
        for kept in [5, ids.count / 10, ids.count - 25] {
            let top = try await shownTop(list, keeping: kept, of: ids, store: store)
            #expect(top == kept, "\(list): row \(top ?? -1) at the top, \(kept) of \(ids.count) kept")
        }
    }

    /// The first row showing at the top of `list`, laid out fresh with row `index` of `ids` kept, as the scroll view
    /// says (`onScrollTargetVisibilityChange`).
    private func shownTop(
        _ list: LongListTests.List, keeping index: Int, of ids: [ListRowID], store: MailStore
    ) async throws -> Int? {
        let places = ScrollPlaces()
        let key = ScrollPlaces.Key(place: .tab(.home), inbox: nil)
        places.top(key, in: ids).wrappedValue = ids[index]
        let showing = Showing()
        let view = LongListTests.view(list)
            .environment(\.keptScroll, places.kept(key))
            .environment(store)
            .onScrollTargetVisibilityChange(idType: ListRowID.self, threshold: 0.01) { showing.ids = $0 }
        let frame = CGRect(x: 0, y: 0, width: 402, height: 800)
        let host = NSHostingView(rootView: AnyView(view))
        host.frame = frame
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = host
        defer { window.contentView = nil }
        host.layoutSubtreeIfNeeded()
        try await Self.settle()
        guard let scroll = Self.scrollView(in: host) else { return nil }
        let clip = scroll.contentView
        clip.scroll(to: NSPoint(x: 0, y: clip.bounds.origin.y + 1))
        scroll.reflectScrolledClipView(clip)
        try await Self.settle()
        return showing.ids.first.flatMap { ids.firstIndex(of: $0) }
    }

    /// The rows showing, top first.
    private final class Showing {
        var ids: [ListRowID] = []
    }

    /// Lets SwiftUI lay out and scroll, as it does on the run loop, without holding up the other tests' main actor.
    private static func settle() async throws {
        try await Task.sleep(for: .milliseconds(300))
    }

    private static func scrollView(in view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
    }
}
