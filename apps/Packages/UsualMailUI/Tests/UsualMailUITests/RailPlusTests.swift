import CoreGraphics
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The switch's plus: last in the pill, drawn as the profiles are, saying what it does until its sheet opens, and
/// opening the shared Sign in with Google step for a new inbox. And how many profiles fit with it, and the circle for
/// every inbox picked.
@MainActor
struct RailPlusTests {
    @Test func itIsAHugeiconsPlusInTheCatalog() {
        #expect(Icon.add.rawValue == "plus-sign")
        #expect(Icon.bundle.image(forResource: Icon.add.rawValue) != nil)
    }

    @Test func itsTooltipSaysWhatItDoesUntilItsSheetOpens() {
        #expect(AddGmailButton.tooltip(isOpen: false) == "Add a Gmail account")
        #expect(AddGmailButton.tooltip(isOpen: true) == nil)
        #expect(AddGmailSheet.title == "Add a Gmail account")
        // The open rail names it beside its icon instead.
        #expect(AddGmailButton.tooltip(isOpen: false, railOpen: true) == nil)
    }

    @Test func thePickedCircleForEveryInboxHasADot() {
        // Hugeicons' free set: the plain small circle, and its RadioButtonIcon, a circle with a dot.
        #expect(Rail.allInboxesIcon(picked: false) == .allInboxes)
        #expect(Rail.allInboxesIcon(picked: true) == .allInboxesChosen)
        #expect(Icon.allInboxes.rawValue == "circle-small")
        #expect(Icon.allInboxesChosen.rawValue == "radio-button")
        #expect(Icon.bundle.image(forResource: Icon.allInboxesChosen.rawValue) != nil)
        // Drawn from this package's catalog in its own colours, so it takes the wallpaper's tone as the others do.
        #expect(Icon.allInboxesChosen.designed == nil && Icon.allInboxesChosen.catalog == Icon.bundle)
    }

    @Test func itOpensTheSharedStepForANewInboxAtOnce() {
        // The same step as Settings' "Add Gmail…": no inbox to reconnect, Google's page opened as soon as it can.
        let step = AddGmailSheet.step
        #expect(step.inboxId == nil)
        #expect(step.startsAtOnce)
        #expect(step.title == "Sign in with Google")
    }

    @Test func aNewInboxShowsTheIconTheServerGaveIt() {
        #expect(Icon(InboxIcon.briefcase) == .briefcase)
        // One the app doesn't know yet shows the switch's circle.
        #expect(Icon(InboxIcon.unknown("anchor")) == .allInboxes)
    }

    @Test func fourInboxesFitTheSmallestWindowAboveSettings() {
        // The circle for every inbox and the plus, in the pill; the rail's six buttons (search, To reply, Pinned,
        // Snoozed, the classic inbox, settings) and the least room above settings.
        #expect(RailFit.pill(inboxes: 0) == 68)
        #expect(RailFit.height(inboxes: 0) == 320)
        #expect(RailFit.pill(inboxes: 1) - RailFit.pill(inboxes: 0) == 28)

        // Settings sits as far above the window's bottom edge as the rail's top is below its top edge.
        let top = MailLayout(size: CGSize(width: 820, height: 560)).top
        #expect(top == 56)
        #expect(top + RailFit.column(windowHeight: 560) + top == 560)
        #expect(RailFit.column(windowHeight: 560) == 448)

        #expect(RailFit.height(inboxes: 4) <= RailFit.column(windowHeight: 560))
        #expect(RailFit.height(inboxes: 5) > RailFit.column(windowHeight: 560))
        #expect(RailFit.inboxesThatFit(windowHeight: 560) == 4)
        #expect(RailFit.inboxesThatFit(windowHeight: 982) == 16)
        #expect(RailFit.inboxesThatFit(windowHeight: 100) == 0)
    }

    @Test func moreInboxesThanFitScrollBetweenTheCircleAndThePlus() {
        // Every one shows while they fit.
        #expect(RailFit.scrollHeight(inboxes: 0, windowHeight: 560) == nil)
        #expect(RailFit.scrollHeight(inboxes: 4, windowHeight: 560) == nil)
        #expect(RailFit.scrollHeight(inboxes: 16, windowHeight: 982) == nil)
        // One more, and they scroll in the room of four, so the pill is as tall as with four and settings stays clear.
        for count in [5, 12, 40] {
            let scrolling = RailFit.scrollHeight(inboxes: count, windowHeight: 560)
            #expect(scrolling == RailFit.rows(4))
            let pill = 2 * RailFit.pillPadding + 2 * RailFit.row + 2 * RailFit.rowSpacing + (scrolling ?? 0)
            #expect(pill == RailFit.pill(inboxes: 4))
        }
        #expect(RailFit.scrollHeight(inboxes: 17, windowHeight: 982) == RailFit.rows(16))
    }
}
