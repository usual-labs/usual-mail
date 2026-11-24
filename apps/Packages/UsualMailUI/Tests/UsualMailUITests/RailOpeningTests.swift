import AppKit
import CoreGraphics
import SwiftUI
import Testing

@testable import UsualMailUI

/// The rail opening (owner's words of 2026-11-20: "when user hover on the sidebar, the items should get widened
/// smoothly and show the lables"; "when starting drag and drop, the side bar items should extend"): when it opens and
/// narrows, around a drag too, how wide it is, what dims, and what happens in a narrow window. The hover, the drag
/// itself and how they look are beyond a test (no pointer).
@MainActor
struct RailOpeningTests {
    @Test func restingOnTheRailOpensItAfterTheDelayAndNotBefore() async throws {
        let rail = RailOpening(delay: .milliseconds(40))
        #expect(!rail.isOpen)
        rail.pointerOnRail(true)
        #expect(!rail.isOpen)
        try await waitUntil("the rail opens") { rail.isOpen }

        // A long wait isn't over before its time.
        let slow = RailOpening(delay: .seconds(60))
        slow.pointerOnRail(true)
        try await Task.sleep(for: .milliseconds(50))
        #expect(!slow.isOpen)
    }

    @Test func thePointerOnlyCrossingTheRailDoesntOpenIt() async throws {
        let rail = RailOpening(delay: .milliseconds(60))
        rail.pointerOnRail(true)
        rail.pointerOnRail(false)
        try await Task.sleep(for: .milliseconds(150))
        #expect(!rail.isOpen)
        // Coming back starts the wait again.
        rail.pointerOnRail(true)
        try await waitUntil("the rail opens") { rail.isOpen }
    }

    @Test func leavingNarrowsItAtOnce() async throws {
        let rail = RailOpening(delay: .milliseconds(10))
        rail.pointerOnRail(true)
        try await waitUntil("the rail opens") { rail.isOpen }
        rail.pointerOnRail(false)
        #expect(!rail.isOpen)
        // The same report twice changes nothing.
        rail.pointerOnRail(false)
        #expect(!rail.isOpen)
    }

    @Test func aMailDragOpensItAtOnceWhereverItStarts() {
        // Owner's words of 2026-11-20: "when starting drag and drop, the side bar items should extend (like hover
        // effect) to make drop easier". No wait, and the pointer nowhere near the rail.
        let rail = RailOpening(delay: .seconds(60), findPointer: { false })
        rail.mail(dragging: true, landed: false, choosingSnooze: false)
        #expect(rail.isOpen)
        // The pointer's coming and going doesn't close it while mail is dragged.
        rail.pointerOnRail(true)
        rail.pointerOnRail(false)
        #expect(rail.isOpen)
    }

    @Test func aCancelledDragOrADropElsewhereNarrowsItAtOnce() {
        let rail = RailOpening(delay: .seconds(60), findPointer: { false })
        rail.mail(dragging: true, landed: false, choosingSnooze: false)
        rail.mail(dragging: false, landed: false, choosingSnooze: false)
        #expect(!rail.isOpen)
        // With nothing to find the pointer, the hover's word: not on the rail.
        let plain = RailOpening(delay: .seconds(60))
        plain.mail(dragging: true, landed: false, choosingSnooze: false)
        plain.mail(dragging: false, landed: false, choosingSnooze: false)
        #expect(!plain.isOpen)
    }

    @Test func aDropOnToReplyOrPinnedNarrowsItAfterTheBeat() async throws {
        for place in [Place.toReply, .pinned] {
            let drag = MailDragState(dropBeat: .milliseconds(40), watchEvery: .seconds(60), mouse: FakeMouse().read)
            let rail = RailOpening(delay: .seconds(60), findPointer: { false })
            let follow = { rail.mail(dragging: drag.isDragging, landed: drag.landed != nil, choosingSnooze: false) }
            drag.itemMade(["thr_a"])
            follow()
            #expect(rail.isOpen)
            drag.over(place)
            drag.dropped(on: place)
            follow()
            // Open for the beat, the button it went to still tinted.
            #expect(rail.isOpen && drag.accepts(place))
            try await waitUntil("the beat is over") { drag.landed == nil }
            follow()
            #expect(!rail.isOpen)
        }
        // The beat is short: a third of a second, more than the drop's own tint needs to show.
        #expect(MailDragState().dropBeat == .milliseconds(350))
    }

