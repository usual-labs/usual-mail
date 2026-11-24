import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The row above the card: the four tabs on a page; with a mail open the chosen tab as back and the mail's actions.
@MainActor
struct TopBarTests {
    @Test func onAPageTheTabsThenTheScreeningQueue() {
        let items = TopBar.items(place: .tab(.home), reading: false)
        #expect(items == Tab.allCases.map(TopBar.Item.tab) + [.gap, .screening])
    }

    @Test func theTabsAreExactlyTheFour() {
        // To reply, Pinned and Snoozed are the rail's (owner's request of 2026-11-19).
        let four: [TopBar.Item] = [.tab(.home), .tab(.reads), .tab(.receipts), .tab(.notifications), .gap, .screening]
        #expect(TopBar.items(place: .tab(.receipts), reading: false) == four)
        // The rail's lists and the classic inbox are stacks of their own, their title in the tabs' place (owner's words
        // of 2026-11-20); search has its capsule back; Settings its own tabs (`SettingsTabsTests`).
        for place in Rail.lists + [.inbox] {
            #expect(TopBar.items(place: place, reading: false) == [.title, .gap])
            #expect(place.tab == nil && place.destination != nil && place.destination != .mail)
        }
        #expect(TopBar.items(place: .search, reading: false) == [.back, .gap] && Place.search.destination == nil)
        #expect(Place.settings.tab == nil && Place.settings.destination == .settings)
        #expect(Tab.allCases.allSatisfy { Place.tab($0).destination == .mail } && Place.screening.destination == .mail)
    }

    @Test func fromHomeTheMailsButtonsPopIn() {
        // Home stays first as the back button; reply later, pin, snooze, archive and more pop in; Feed, Receipts,
        // Notifications and the screening queue leave.
        #expect(
            TopBar.items(place: .tab(.home), reading: true)
                == [
                    .tab(.home), .gap, .action(.replyLater), .action(.pin), .action(.snooze), .action(.archive),
                    .action(.more),
                ])
    }

    @Test func aChosenTabIsTheBackButton() {
        // From Notifications, as from Receipts: it is the back button and the other category tabs leave.
        #expect(
            TopBar.items(place: .tab(.notifications), reading: true)
                == [.tab(.notifications), .gap] + BarAction.mailActions.map(TopBar.Item.action))
        // From the rail's lists and the classic inbox: their title turned back ("← Pinned") and the mail's actions;
        // from search, its capsule ("← Search").
        for place in Rail.lists + [.inbox] {
            #expect(
                TopBar.items(place: place, reading: true) == [.title, .gap]
                    + BarAction.mailActions.map(TopBar.Item.action))
        }
        #expect(
            TopBar.items(place: .search, reading: true) == [.back, .gap] + BarAction.mailActions.map(TopBar.Item.action)
        )
    }

    @Test func fromScreeningItsCapsuleLeadsAndLetInBlockMorePopIn() {
        #expect(
            TopBar.items(place: .screening, reading: true)
                == [.screening, .gap, .action(.letIn), .action(.block), .action(.more)])
        #expect(
            TopBar.items(place: .screening, reading: false) == Tab.allCases.map(TopBar.Item.tab) + [.gap, .screening])
        #expect(BarAction.letIn.input == .allowSender && BarAction.block.input == .blockSender)
    }

    @Test func whatEachActionIs() {
        #expect(BarAction.replyLater.input == .stack(.replyLater))
        #expect(BarAction.pin.input == .stack(.setAside))
        #expect(BarAction.snooze.input == nil)
        #expect(BarAction.archive.input == .done)
        #expect(BarAction.more.input == nil)
        // The rail's lists and the actions that fill them share their icons.
        #expect(BarAction.replyLater.icon == Place.toReply.icon)
        #expect(BarAction.pin.icon == Place.pinned.icon)
        #expect(BarAction.snooze.icon == Place.snoozed.icon)
    }

    @Test func aMailAlreadyThereGetsTheWayBackDrawnChosen() {
        let now = MailJSON.parseTime("2026-11-18T10:00:00Z")!
        func mail(stack: Stack? = nil, comeBackAt: Date? = nil) -> MailThread {
            MailThread(
                id: "thr_x", inboxId: "inb_northwind", subject: "Lease", lastMessageAt: now, stack: stack,
                comeBackAt: comeBackAt)
        }
        // Nowhere yet: each adds, unchosen; snooze and more open their menus.
        let plain = mail()
        #expect(
            BarAction.replyLater.button(for: plain, now: now)
                == BarButton(title: "Reply later", input: .stack(.replyLater), chosen: false))
        #expect(
            BarAction.pin.button(for: plain, now: now)
                == BarButton(title: "Pin", input: .stack(.setAside), chosen: false))
        #expect(BarAction.snooze.button(for: plain, now: now) == BarButton(title: "Snooze", input: nil, chosen: false))
        #expect(BarAction.more.button(for: plain, now: now).input == nil)
        #expect(
            BarAction.archive.button(for: plain, now: now) == BarButton(title: "Archive", input: .done, chosen: false))

        // On To reply: the way back, chosen; pin moves it to Pinned.
        let toReply = mail(stack: .replyLater)
        #expect(
            BarAction.replyLater.button(for: toReply, now: now)
                == BarButton(title: "Remove from To reply", input: .unstack, chosen: true))
        #expect(
            BarAction.pin.button(for: toReply, now: now)
                == BarButton(title: "Pin", input: .stack(.setAside), chosen: false))

        // Pinned.
        let pinned = mail(stack: .setAside)
        #expect(BarAction.pin.button(for: pinned, now: now) == BarButton(title: "Unpin", input: .unstack, chosen: true))
        #expect(BarAction.replyLater.button(for: pinned, now: now).chosen == false)

        // Snoozed: unsnoozes at once, no menu; back already, it snoozes again.
        let snoozed = mail(comeBackAt: now.addingTimeInterval(3600))
        #expect(
            BarAction.snooze.button(for: snoozed, now: now)
                == BarButton(title: "Unsnooze", input: .cancelComeBack, chosen: true))
        let back = mail(comeBackAt: now.addingTimeInterval(-3600))
        #expect(BarAction.snooze.button(for: back, now: now) == BarButton(title: "Snooze", input: nil, chosen: false))
    }
}
