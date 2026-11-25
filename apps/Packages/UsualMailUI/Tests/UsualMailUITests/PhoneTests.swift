import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The iPhone's shell (the owner's concept of 2026-11-20), as far as a Mac can test it: what the switcher in its top
/// row says and ticks, the row at the card's foot (the Mac's row, compact), and what shows without a pointer.
@MainActor
struct PhoneTests {
    let inboxes = SampleData.bundled.inboxes

    // MARK: The switcher

    @Test func theSwitcherNamesTheProfileInTheMailStack() throws {
        // Every inbox at first, whichever tab shows.
        var nav = Navigation()
        #expect(PhoneSwitch.label(nav: nav, inboxes: inboxes) == PhoneSwitch(icon: .allInboxes, title: "All inboxes"))
        nav.mailPlace = .tab(.receipts)
        #expect(PhoneSwitch.label(nav: nav, inboxes: inboxes).title == "All inboxes")
        // An inbox by its address and its own icon, as the concept draws it.
        let inbox = try #require(inboxes.first)
        nav.choose(profile: inbox.id)
        #expect(
            PhoneSwitch.label(nav: nav, inboxes: inboxes)
                == PhoneSwitch(icon: Icon(inbox.icon), title: inbox.address))
        // An inbox that is gone reads as every inbox.
        #expect(PhoneSwitch.label(nav: nav, inboxes: []).title == "All inboxes")
    }

    @Test func theSwitcherNamesTheOtherStacks() {
        for page in PhoneSwitch.pages {
            var nav = Navigation()
            nav.press(page)
            #expect(PhoneSwitch.label(nav: nav, inboxes: inboxes) == PhoneSwitch(icon: page.icon, title: page.title))
            #expect(PhoneSwitch.pages.filter { PhoneSwitch.ticks($0, nav: nav) } == [page])
            // No profile is ticked outside the mail stack.
            #expect(!nav.profileMark.marks(nil))
        }
        // Its pages are the rail's lists and the Inbox page, in the rail's order.
        #expect(PhoneSwitch.pages == Rail.lists + [.inbox])
    }

    @Test func searchAndSettingsLeaveTheSwitcherOnTheStack() {
        // Search is over the stack: the switcher still names it, and its page stays ticked.
        var nav = Navigation()
        nav.press(.pinned)
        nav.press(.search)
        #expect(nav.place == .search)
        #expect(PhoneSwitch.label(nav: nav, inboxes: inboxes).title == "Pinned")
        #expect(PhoneSwitch.ticks(.pinned, nav: nav))
        // Settings is a stack of its own, the menu's last row (the owner's words of 2026-11-25): the switcher names
        // it and ticks it alone.
        #expect(!PhoneSwitch.ticks(.settings, nav: nav))
        nav.press(.settings)
        #expect(PhoneSwitch.label(nav: nav, inboxes: inboxes) == PhoneSwitch(icon: .settings, title: "Settings"))
        #expect(PhoneSwitch.ticks(.settings, nav: nav))
        #expect(PhoneSwitch.pages.allSatisfy { !PhoneSwitch.ticks($0, nav: nav) })
        // A profile chosen from there goes back to the mail stack.
        nav.choose(profile: nil)
        #expect(nav.place == .tab(.home) && nav.profileMark.marks(nil))
    }

    @Test func theMenuCutsLongWordsInTheMiddle() {
        // The system's menu wraps what is long; the words are cut to one line before they reach it, keeping an
        // address's domain.
        #expect(PhoneSwitch.menuTitle("All inboxes") == "All inboxes")
        #expect(PhoneSwitch.menuTitle("sixteen-letters!") == "sixteen-letters!")
        #expect(PhoneSwitch.menuTitle("someone@far-away.example") == "someon…y.example")
        #expect(PhoneSwitch.menuTitle("someone@far-away.example").count == PhoneSwitch.menuLength)
        #expect(Place.settings.title.count <= PhoneSwitch.menuLength)
    }

    // MARK: The row at the card's foot

    @Test func theCompactRowKeepsTheTabsAndTheMailsButtons() {
        // On a tab's page and with a mail open, the items are the Mac's.
        for reading in [false, true] {
            for place in Tab.allCases.map(Place.tab) + [.screening, .search] {
                #expect(
                    TopBar.items(place: place, reading: reading, compact: true)
                        == TopBar.items(place: place, reading: reading))
            }
        }
    }

    @Test func settingsHasABackButtonOnTheIPhoneOnly() {
        // The owner's words of 2026-11-25: "move the bottom glass tabs to right and on left put an back button". The
        // iPhone's row is the back button, a gap, then the five tabs at the right; the Mac's has no back button.
        let tabs = SettingsTab.allCases.map(TopBar.Item.settings)
        #expect(TopBar.items(place: .settings, reading: false, compact: true) == [.leave, .gap] + tabs)
        #expect(TopBar.items(place: .settings, reading: false) == [.gap] + tabs)
    }

    @Test func theRowIsMeasuredAsItIsDrawn() {
        // Every word 7 points a letter. An icon's capsule is round; one with words is its insets, its icon, 6 and the
        // words; the screening capsule's insets are 10 and its gap 4; a gap is at its least; spacing between all.
        let words: (String) -> CGFloat = { CGFloat($0.count) * 7 }
        let round = max(ControlSize.height, 2 * ControlSize.inset + ControlSize.icon)
        let named = 2 * ControlSize.inset + ControlSize.icon + 6 + 4 * 7
        let screening = 2 * 10 + ControlSize.icon + 4 + 7
        let items: [TopBar.Item] = [.tab(.home), .tab(.reads), .tab(.receipts), .tab(.notifications), .gap, .screening]
        let titles: [TopBar.Item: String] = [.tab(.home): "Home", .screening: "3"]
        #expect(
            BarFit.width(items, title: { titles[$0] }, words: words)
                == named + 3 * round + ControlSize.spacing + screening + 5 * ControlSize.spacing)
        // Nothing named: every capsule round but the count's.
        #expect(
            BarFit.width(items, title: { $0 == .screening ? "3" : nil }, words: words)
                == 4 * round + ControlSize.spacing + screening + 5 * ControlSize.spacing)
    }

    @Test func theCompactRowHasNoTitleCapsule() {
        // The switcher above the card names To reply, Pinned, Snoozed and the Inbox page; the row is empty until a
        // mail is open, when it is the back button and the mail's five buttons, as on the Mac.
        for place in PhoneSwitch.pages {
            #expect(TopBar.items(place: place, reading: false, compact: true).isEmpty)
            #expect(TopBar.items(place: place, reading: false) == [.title, .gap])
            #expect(
                TopBar.items(place: place, reading: true, compact: true)
                    == [.title, .gap] + BarAction.mailActions.map(TopBar.Item.action))
        }
    }

    // MARK: Without a pointer

    @Test func theMacHasAPointer() {
        // On the Mac a row's time and a seen row's tick wait for the pointer; the iPhone, which has none, shows them
        // always (`Pointer.exists` is false there, which only an iPhone build can check).
        #expect(Pointer.exists)
        #expect(Theme.pageInset == 24)
    }
}