    @Test func aDropOnSnoozedKeepsItOpenUntilTheChoiceCloses() async throws {
        let drag = MailDragState(dropBeat: .milliseconds(20), watchEvery: .seconds(60), mouse: FakeMouse().read)
        let rail = RailOpening(delay: .seconds(60), findPointer: { false })
        let follow = {
            rail.mail(dragging: drag.isDragging, landed: drag.landed != nil, choosingSnooze: drag.snoozing != nil)
        }
        drag.itemMade(["thr_a"])
        drag.dropped(on: .snoozed)
        follow()
        // The mail read, the choice opens beside the open button.
        drag.snoozing = ["thr_a"]
        follow()
        try await waitUntil("the beat is over") { drag.landed == nil }
        follow()
        #expect(rail.isOpen)
        drag.dismissSnooze()
        follow()
        #expect(!rail.isOpen)
        // Chosen rather than dismissed, the same.
        drag.itemMade(["thr_b"])
        drag.dropped(on: .snoozed)
        drag.snoozing = ["thr_b"]
        follow()
        try await waitUntil("the second beat is over") { drag.landed == nil }
        follow()
        #expect(rail.isOpen)
        let tomorrow = try #require(SnoozeChoice.choices(now: .now).first)
        #expect(drag.choose(tomorrow) != .nothing)
        follow()
        #expect(!rail.isOpen)
    }

    @Test func thePointerRestingOnTheRailKeepsItOpenUntilItLeaves() async throws {
        // No hover is reported during a drag: where the pointer is comes from the window.
        let pointer = FakePointer(on: true)
        let rail = RailOpening(delay: .seconds(60), recheck: .milliseconds(10), findPointer: pointer.find)
        rail.mail(dragging: true, landed: false, choosingSnooze: false)
        rail.mail(dragging: false, landed: true, choosingSnooze: false)
        rail.mail(dragging: false, landed: false, choosingSnooze: false)
        // Resting there, as hovering would keep it open; no wait for the hover's delay.
        #expect(rail.isOpen)
        try await Task.sleep(for: .milliseconds(50))
        #expect(rail.isOpen)
        // Gone with no hover reported: the rail looks again and narrows.
        pointer.on = false
        try await waitUntil("the rail narrows") { !rail.isOpen }
    }

    @Test func theHoverSaysWhenThePointerLeavesAfterADrag() async throws {
        let pointer = FakePointer(on: true)
        let rail = RailOpening(delay: .seconds(60), recheck: .milliseconds(10), findPointer: pointer.find)
        rail.mail(dragging: true, landed: false, choosingSnooze: false)
        rail.mail(dragging: false, landed: false, choosingSnooze: false)
        #expect(rail.isOpen)
        // The hover reports leaving: narrow at once.
        rail.pointerOnRail(false)
        #expect(!rail.isOpen)

        // Once the hover reports, its word counts again, not the window's.
        rail.mail(dragging: true, landed: false, choosingSnooze: false)
        rail.mail(dragging: false, landed: false, choosingSnooze: false)
        rail.pointerOnRail(true)
        pointer.on = false
        try await Task.sleep(for: .milliseconds(50))
        #expect(rail.isOpen)
        rail.pointerOnRail(false)
        #expect(!rail.isOpen)

        // With nothing to find the pointer, a hover reported during the drag keeps it open after.
        let plain = RailOpening(delay: .seconds(60))
        plain.mail(dragging: true, landed: false, choosingSnooze: false)
        plain.pointerOnRail(true)
        plain.mail(dragging: false, landed: false, choosingSnooze: false)
        #expect(plain.isOpen)
        plain.pointerOnRail(false)
        #expect(!plain.isOpen)
    }

    @Test func aSecondDragAfterAnyEndingOpensAndNarrowsItAgain() async throws {
        let mouse = FakeMouse()
        let drag = MailDragState(dropBeat: .milliseconds(10), watchEvery: .seconds(60), mouse: mouse.read)
        let rail = RailOpening(delay: .seconds(60), findPointer: { false })
        let follow = {
            rail.mail(dragging: drag.isDragging, landed: drag.landed != nil, choosingSnooze: drag.snoozing != nil)
        }
        for ending in DragEnding.allCases {
            mouse.reading = MouseReading(held: true)
            drag.itemMade(["thr_a"])
            follow()
            #expect(rail.isOpen, "a drag after \(ending) opens it")
            ending.end(drag, mouse)
            try await waitUntil("the beat after \(ending) is over") { drag.landed == nil }
            follow()
            #expect(!rail.isOpen, "\(ending) narrows it")
        }
    }

    @Test func underReduceMotionItOpensWithoutTheSpring() {
        #expect(RailOpening.animation(reduceMotion: false) == Motion.move)
        #expect(RailOpening.animation(reduceMotion: true) == nil)
        // The tooltip's wait, so the rail opens instead of a button's tooltip.
        #expect(RailOpening().delay == Tooltip.delay)
        #expect(Tooltip.delay == .milliseconds(350))
    }
}

/// How wide the rail is, narrow and open, and where it lies in the smallest window.
@MainActor
struct RailWidthTests {
    @Test func itIsAButtonWideNarrowAndOpensTo184() {
        #expect(RailLook().width == 32)
        #expect(RailLook(isOpen: true).width == 184)
        #expect(RailFit.openWidth == 184)
        // The names start 6 past the icon, which sits in the middle of the button's first 32.
        #expect(RailFit.labelStart == RailFit.button / 2 + 8 + 6)
    }

