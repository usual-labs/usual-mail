import AppKit
import Foundation
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The lists build only the rows near the screen (`LazyVStack`), so showing one costs about the same with ten times the
/// threads. Built whole, a tab of 1,233 threads took 55 to 100 ms to show on this Mac, growing with every row, which on
/// the iPhone was a lag on changing tabs and, as each change to the copy rebuilt every row, while scrolling (the owner's
/// report of 2026-11-27). Each list is laid out in an offscreen window as tall as an iPhone, with enough threads to fill
/// it either way; the fastest of a few tries is compared, so a busy machine doesn't decide it.
@MainActor
@Suite(.serialized)
struct LongListTests {
    enum List: CaseIterable {
        case home, receipts, notifications, screening, pinned
    }

    @Test func tenTimesTheThreadsShowAboutAsFast() async throws {
        let short = try await heldStore(Self.sample(threads: 300))
        let long = try await heldStore(Self.sample(threads: 3000))
        #expect(long.lists.home.count > 500)
        for list in List.allCases {
            _ = fastest(list, in: short)
            let few = fastest(list, in: short)
            let many = fastest(list, in: long)
            #expect(many < few * 3, "\(list): \(many) with 3,000 threads, \(few) with 300")
        }
    }

    /// The sample with `count` threads: its own, then copies of them, each further back in time and from a sender of its
    /// own (Screening and Notifications group a sender's mail in one row).
    static func sample(threads count: Int) -> SampleData {
        var data = SampleData.bundled
        let own = data.threads
        data.threads = (0..<count).map { index in
            var thread = own[index % own.count]
            if index >= own.count {
                thread.id = "\(thread.id)_\(index)"
                thread.lastMessageAt = thread.lastMessageAt.addingTimeInterval(-Double(index) * 600)
                thread.sender = thread.sender.map { "copy\(index).\($0)" }
            }
            return thread
        }
        return data
    }

    /// The fastest of five layouts of `list`.
    private func fastest(_ list: List, in store: MailStore) -> Duration {
        (0..<5).map { _ in layout(Self.view(list), store: store) }.min()!
    }

    /// The list's view, in every inbox.
    static func view(_ list: List) -> AnyView {
        switch list {
        case .home: AnyView(HomeView(inboxId: nil, open: { _ in }))
        case .receipts: AnyView(CategoryListView(tab: .receipts, inboxId: nil, open: { _ in }))
        case .notifications:
            AnyView(NotificationsView(inboxId: nil, expanded: .constant(ExpandedGroups()), open: { _ in }))
        case .screening: AnyView(ScreeningView(inboxId: nil, act: { _, _ in }, open: { _ in }))
        case .pinned: AnyView(RailListView(place: .pinned, inboxId: nil, open: { _ in }))
        }
    }

    /// How long laying `view` out and drawing it once took, in an offscreen window as tall as an iPhone.
    private func layout(_ view: AnyView, store: MailStore) -> Duration {
        let frame = CGRect(x: 0, y: 0, width: 402, height: 800)
        let host = NSHostingView(rootView: AnyView(view.environment(store)))
        host.frame = frame
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = host
        defer { window.contentView = nil }
        return ContinuousClock().measure {
            host.layoutSubtreeIfNeeded()
            host.displayIfNeeded()
        }
    }
}
