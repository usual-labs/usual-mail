import CoreGraphics
import Testing

@testable import UsualMailUI

/// The classic inbox (owner's request of 2026-11-19), a stack of its own (owner's words of 2026-11-20): the card widens
/// and the tabs hide while it shows, its title in their place and no way back; the rail's other buttons and the
/// switcher leave it, and coming back finds it as it was left.
@MainActor
struct InboxPageTests {
    @Test func theRailsInboxButtonEntersWideWithTheTabsHidden() {
        var nav = Navigation(place: .tab(.reads))
        #expect(!nav.wide && nav.showsTabs)
        nav.press(.inbox)
        #expect(nav.place == .inbox && nav.destination == .inbox)
        #expect(nav.wide && !nav.showsTabs)
        // Its title, no "← Feed": nothing to go back to.
        #expect(TopBar.items(place: nav.place, reading: false) == [.title, .gap])
        // The mail stack stays on Feed underneath, for when a profile brings it back.
        #expect(nav.mailPlace == .tab(.reads))
    }

    @Test func itsButtonAgainAndEscDoNothing() {
        var nav = Navigation(place: .tab(.receipts))
        nav.press(.inbox)
        let before = nav
        nav.press(.inbox)
        #expect(nav == before)
        nav.back()
        #expect(nav == before)
        // A profile leaves it, at the tab the mail stack last had.
        nav.choose(profile: nil)
        #expect(nav.place == .tab(.receipts) && !nav.wide && nav.showsTabs)
        // Opened at launch, too: the switcher goes to Home.
        var launched = Navigation(place: .inbox)
        #expect(launched.wide && launched.place == .inbox)
        launched.choose(profile: nil)
        #expect(launched.place == .tab(.home))
    }

    @Test func aMailOpenedFromItStaysWideWithItsOwnRowAndBackReturnsToTheList() {
        var nav = Navigation(place: .tab(.home))
        nav.press(.inbox)
        nav.open("thr_1")
        #expect(nav.reading == "thr_1" && nav.place == .inbox)
        #expect(nav.wide && !nav.showsTabs)
        // Esc or "← Inbox": back to the list, still wide, the tabs still hidden.
        nav.back()
        #expect(nav.reading == nil && nav.place == .inbox && nav.wide && !nav.showsTabs)
        // Leaving with a mail open keeps it there for the way back.
        nav.open("thr_2")
        nav.press(.settings)
        #expect(nav.place == .settings && nav.reading == nil && !nav.wide)
        nav.press(.inbox)
        #expect(nav.place == .inbox && nav.reading == "thr_2" && nav.wide)
    }

    @Test func otherStacksNarrowTheCardSearchKeepsItWide() {
        var nav = Navigation(place: .tab(.home))
        nav.press(.inbox)
        nav.press(.settings)
        #expect(nav.place == .settings && !nav.wide && !nav.showsTabs)
        nav.press(.inbox)
        // Search over it stays wide, and leaving it is the Inbox page again.
        nav.press(.search)
        #expect(nav.place == .search && nav.wide && nav.searchReturnTitle == "Inbox")
        nav.leaveSearch()
        #expect(nav.place == .inbox && nav.wide)
    }

    @Test func theBarOnTheClassicInbox() {
        // With a mail open, its title turned back ("← Inbox") and the mail's actions.
        #expect(
            TopBar.items(place: .inbox, reading: true)
                == [.title, .gap] + BarAction.mailActions.map(TopBar.Item.action))
    }

    @Test func theCardWidensBy200WhereThereIsRoomAndTheRailStays() {
        func layouts(_ width: CGFloat) -> (MailLayout, MailLayout) {
            let size = CGSize(width: width, height: 900)
            return (MailLayout(size: size), MailLayout(size: size, wide: true))
        }
        func railX(_ layout: MailLayout, _ width: CGFloat) -> CGFloat {
            (width - 2 * layout.side - 2 * MailLayout.gap - layout.center) / 2 + layout.railInset
        }
        // The design's window: 700 → 900, the sides 300 → 200, the rail where it was, 96 from the edge.
        let (design, designWide) = layouts(1512)
        #expect(design.center == 700 && design.side == 300)
        #expect(designWide.center == 900 && designWide.side == 200)
        #expect(railX(design, 1512) == 96 && railX(designWide, 1512) == 96)
        // Where the row first fills the window: the same, the rail 12 from the edge.
        let (full, fullWide) = layouts(1320)
        #expect(full.center == 700 && full.side == 300)
        #expect(fullWide.center == 900 && fullWide.side == 200)
        #expect(railX(full, 1320) == 12 && railX(fullWide, 1320) == 12)
        // Narrower sides already: still the whole 200, the sides down to 90.
        let (mid, midWide) = layouts(1100)
        #expect(mid.center == 700 && mid.side == 190)
        #expect(midWide.center == 900 && midWide.side == 90)
        #expect(railX(mid, 1100) == 12 && railX(midWide, 1100) == 12)
        // Only what the sides can give above the rail's 56.
        let (_, smallWide) = layouts(900)
        #expect(smallWide.center == 768 && smallWide.side == 56)
        // The smallest window has no room: the same.
        let (narrow, narrowWide) = layouts(820)
        #expect(narrow == narrowWide)
        #expect(narrowWide.center == 688 && narrowWide.side == 56 && narrowWide.railInset == 12)
    }
}