    @Test func theLongestNameFitsAt12Points() throws {
        Theme.registerFonts()
        let font = try #require(NSFont(name: "Geist-Regular", size: 12))
        let room = RailFit.openWidth - RailFit.labelStart - RailFit.labelEnd
        for name in [
            AddGmailButton.help, "All inboxes", "To reply", "Pinned", "Snoozed", "Search", "Inbox", "Settings",
        ] {
            let width = (name as NSString).size(withAttributes: [.font: font]).width
            #expect(width <= room, "\(name) is \(width) wide, the room \(room)")
        }
        // With a count at the right: "99+" after the longest list name.
        let list = ("Snoozed 99+" as NSString).size(withAttributes: [.font: font]).width
        #expect(list + 6 <= room)
    }

    @Test func inTheDesignsWindowItOpensOverTheWallpaperOnly() {
        let layout = MailLayout(size: CGSize(width: 1512, height: 982))
        #expect(layout.railRoom == 300)
        #expect(!RailFit.reachesCard(room: layout.railRoom))
        // The classic inbox's wider card leaves room enough.
        let wide = MailLayout(size: CGSize(width: 1512, height: 982), wide: true)
        #expect(wide.railRoom == 200)
        #expect(!RailFit.reachesCard(room: wide.railRoom))
        #expect(!RailLook(isOpen: true, reachesCard: false).frosted)
    }

    @Test func inTheSmallestWindowItOpensOverTheCardsEdgeFrosted() {
        let layout = MailLayout(size: CGSize(width: 820, height: 560))
        // The rail 12 from the edge, in a side of 56; the card 10 further.
        #expect(layout.side == 56 && layout.railInset == 12)
        #expect(layout.railRoom == 44)
        #expect(RailFit.reachesCard(room: layout.railRoom))
        // It lies over the card's first 130 points, above it; the card doesn't move: the side column keeps its width
        // whatever the rail's.
        #expect(RailFit.openWidth - (layout.railRoom + MailLayout.gap) == 130)
        // Frosted only while open: white under the glass, the chosen button light grey, as the glass's white tint
        // wouldn't show over white.
        let frosted = RailLook(isOpen: true, reachesCard: true)
        #expect(frosted.frosted && frosted.width == 184)
        #expect(frosted.frosting(chosen: false) == Color.white.opacity(0.7))
        #expect(frosted.frosting(chosen: true) == Theme.hairline)
        let narrow = RailLook(isOpen: false, reachesCard: true)
        #expect(!narrow.frosted && narrow.frosting(chosen: true) == .clear)
        #expect(RailLook(isOpen: true, reachesCard: false).frosting(chosen: true) == .clear)
    }

    @Test func whileMailIsDraggedTheButtonsThatTakeNoneDim() {
        // Search, the switch with its plus, the classic inbox and settings, to 45%; To reply, Pinned and Snoozed whole.
        let dragging = RailLook(isOpen: true, dimsOthers: true)
        #expect(dragging.strength(takesMail: false) == 0.45 && RailLook.dimmed == 0.45)
        #expect(dragging.strength(takesMail: true) == 1)
        // Otherwise nothing dims, open or narrow.
        #expect(RailLook().strength(takesMail: false) == 1)
        #expect(RailLook(isOpen: true).strength(takesMail: false) == 1)
        // A fade, as the names' reveal, so Reduce Motion keeps it.
        #expect(RailLook.dimming == Motion.reveal)
    }

    @Test func theDimmingFollowsTheDrag() {
        // As the rail sets it: while mail is dragged, not during the drop's beat or the snooze choice.
        let mouse = FakeMouse()
        let drag = MailDragState(watchEvery: .seconds(60), mouse: mouse.read)
        let look = { RailLook(isOpen: true, dimsOthers: drag.isDragging) }
        #expect(look().strength(takesMail: false) == 1)
        drag.itemMade(["thr_a"])
        #expect(look().strength(takesMail: false) == 0.45)
        drag.dropped(on: .snoozed)
        drag.snoozing = ["thr_a"]
        #expect(look().strength(takesMail: false) == 1)
        drag.dismissSnooze()
        drag.itemMade(["thr_b"])
        drag.ended()
        #expect(look().strength(takesMail: false) == 1)
    }

    @Test func itReachesTheCardBelow1092PointsAnd1292OnTheClassicInbox() {
        func reaches(_ width: CGFloat, wide: Bool = false) -> Bool {
            RailFit.reachesCard(room: MailLayout(size: CGSize(width: width, height: 800), wide: wide).railRoom)
        }
        #expect(!reaches(1092) && reaches(1090))
        #expect(!reaches(1292, wide: true) && reaches(1290, wide: true))
    }
}

/// Where the window says the pointer is, for the rail opening to find (`RailOpening.findPointer`).
@MainActor
final class FakePointer {
    var on: Bool

    init(on: Bool) {
        self.on = on
    }

    var find: @MainActor () -> Bool { { self.on } }
}
