import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// Each sidebar destination is its own stack (owner's words of 2026-11-20: "the stuff from sidebar will each be their
/// own stack"): the mail stack (the switcher's profiles), To reply, Pinned, Snoozed, the Inbox page and Settings. Each
/// keeps its state while the app runs; none has a way back; search opens over any of them with the one back capsule.
@MainActor
struct StacksTests {
    static let lists: [Destination] = [.toReply, .pinned, .snoozed, .inbox]

    /// A navigation on `destination`, reached the way the person reaches it.
    private func on(_ destination: Destination) -> Navigation {
        var nav = Navigation()
        nav.go(to: destination)
        return nav
    }

    // MARK: The top row

    @Test func eachStacksTopRow() {
        // The mail stack: the four tabs and the screening capsule, as before.
        let mail = Tab.allCases.map(TopBar.Item.tab) + [.gap, .screening]
        #expect(TopBar.items(place: Navigation().place, reading: false) == mail)
        #expect(TopBar.items(place: .screening, reading: false) == mail)
        // Settings: only its five tabs, no capsule back.
        #expect(
            TopBar.items(place: on(.settings).place, reading: false)
                == [.gap] + SettingsTab.allCases.map(TopBar.Item.settings))
        // To reply, Pinned, Snoozed and the Inbox page: the quiet title capsule in the tabs' place, nothing to go back
        // to.
        for destination in Self.lists {
            let nav = on(destination)
            #expect(TopBar.items(place: nav.place, reading: false) == [.title, .gap])
            #expect(!nav.showsTabs)
        }
        // Not one stack has the back capsule.
        for destination in Destination.allCases {
            #expect(!TopBar.items(place: on(destination).place, reading: false).contains(.back))
        }
    }

    @Test func theTitleCapsuleNamesThePage() {
        let names = Self.lists.map { on($0).place }
        #expect(names.map(\.title) == ["To reply", "Pinned", "Snoozed", "Inbox"])
        #expect(names.map(\.icon) == [.toReply, .pinned, .snoozed, .inbox])
    }

    @Test func aMailOpenKeepsItsOwnRowInEveryStack() {
        // From a list, its title capsule becomes the back to it, the mail's actions after it.
        for destination in Self.lists {
            var nav = on(destination)
            nav.open("thr_1")
            #expect(
                TopBar.items(place: nav.place, reading: true) == [.title, .gap]
                    + BarAction.mailActions.map(TopBar.Item.action))
        }
        // From a tab, as before: the tab is the back.
        #expect(
            TopBar.items(place: .tab(.receipts), reading: true)
                == [.tab(.receipts), .gap] + BarAction.mailActions.map(TopBar.Item.action))
    }

    @Test func onlyTheInboxPageIsWide() {
        for destination in Destination.allCases {
            #expect(on(destination).wide == (destination == .inbox))
        }
    }

    // MARK: The switcher

    @Test func theSwitcherIsMarkedOnlyInTheMailStack() {
        var nav = Navigation()
        #expect(nav.profileMark.marks(nil) && !nav.profileMark.marks("inb_harbor"))
        nav.choose(profile: "inb_harbor")
        #expect(nav.profileMark.marks("inb_harbor") && !nav.profileMark.marks(nil))
        for destination in Destination.allCases where destination != .mail {
            nav.go(to: destination)
            // Nothing marked: no inbox, and not every inbox.
            #expect(!nav.profileMark.marks("inb_harbor") && !nav.profileMark.marks(nil))
            #expect(nav.activeProfile == nil)
        }
    }

    @Test func aProfileClickedElsewhereGoesToTheMailStackAtItsLastTab() {
        var nav = Navigation()
        nav.mailPlace = .tab(.notifications)
        nav.go(to: .snoozed)
        nav.choose(profile: "inb_northwind")
        #expect(nav.destination == .mail && nav.place == .tab(.notifications) && nav.activeProfile == "inb_northwind")
        // Screening is the mail stack's too.
        nav.mailPlace = .screening
        nav.go(to: .settings)
        nav.choose(profile: nil)
        #expect(nav.place == .screening && nav.profileMark.marks(nil))
    }

    // MARK: Each stack's state

    @Test func switchingStacksAndBackKeepsEachOnesState() {
        var nav = Navigation()
        nav.choose(profile: "inb_harbor")
        nav.mailPlace = .tab(.receipts)
        nav.open("thr_1")
        nav.go(to: .pinned)
        #expect(nav.place == .pinned && nav.reading == nil)
        nav.open("thr_10")
        nav.go(to: .settings)
        nav.settingsTab = .blocked
        nav.go(to: .inbox)
        #expect(nav.reading == nil)

        // The same profile again: Receipts, its mail still open.
        nav.choose(profile: "inb_harbor")
        #expect(nav.place == .tab(.receipts) && nav.reading == "thr_1" && nav.activeProfile == "inb_harbor")
        nav.go(to: .pinned)
        #expect(nav.reading == "thr_10")
        nav.go(to: .settings)
        #expect(nav.settingsTab == .blocked && nav.reading == nil)

        // Another profile: the tab it last had, its mail closed, as switching profile always did.
        nav.choose(profile: "inb_personal")
        #expect(nav.place == .tab(.receipts) && nav.reading == nil)
        // Another tab closes the mail open in the mail stack too, as before.
        nav.open("thr_2")
        nav.mailPlace = .tab(.home)
        #expect(nav.reading == nil)
        // A new launch starts again: nothing is kept on disk.
        #expect(Navigation(place: .settings).settingsTab == .accounts)
    }

    @Test func theCurrentStacksButtonAgainDoesNothing() {
        for destination in Destination.allCases where destination != .mail {
            var nav = on(destination)
            if destination != .settings { nav.open("thr_1") }
            let before = nav
            nav.press(nav.place)
            #expect(nav == before)
        }
        // Each button lights only while its stack shows; none in the mail stack.
        #expect(Navigation().place.destination == .mail)
        #expect(on(.settings).place == .settings && on(.toReply).place == .toReply)
    }

    @Test func settingsHoldsNoMail() {
        var nav = on(.settings)
        nav.open("thr_1")
        #expect(nav.reading == nil)
        #expect(Navigation(place: .settings, reading: "thr_1").reading == nil)
    }

    // MARK: Esc

    @Test func escInAStackClosesTheMailElseDoesNothing() {
        for destination in Destination.allCases {
            var nav = on(destination)
            let before = nav
            nav.back()
            #expect(nav == before)
            if destination != .settings {
                nav.open("thr_1")
                nav.back()
                #expect(nav == before)
            }
        }
    }

    // MARK: Search

    @Test func searchOpensOverAnyStackAndLeavesItAsItWas() {
        var ready: [(Navigation, String)] = []
        var mail = Navigation()
        mail.mailPlace = .tab(.receipts)
        mail.open("thr_1")
        ready.append((mail, "Receipts"))
        for destination in Destination.allCases where destination != .mail {
            var nav = on(destination)
            if destination != .settings { nav.open("thr_9") }
            ready.append((nav, nav.place.title))
        }
        for (stack, words) in ready {
            var nav = stack
            nav.openSearch()
            #expect(nav.place == .search && nav.reading == nil && nav.wide && !nav.showsTabs)
            // "← Receipts", "← To reply", "← Settings": where the person was.
            #expect(nav.searchReturnTitle == words)
            #expect(TopBar.items(place: nav.place, reading: false) == [.back, .gap])
            // A mail from the results, then back to them.
            nav.open("thr_s")
            #expect(nav.reading == "thr_s" && nav.place == .search)
            #expect(TopBar.items(place: nav.place, reading: true).first == .back && Place.search.title == "Search")
            nav.back()
            #expect(nav.place == .search && nav.reading == nil)
            // The capsule, or Esc once the field is clear (`SearchKeys`): exactly the stack as it was.
            nav.back()
            #expect(nav == stack)
        }
    }

    @Test func escOnSearchClearsFirstThenLeaves() {
        #expect(SearchKeys.escape(hasQuery: true) == .clear)
        #expect(SearchKeys.escape(hasQuery: false) == .leave)
        var nav = on(.pinned)
        let before = nav
        nav.openSearch()
        nav.leaveSearch()
        #expect(nav == before)
    }

    @Test func commandKOnSearchGoesBackToTheResults() {
        var nav = on(.snoozed)
        nav.openSearch()
        nav.open("thr_s")
        nav.openSearch()
        #expect(nav.place == .search && nav.reading == nil)
        // The magnifier does the same as ⌘K.
        nav.open("thr_s")
        nav.press(.search)
        #expect(nav.place == .search && nav.reading == nil)
        // Opened again later, search starts at its results.
        nav.open("thr_s")
        nav.leaveSearch()
        nav.openSearch()
        #expect(nav.reading == nil)
    }

    @Test func aStacksButtonFromSearchLeavesItForThatStack() {
        var nav = on(.pinned)
        nav.open("thr_10")
        nav.openSearch()
        // Its own stack's button: back to it as it was.
        nav.press(.pinned)
        #expect(nav.place == .pinned && nav.reading == "thr_10")
        nav.openSearch()
        nav.press(.settings)
        #expect(nav.place == .settings)
    }

    @Test func aProfileChosenOnSearchScopesItAndPutsTheMailStackUnder() {
        var nav = on(.toReply)
        nav.openSearch()
        // Over a list no profile is active: search looks in every inbox.
        #expect(nav.activeProfile == nil && !nav.profileMark.marks(nil))
        nav.open("thr_s")
        nav.choose(profile: "inb_harbor")
        // Search stays, now in that inbox, back at its results; the mail stack is under it.
        #expect(nav.place == .search && nav.reading == nil && nav.activeProfile == "inb_harbor")
        #expect(nav.profileMark.marks("inb_harbor") && nav.searchReturnTitle == "Home")
        nav.leaveSearch()
        #expect(nav.destination == .mail && nav.place == .tab(.home))
    }

    @Test func theAISettingsLinkGoesToTheSettingsStackOnItsTab() {
        var nav = Navigation()
        nav.mailPlace = .tab(.receipts)
        nav.openSearch()
        nav.openSettings(.ai)
        #expect(nav.place == .settings && nav.settingsTab == .ai && !nav.wide)
        // No way back from a stack; ⌘K finds search again, and its results are the window's (`SearchModel`).
        nav.back()
        #expect(nav.place == .settings)
        nav.choose(profile: nil)
        #expect(nav.place == .tab(.receipts))
    }

    // MARK: Scope and counts

    @Test func theListsOutsideTheMailStackShowEveryInbox() async throws {
        let store = try await MailStore.sample()
        var nav = Navigation()
        nav.choose(profile: "inb_northwind")
        // In that profile, the To reply list would be empty (the harbour shoot is in another inbox).
        #expect(RailList(store.lists, place: .toReply, inbox: "inb_northwind").threads.isEmpty)
        for place: Place in [.toReply, .pinned, .snoozed] {
            nav.press(place)
            #expect(nav.activeProfile == nil)
            #expect(
                RailList(store.lists, place: place, inbox: nav.activeProfile)
                    == RailList(store.lists, place: place, inbox: nil))
        }
        #expect(RailList(store.lists, place: .toReply, inbox: nav.activeProfile).threads.map(\.id) == ["thr_7"])
        nav.press(.inbox)
        #expect(
            AllMailList(store.lists, inbox: nav.activeProfile, now: store.now).threads.map(\.id)
                == AllMailList(store.lists, inbox: nil, now: store.now).threads.map(\.id))
    }

    @Test func theRailsCountsAreAlwaysTheOverallOnes() {
        let counts = Counts(
            all: ThreadCounts(stacks: [.replyLater: 3, .setAside: 7], waiting: 4),
            inboxes: [
                InboxCounts(inboxId: "inb_a", counts: ThreadCounts(stacks: [.replyLater: 1, .setAside: 0], waiting: 4))
            ],
            version: 1)
        #expect(RailCount.count(.toReply, in: counts) == 3)
        #expect(RailCount.count(.pinned, in: counts) == 7)
        #expect(RailCount.count(.snoozed, in: counts) == 4)
    }

    @Test func eachListsScrollIsKeptUntilForgotten() {
        let scrolls = ScrollPlaces()
        let home = ScrollPlaces.Key(place: .tab(.home), inbox: "inb_harbor")
        let pinned = ScrollPlaces.Key(place: .pinned, inbox: nil)
        let ids: [ListRowID] = [.row("thr_1"), .row("thr_2"), .row("thr_3")]
        #expect(scrolls.top(home, in: ids).wrappedValue == nil && scrolls.top(pinned).wrappedValue == nil)
        scrolls.top(home, in: ids).wrappedValue = .row("thr_2")
        scrolls.top(pinned).wrappedValue = "thr_10"
        // Another profile's Home is another list.
        #expect(scrolls.top(home, in: ids).wrappedValue == .row("thr_2"))
        #expect(scrolls.top(.init(place: .tab(.home), inbox: nil), in: ids).wrappedValue == nil)
        #expect(scrolls.kept(pinned).places.top(pinned).wrappedValue == "thr_10")
        // Another tab or profile in the mail stack forgets the one left, so it starts at the top again.
        scrolls.forget(home)
        #expect(scrolls.top(home, in: ids).wrappedValue == nil && scrolls.top(pinned).wrappedValue == "thr_10")
    }

    /// The row kept at a list's top, found where it is now; once it has left the list (read and moved to Seen,
    /// archived), the row now in its place, or the last row when the list got shorter.
    @Test func aKeptTopRowThatLeftGivesWayToTheOneInItsPlace() {
        let scrolls = ScrollPlaces()
        let key = ScrollPlaces.Key(place: .tab(.receipts), inbox: nil)
        let rows = { (ids: [String]) in ids.map { ListRowID.row($0) } }
        scrolls.top(key, in: rows(["a", "b", "c", "d"])).wrappedValue = .row("c")
        // New mail above it: still the same row.
        #expect(scrolls.top(key, in: rows(["new", "a", "b", "c", "d"])).wrappedValue == .row("c"))
        // It left: the row now third from the top, where it was.
        #expect(scrolls.top(key, in: rows(["a", "b", "d"])).wrappedValue == .row("d"))
        #expect(scrolls.top(key, in: rows(["a", "b"])).wrappedValue == .row("b"))
        #expect(scrolls.top(key, in: []).wrappedValue == nil)
        // A row that moved on its own, new mail sorting it to the top, leaves the list where it was: the row that was
        // under it is the place (the review of 2026-11-28).
        let many = (0..<300).map { ListRowID.row("r\($0)") }
        scrolls.top(key, in: many).wrappedValue = many[150]
        var sorted = many
        sorted.insert(sorted.remove(at: 150), at: 0)
        let place = scrolls.top(key, in: sorted).wrappedValue.flatMap { sorted.firstIndex(of: $0) }
        #expect(place == 151 && sorted[151] == .row("r151"))
        // Rows coming above it in a body, more than a screenful, move it with the rows around it: still the same row.
        scrolls.top(key, in: many).wrappedValue = many[150]
        let newer = (0..<40).map { ListRowID.row("new\($0)") } + many
        #expect(scrolls.top(key, in: newer).wrappedValue == .row("r150"))
        // Its place is kept up to date, so it leaving after them is found where it was then, not 40 rows up.
        let left = newer.filter { $0 != .row("r150") }
        #expect(scrolls.top(key, in: left).wrappedValue == .row("r151"))
        // The words above the rows at the top (Screening's count): the list's top.
        scrolls.top(key, in: rows(["a"])).wrappedValue = .words("count")
        #expect(scrolls.top(key, in: rows(["a"])).wrappedValue == nil)
        // A title's id and a row's never meet, and a row moved to another section is another row there.
        let titled = TitledRows([(title: "New", rows: [Row(id: "New")]), (title: "Seen", rows: [Row(id: "x")])])
        #expect(titled.ids == [.title("New"), .row("New", section: "New"), .title("Seen"), .row("x", section: "Seen")])
        #expect(Set(titled.ids + [.words("New"), Row(id: "New").rowID]).count == 6)
    }

    private struct Row: Identifiable {
        let id: String
    }

    // MARK: Launch

    @Test func launchOptionsLandOnEachPlace() {
        let given: [(String, Place, Destination)] = [
            ("home", .tab(.home), .mail), ("reads", .tab(.reads), .mail), ("receipts", .tab(.receipts), .mail),
            ("notifications", .tab(.notifications), .mail), ("screening", .screening, .mail),
            ("reply", .toReply, .toReply), ("pinned", .pinned, .pinned), ("snoozed", .snoozed, .snoozed),
            ("inbox", .inbox, .inbox), ("settings", .settings, .settings), ("search", .search, .mail),
        ]
        for (option, place, destination) in given {
            let parsed = LaunchOptions { $0 == "UsualMailPlace" ? option : nil }.place
            let nav = Navigation(place: parsed ?? .tab(.home), reading: "thr_1", profile: "inb_harbor")
            #expect(nav.place == place && nav.destination == destination)
            // The thread is read in the card, settings aside; the profile is the mail stack's.
            #expect(nav.reading == (place == .settings ? nil : "thr_1"))
            #expect(nav.profile == "inb_harbor")
            #expect(nav.activeProfile == (destination == .mail ? "inb_harbor" : nil))
        }
        // Search at launch is over Home: leaving it lands there.
        var search = Navigation(place: .search)
        search.leaveSearch()
        #expect(search.place == .tab(.home))
    }
}
