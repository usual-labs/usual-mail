import CoreGraphics
import Testing

@testable import UsualMailUI

/// A mouse for the drag state to read: a button held or not, the pointer somewhere, the event a press or not.
@MainActor
final class FakeMouse {
    var reading: MouseReading

    init(held: Bool = true, pressing: Bool = false) {
        reading = MouseReading(held: held, pressing: pressing)
    }

    var read: @MainActor () -> MouseReading { { self.reading } }
}

/// A mail drag from start to end (owner's words of 2026-11-20: "when starting drag and drop, the side bar items should
/// extend (like hover effect) to make drop easier"): when it starts, each way it ends, the watchdog that ends it when
/// nothing else says so, and a second drag after every ending. The pointer and AppKit's drag are beyond a test: the
/// mouse is a fake, and the watchdog's looks are taken by hand unless a test says otherwise.
@MainActor
struct MailDragStateTests {
    private func state(_ mouse: FakeMouse, dropBeat: Duration = .seconds(60)) -> MailDragState {
        MailDragState(dropBeat: dropBeat, watchEvery: .seconds(60), mouse: mouse.read)
    }

    @Test func theItemMadeAsTheDragStartsStartsItAtOnce() {
        let drag = state(FakeMouse())
        #expect(!drag.isDragging && !Rail.lists.contains { drag.accepts($0) })
        drag.itemMade(["thr_a"])
        #expect(drag.isDragging && drag.dragged == ["thr_a"])
        #expect(Rail.lists.allSatisfy { drag.accepts($0) })
        #expect(![.search, .inbox, .settings, .tab(.home)].contains { drag.accepts($0) })
        // Asked again, or another row saying so while it goes on, changes nothing.
        drag.itemMade(["thr_b"])
        drag.began(["thr_b"])
        #expect(drag.dragged == ["thr_a"])
        // The row saying it is active starts one too.
        let reported = state(FakeMouse())
        reported.began(["thr_c"])
        #expect(reported.isDragging && reported.dragged == ["thr_c"])
    }

    @Test func anItemMadeWithNoButtonHeldIsNoDrag() {
        // As when the rail reads the mail let go on it.
        let drag = state(FakeMouse(held: false))
        drag.itemMade(["thr_a"])
        #expect(!drag.isDragging && drag.dragged == nil)
        #expect(!drag.look())
    }

    @Test func anItemMadeOnAPressCountsOnceThePointerMoves() {
        let mouse = FakeMouse(pressing: true)
        let drag = state(mouse)
        drag.itemMade(["thr_a"])
        #expect(!drag.isDragging)
        mouse.reading = MouseReading(held: true, location: CGPoint(x: 3, y: 2))
        #expect(drag.look() && !drag.isDragging)
        mouse.reading.location = CGPoint(x: 6, y: 1)
        drag.look()
        #expect(drag.isDragging && drag.dragged == ["thr_a"])

        // A click: let go before moving far, no drag, and nothing left to watch.
        let click = FakeMouse(pressing: true)
        let clicked = state(click)
        clicked.itemMade(["thr_a"])
        click.reading = MouseReading(held: false, location: CGPoint(x: 2, y: 0))
        #expect(!clicked.look() && !clicked.isDragging)
    }

    @Test func droppedOnARailButtonItEndsAndTheButtonShowsItForTheBeat() async throws {
        let drag = state(FakeMouse(), dropBeat: .milliseconds(40))
        drag.itemMade(["thr_a"])
        drag.over(.pinned)
        #expect(drag.target == .pinned)
        drag.dropped(on: .pinned)
        #expect(!drag.isDragging && drag.target == nil && drag.dragged == nil)
        #expect(drag.landed == .pinned && drag.accepts(.pinned) && !drag.accepts(.toReply))
        #expect(!drag.look())
        try await waitUntil("the beat is over") { drag.landed == nil }
        #expect(!drag.accepts(.pinned))
    }

    @Test func letGoAnywhereElseTheWatchdogEndsItOnItsSecondLook() {
        let mouse = FakeMouse()
        let drag = state(mouse)
        drag.itemMade(["thr_a"])
        #expect(drag.look() && drag.isDragging)
        mouse.reading.held = false
        // Once alone could be a drop the rail is about to take: the buttons run ahead of the events.
        #expect(drag.look() && drag.isDragging)
        #expect(!drag.look() && !drag.isDragging && drag.dragged == nil && drag.landed == nil)
    }

