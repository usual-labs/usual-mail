import Foundation
import Observation
import UsualMailKit

/// Which tabs hold mail not seen yet, for a dot on the tab (the owner's words of 2026-11-27: "whenever in any of the
/// tabs there is a new item which I haven't seen ... I haven't opened it and I haven't seen it ... I need to see a dot
/// on the tab"; the iPhone's row at the card's foot). A tab has a dot while it lists, in the profile showing, an unread
/// thread that hasn't been there while the person looked at the tab. Looking at a tab (its list or a mail opened from
/// it showing, the app in front) counts everything it lists as seen; opening a mail marks it read, which takes it off
/// too, and so does ticking a notification seen. A thread counts by its newest mail (`mark(of:)`), so new mail in it
/// counts again. The first time, everything the tabs list counts as seen, so mail unread from before lights nothing.
/// Kept on this device, as the swipe settings are; the server keeps none, so another device has its own dots.
@MainActor
@Observable
final class TabNews {
    static let defaultsKey = "UsualMailSeenInTabs"

    /// Per tab, the threads seen there, each by its id and its newest mail's time (`mark(of:)`). A tab with no entry
    /// hasn't started yet: it shows no dot.
    private(set) var seen: [Tab: Set<String>]
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.dictionary(forKey: Self.defaultsKey) as? [String: [String]] ?? [:]
        var seen: [Tab: Set<String>] = [:]
        for (name, marks) in stored {
            if let tab = Tab(rawValue: name) { seen[tab] = Set(marks) }
        }
        self.seen = seen
    }

    /// A thread as seen in a tab: its id and its newest mail's time.
    nonisolated static func mark(of thread: MailThread) -> String {
        "\(thread.id)\u{0}\(thread.lastMessageAt.timeIntervalSince1970)"
    }

    /// What `tab` lists at `now`, in one inbox or all: Home's list, or the tab's categories without what is snoozed
    /// (`CategoryList`).
    static func threads(on tab: Tab, in lists: MailLists, inbox: String?, now: Date) -> [MailThread] {
        tab == .home ? lists.home(inbox: inbox) : CategoryList(lists, tab: tab, inbox: inbox, now: now).threads
    }

    /// The tabs with a dot: each but `shown` (the one chosen, which needs none) that lists an unread thread not seen
    /// there.
    func dots(in lists: MailLists, inbox: String?, now: Date, except shown: Tab?) -> Set<Tab> {
        Set(
            Tab.allCases.filter { tab in
                guard tab != shown, let seen = seen[tab] else { return false }
                return Self.threads(on: tab, in: lists, inbox: inbox, now: now).contains {
                    $0.unread && !seen.contains(Self.mark(of: $0))
                }
            })
    }

    /// Brings what is seen up to date with the lists (once they hold any mail): a tab not started takes everything it
    /// lists in every inbox as seen; the tab `looking` at takes what it lists in the profile showing; and every tab
    /// forgets threads the copy no longer holds as they were (done, trashed, or with newer mail), so what is kept stays
    /// as small as the copy. Saved when it changed.
    func update(lists: MailLists, inbox: String?, now: Date, looking: Tab?) {
        let every = lists.everyThread
        guard !every.isEmpty else { return }
        let held = Set(every.map(Self.mark(of:)))
        var next = seen
        for tab in Tab.allCases where next[tab] == nil {
            next[tab] = Set(Self.threads(on: tab, in: lists, inbox: nil, now: now).map(Self.mark(of:)))
        }
        if let looking {
            next[looking, default: []].formUnion(
                Self.threads(on: looking, in: lists, inbox: inbox, now: now).map(Self.mark(of:)))
        }
        for tab in Tab.allCases {
            next[tab]?.formIntersection(held)
        }
        guard next != seen else { return }
        seen = next
        defaults.set(
            Dictionary(uniqueKeysWithValues: next.map { ($0.key.rawValue, $0.value.sorted()) }),
            forKey: Self.defaultsKey)
    }

    /// What `update` looks at, so it runs only when one of them changes.
    struct Look: Equatable {
        let lists: MailLists
        let inbox: String?
        let looking: Tab?
        let loaded: Bool
    }
}
