import Testing

@testable import UsualMailUI

/// To reply, Pinned and Snoozed as the rail's buttons (owner's request of 2026-11-19): places of their own between the
/// switch and the classic inbox, each a stack of its own (owner's words of 2026-11-20), shown in the normal card with
/// no tab chosen and their title in the tabs' place (`StacksTests`).
@MainActor
struct RailPlacesTests {
    @Test func theyAreTheRailsListsInOrderWithTheirNamesAndIcons() {
        #expect(Rail.lists == [.toReply, .pinned, .snoozed])
        #expect(Rail.lists.map(\.title) == ["To reply", "Pinned", "Snoozed"])
        #expect(Rail.lists.map(\.icon) == [.toReply, .pinned, .snoozed])
        // Each its own stack.
        #expect(Rail.lists.map(\.destination) == [.toReply, .pinned, .snoozed])
    }

    @Test func aRailListChosenLeavesNoTabChosenAndTheReverse() {
        var nav = Navigation(place: .tab(.reads))
        nav.press(.toReply)
        #expect(nav.place == .toReply)
        #expect(nav.place.tab == nil)
        // The normal card, not wide; the tabs hidden, still on Feed for when the mail stack comes back.
        #expect(!nav.wide && !nav.showsTabs && nav.mailPlace == .tab(.reads))

        // From one list to the next: only the new one is chosen.
        nav.press(.pinned)
        #expect(nav.place == .pinned && Rail.lists.filter { $0 == nav.place } == [.pinned])

        // A profile in the switcher brings the tabs back, Feed chosen, and no rail button is chosen any more.
        nav.choose(profile: nil)
        #expect(nav.place == .tab(.reads) && nav.showsTabs)
        #expect(!(Rail.lists + [.search, .inbox, .settings]).contains(nav.place))
    }

    @Test func choosingOneLeavesTheOpenMailInItsOwnStack() {
        var nav = Navigation(place: .tab(.home))
        nav.open("thr_1")
        nav.press(.pinned)
        #expect(nav.place == .pinned && nav.reading == nil)
        nav.choose(profile: nil)
        #expect(nav.place == .tab(.home) && nav.reading == "thr_1")
    }

    @Test func noStackOffersAWayBackToAnother() {
        let origins: [Place] = [
            .tab(.home), .tab(.reads), .tab(.receipts), .tab(.notifications), .toReply, .pinned, .snoozed, .screening,
            .settings,
        ]
        for origin in origins {
            var nav = Navigation(place: origin)
            nav.press(.inbox)
            #expect(nav.place == .inbox && TopBar.items(place: nav.place, reading: false) == [.title, .gap])
            // Esc with no mail open does nothing.
            nav.back()
            #expect(nav.place == .inbox)
        }
    }
}
