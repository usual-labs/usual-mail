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
        // Settings is a stack of its own, with its own button: the switcher names it and ticks nothing.
        nav.press(.settings)
        #expect(PhoneSwitch.label(nav: nav, inboxes: inboxes) == PhoneSwitch(icon: .settings, title: "Settings"))
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
        #expect(PhoneSwitch.addGmail.count <= PhoneSwitch.menuLength)
    }

    // MARK: The row at the card's foot

    @Test func theCompactRowKeepsTheTabsAndTheMailsButtons() {
        // On a tab's page and with a mail open, the items are the Mac's.
        for reading in [false, true] {
            for place in Tab.allCases.map(Place.tab) + [.screening, .search] {
                #expect(
                    TopBar.items(place: place, reading: reading, compact: true)
                        == TopBar.items(place: place, reading: reading))
                #expect(!TopBar.centres(place: place, compact: true))
            }
        }
    }

    @Test func settingsTabsSitInTheMiddleOnTheIPhoneOnly() {
        // The iPhone's row has Settings' five tabs with no gap before them, centred; the Mac's keeps the gap, which
        // puts them at the right.
        let tabs = SettingsTab.allCases.map(TopBar.Item.settings)
        #expect(TopBar.items(place: .settings, reading: false, compact: true) == tabs)
        #expect(TopBar.centres(place: .settings, compact: true))
        #expect(TopBar.items(place: .settings, reading: false) == [.gap] + tabs)
        #expect(!TopBar.centres(place: .settings, compact: false))
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