    @Test func aDropTakenAfterTheFirstLookStillLands() {
        let mouse = FakeMouse()
        let drag = state(mouse)
        drag.itemMade(["thr_a"])
        drag.over(.toReply)
        mouse.reading.held = false
        drag.look()
        drag.dropped(on: .toReply)
        #expect(drag.landed == .toReply && !drag.isDragging)
        #expect(!drag.look() && drag.landed == .toReply)
    }

    @Test func letGoOutsideTheWindowTheWatchdogEndsIt() {
        // The rail hears nothing of it: the pointer left the window, and the button was let go out there.
        let mouse = FakeMouse()
        let drag = state(mouse)
        drag.itemMade(["thr_a"])
        mouse.reading = MouseReading(held: true, location: CGPoint(x: -400, y: 900))
        #expect(drag.look() && drag.isDragging)
        mouse.reading.held = false
        drag.look()
        drag.look()
        #expect(!drag.isDragging)
    }

    @Test func cancelledItEndsAtOnceAndTheWatchdogStops() {
        // Esc: the row says the drag ended while the button is still held. Unsaid, letting the button go ends it as
        // anywhere else (the watchdog).
        let drag = state(FakeMouse())
        drag.itemMade(["thr_a"])
        drag.over(.snoozed)
        drag.ended()
        #expect(!drag.isDragging && drag.target == nil && drag.landed == nil && drag.snoozing == nil)
        #expect(!drag.look())
    }

    @Test func letGoOverTheRailOffItsButtonsItEndsAtOnce() {
        let mouse = FakeMouse()
        let drag = state(mouse)
        drag.itemMade(["thr_a"])
        // Crossing off the rail with the button held: it goes on, no button under the pointer.
        drag.over(.toReply)
        drag.leftRail()
        #expect(drag.isDragging && drag.target == nil)
        drag.over(nil)
        mouse.reading.held = false
        drag.leftRail()
        #expect(!drag.isDragging)
    }

    @Test func mailOverTheRailFromADragTheRowDidntReportCountsUntilItEnds() {
        let mouse = FakeMouse()
        let drag = state(mouse)
        drag.over(.toReply)
        #expect(drag.isDragging && drag.dragged == nil && drag.accepts(.snoozed))
        drag.leftRail()
        #expect(drag.isDragging)
        mouse.reading.held = false
        drag.look()
        drag.look()
        #expect(!drag.isDragging)
    }

    @Test func theWatchdogLooksByItselfWhileADragGoesOn() async throws {
        let mouse = FakeMouse()
        let drag = MailDragState(watchEvery: .milliseconds(10), mouse: mouse.read)
        drag.itemMade(["thr_a"])
        try await Task.sleep(for: .milliseconds(60))
        #expect(drag.isDragging)
        mouse.reading.held = false
        try await waitUntil("the watchdog ends the drag") { !drag.isDragging }
        // And starts again with the next drag.
        mouse.reading.held = true
        drag.itemMade(["thr_b"])
        try await Task.sleep(for: .milliseconds(40))
        #expect(drag.isDragging)
        mouse.reading.held = false
        try await waitUntil("the watchdog ends the second drag") { !drag.isDragging }
    }

    @Test func aSecondDragAfterEveryEndingStartsAndEndsAgain() {
        let mouse = FakeMouse()
        let drag = state(mouse)
        for ending in DragEnding.allCases {
            mouse.reading = MouseReading(held: true)
            drag.itemMade(["\(ending)"])
            #expect(drag.isDragging && drag.dragged == ["\(ending)"], "a drag after \(ending)")
            ending.end(drag, mouse)
            #expect(!drag.isDragging && drag.dragged == nil && drag.target == nil, "\(ending)")
            #expect(!drag.look(), "nothing left to watch after \(ending)")
        }
    }
}

/// Each way a drag ends, as the drag state hears of it.
enum DragEnding: CaseIterable {
    case droppedOnToReply, droppedOnSnoozedAndDismissed, letGoElsewhere, cancelled, letGoOverTheRail

    @MainActor func end(_ drag: MailDragState, _ mouse: FakeMouse) {
        switch self {
        case .droppedOnToReply:
            drag.over(.toReply)
            drag.dropped(on: .toReply)
        case .droppedOnSnoozedAndDismissed:
            drag.over(.snoozed)
            drag.dropped(on: .snoozed)
            drag.snoozing = ["thr_a"]
            drag.dismissSnooze()
        case .letGoElsewhere:
            mouse.reading.held = false
            drag.look()
            drag.look()
        case .cancelled:
            drag.ended()
        case .letGoOverTheRail:
            drag.over(nil)
            mouse.reading.held = false
            drag.leftRail()
        }
    }
}
