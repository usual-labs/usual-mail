import CoreGraphics
import Foundation
import Testing
import UniformTypeIdentifiers
import UsualMailKit

@testable import UsualMailUI

/// Dragging a mail row onto the rail (owner's words of 2026-11-20: "drag and drop any email in the home list, and drop
/// it to any icon of reply, snooze and pin icons on the sidebar, and then that email will be moved to those pages"):
/// what a drop does, the payload, which button is under the pointer, and the drag's state (`MailDragStateTests` for its
/// start and end). The drag itself, by pointer, is beyond a test.
@MainActor
struct MailDropTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func thread(_ id: String, stack: Stack? = nil, comesBackIn hours: Double? = nil) -> MailThread {
        MailThread(
            id: id, inboxId: "inb_a", subject: id, lastMessageAt: now.addingTimeInterval(-3600),
            category: .conversation, stack: stack, comeBackAt: hours.map { now.addingTimeInterval($0 * 3600) })
    }

    private func outcome(_ ids: [String], on target: Place?, _ threads: [MailThread]) -> MailDrop.Outcome {
        MailDrop.outcome(
            of: MailDrag(threadIDs: ids), on: target, lists: MailLists(categories: [.conversation: threads]), now: now)
    }

    @Test func eachButtonMovesTheMailThere() {
        let mail = [thread("thr_a")]
        #expect(outcome(["thr_a"], on: .toReply, mail) == .act(.stack(.replyLater), ["thr_a"]))
        #expect(outcome(["thr_a"], on: .pinned, mail) == .act(.stack(.setAside), ["thr_a"]))
        // Snoozed asks when it comes back first.
        #expect(outcome(["thr_a"], on: .snoozed, mail) == .chooseSnooze(["thr_a"]))
        #expect(MailDrop.targets == Rail.lists)
    }

    @Test func aGroupsRowMovesEveryThreadInIt() {
        let group = [thread("thr_new"), thread("thr_old"), thread("thr_older")]
        let ids = group.map(\.id)
        #expect(outcome(ids, on: .toReply, group) == .act(.stack(.replyLater), ids))
        #expect(outcome(ids, on: .pinned, group) == .act(.stack(.setAside), ids))
        #expect(outcome(ids, on: .snoozed, group) == .chooseSnooze(ids))
    }

    @Test func fromOneListOntoAnotherTheStackIsReplaced() {
        #expect(
            outcome(["thr_a"], on: .toReply, [thread("thr_a", stack: .setAside)])
                == .act(.stack(.replyLater), ["thr_a"]))
        #expect(
            outcome(["thr_a"], on: .pinned, [thread("thr_a", stack: .replyLater)]) == .act(.stack(.setAside), ["thr_a"])
        )
        // A pinned mail dropped on Snoozed is snoozed, and stays pinned, as the menu's Snooze does.
        #expect(outcome(["thr_a"], on: .snoozed, [thread("thr_a", stack: .setAside)]) == .chooseSnooze(["thr_a"]))
    }

    @Test func aDropOnTheListItIsAlreadyOnDoesNothing() {
        #expect(outcome(["thr_a"], on: .toReply, [thread("thr_a", stack: .replyLater)]) == .nothing)
        #expect(outcome(["thr_a"], on: .pinned, [thread("thr_a", stack: .setAside)]) == .nothing)
        #expect(outcome(["thr_a"], on: .snoozed, [thread("thr_a", comesBackIn: 5)]) == .nothing)
        // A group partly there moves the rest.
        let group = [thread("thr_a", stack: .setAside), thread("thr_b")]
        #expect(outcome(["thr_a", "thr_b"], on: .pinned, group) == .act(.stack(.setAside), ["thr_b"]))
        // Snoozed once and come back since, it can be snoozed again.
        #expect(outcome(["thr_a"], on: .snoozed, [thread("thr_a", comesBackIn: -1)]) == .chooseSnooze(["thr_a"]))
    }

    @Test func aDropAnywhereElseDoesNothing() {
        let mail = [thread("thr_a")]
        let elsewhere: [Place?] = [nil, .search, .inbox, .settings, .screening, .tab(.home), .tab(.receipts)]
        for place in elsewhere {
            #expect(outcome(["thr_a"], on: place, mail) == .nothing)
        }
    }

    @Test func threadsTheCopyDoesntHoldAreLeftOut() {
        #expect(outcome([], on: .toReply, [thread("thr_a")]) == .nothing)
        #expect(outcome(["thr_gone"], on: .pinned, [thread("thr_a")]) == .nothing)
        #expect(outcome(["thr_gone"], on: .snoozed, [thread("thr_a")]) == .nothing)
        #expect(
            outcome(["thr_gone", "thr_a"], on: .toReply, [thread("thr_a")]) == .act(.stack(.replyLater), ["thr_a"]))
        // An id twice counts once.
        #expect(outcome(["thr_a", "thr_a"], on: .pinned, [thread("thr_a")]) == .act(.stack(.setAside), ["thr_a"]))
    }

    @Test func thePayloadRoundTripsInTheAppsOwnTypeOnly() async throws {
        let drag = MailDrag(threadIDs: ["thr_a", "thr_b"])
        #expect(UTType.usualMailThreads.identifier == "labs.usual.UsualMail.threads")
        #expect(MailDrag.exportedContentTypes() == [.usualMailThreads])
        #expect(MailDrag.importedContentTypes() == [.usualMailThreads])
        let data = try await drag.exported(as: .usualMailThreads)
        #expect(try await MailDrag(importing: data, contentType: .usualMailThreads) == drag)
    }

    @Test func aForeignPayloadIsRefused() async {
        // Text from another app isn't the app's type, so the rail never takes it.
        #expect(!UTType.plainText.conforms(to: .usualMailThreads))
        #expect(!UTType.utf8PlainText.conforms(to: .usualMailThreads))
        await #expect(throws: (any Error).self) {
            try await MailDrag(importing: Data("thr_a".utf8), contentType: .plainText)
        }
        // Data claiming the type that isn't the app's doesn't decode.
        await #expect(throws: (any Error).self) {
            try await MailDrag(importing: Data("thr_a".utf8), contentType: .usualMailThreads)
        }
        await #expect(throws: (any Error).self) {
            try await MailDrag(importing: Data(#"{"ids":["thr_a"]}"#.utf8), contentType: .usualMailThreads)
        }
    }

    @Test func theButtonUnderThePointer() {
        // To reply, Pinned and Snoozed as the rail lays them out: 32 high, 10 apart.
        let frames: [Place: CGRect] = [
            .toReply: CGRect(x: 0, y: 300, width: 32, height: 32),
            .pinned: CGRect(x: 0, y: 342, width: 32, height: 32),
            .snoozed: CGRect(x: 0, y: 384, width: 32, height: 32),
        ]
        #expect(RailDrop.target(at: CGPoint(x: 16, y: 316), in: frames) == .toReply)
        #expect(RailDrop.target(at: CGPoint(x: 16, y: 358), in: frames) == .pinned)
        #expect(RailDrop.target(at: CGPoint(x: 2, y: 413), in: frames) == .snoozed)
        // A little past a button's edge still counts; the middle of the gap between two doesn't.
        #expect(RailDrop.target(at: CGPoint(x: 16, y: 334), in: frames) == .toReply)
        #expect(RailDrop.target(at: CGPoint(x: 16, y: 340), in: frames) == .pinned)
        #expect(RailDrop.target(at: CGPoint(x: 16, y: 337), in: frames) == nil)
        // The buttons above and below (search, the switch, the classic inbox, settings) take nothing.
        #expect(RailDrop.target(at: CGPoint(x: 16, y: 100), in: frames) == nil)
        #expect(RailDrop.target(at: CGPoint(x: 16, y: 450), in: frames) == nil)
        #expect(RailDrop.target(at: CGPoint(x: 16, y: 316), in: [:]) == nil)
    }

    /// To reply, Pinned and Snoozed as the rail lays them out, `width` wide: 32 high, 10 apart.
    private func frames(width: CGFloat) -> [Place: CGRect] {
        [
            .toReply: CGRect(x: 0, y: 300, width: width, height: 32),
            .pinned: CGRect(x: 0, y: 342, width: width, height: 32),
            .snoozed: CGRect(x: 0, y: 384, width: width, height: 32),
        ]
    }

    @Test func theButtonUnderThePointerWhileTheRailIsOpen() {
        // A drag opens the rail at once: the same buttons, 184 wide, their names and counts beside the icons.
        let narrow = frames(width: RailLook().width)
        let open = frames(width: RailLook(isOpen: true).width)
        // Over the icons: the same button either way.
        for frames in [narrow, open] {
            #expect(RailDrop.target(at: CGPoint(x: 16, y: 316), in: frames) == .toReply)
            #expect(RailDrop.target(at: CGPoint(x: 16, y: 400), in: frames) == .snoozed)
        }
        // Over a name or a count: only once open, out to the button's end and a little past it.
        #expect(RailDrop.target(at: CGPoint(x: 90, y: 358), in: narrow) == nil)
        #expect(RailDrop.target(at: CGPoint(x: 90, y: 358), in: open) == .pinned)
        #expect(RailDrop.target(at: CGPoint(x: 170, y: 316), in: open) == .toReply)
        #expect(RailDrop.target(at: CGPoint(x: 186, y: 400), in: open) == .snoozed)
        #expect(RailDrop.target(at: CGPoint(x: 190, y: 400), in: open) == nil)
        // The gap between two open buttons still takes nothing.
        #expect(RailDrop.target(at: CGPoint(x: 120, y: 337), in: open) == nil)
    }

    @Test func inANarrowWindowTheOpenRailTakesNoMailOverTheCard() {
        // The smallest window: the rail's room is 44, the card starts 10 further, and the open rail lies over its first
        // 130 points, over the rows a drag starts from.
        let layout = MailLayout(size: CGSize(width: 820, height: 560))
        let cardEdge = layout.railRoom + MailLayout.gap
        #expect(cardEdge == 54 && RailFit.reachesCard(room: layout.railRoom))
        let open = frames(width: RailLook(isOpen: true).width)
        // Over the rail's own column, up to the card's edge: the button there.
        #expect(RailDrop.target(at: CGPoint(x: 16, y: 316), in: open, cardEdge: cardEdge) == .toReply)
        #expect(RailDrop.target(at: CGPoint(x: 53, y: 358), in: open, cardEdge: cardEdge) == .pinned)
        // Over the card, though the open button lies there: nothing, so mail let go where it was picked up stays put.
        #expect(RailDrop.target(at: CGPoint(x: 54, y: 358), in: open, cardEdge: cardEdge) == nil)
        #expect(RailDrop.target(at: CGPoint(x: 120, y: 400), in: open, cardEdge: cardEdge) == nil)
        // In the design's window the card is far past the open rail: all of each button takes mail.
        let wide = MailLayout(size: CGSize(width: 1512, height: 982))
        let far = wide.railRoom + MailLayout.gap
        #expect(RailDrop.target(at: CGPoint(x: 186, y: 400), in: open, cardEdge: far) == .snoozed)
        #expect(RailDrop.target(at: CGPoint(x: 120, y: 358), in: open, cardEdge: far) == .pinned)
        // At 1092 points, where the open rail just meets the card, its whole width still takes mail.
        let meets = MailLayout(size: CGSize(width: 1092, height: 800)).railRoom + MailLayout.gap
        #expect(meets == RailFit.openWidth)
        #expect(RailDrop.target(at: CGPoint(x: 183, y: 316), in: open, cardEdge: meets) == .toReply)
    }

    @Test func aDropOnSnoozedWaitsForATimeAndClosingItLeavesTheMail() throws {
        let drag = MailDragState()
        let choices = SnoozeChoice.choices(now: now)
        let tomorrow = try #require(choices.first { $0.title == "Tomorrow, 08:00" })
        #expect(drag.choose(tomorrow) == .nothing)

        drag.snoozing = ["thr_a", "thr_b"]
        #expect(drag.choose(tomorrow) == .act(.comeBack(at: tomorrow.at, ifNoReply: nil), ["thr_a", "thr_b"]))
        // Chosen: the choice is closed, and another does nothing.
        #expect(drag.snoozing == nil && drag.choose(tomorrow) == .nothing)
        // "If nobody has answered".
        drag.snoozing = ["thr_a"]
        let ifNoReply = try #require(choices.first { $0.ifNoReply == true })
        #expect(drag.choose(ifNoReply) == .act(.comeBack(at: ifNoReply.at, ifNoReply: true), ["thr_a"]))
        // Closed without choosing: nothing is snoozed.
        drag.snoozing = ["thr_a"]
        drag.dismissSnooze()
        #expect(drag.snoozing == nil && drag.choose(tomorrow) == .nothing)
    }

    @Test func thePreviewIsOneShortLine() {
        #expect(MailDragPreview.short("Dana Whitfield", 28) == "Dana Whitfield")
        #expect(MailDragPreview.short("Contract\nrenewal   for 2027", 44) == "Contract renewal for 2027")
        let long = MailDragPreview.short(String(repeating: "word ", count: 20), 12)
        #expect(long == "word word w…" && long.count == 12)
    }
}

/// A drop through the store: the mail leaves Home or its list and shows on the page it was dropped on at once, before
/// the server answers, with the same action the row's menu takes (so the undo strip says it).
@MainActor
struct MailDropStoreTests {
    private func inHome(_ store: MailStore, _ id: String) -> Bool { store.lists.home.contains { $0.id == id } }
    private func ids(_ store: MailStore, _ place: Place) -> [String] {
        RailList(store.lists, place: place, inbox: nil).threads.map(\.id)
    }

    /// Drops `threadIDs` on `target` as the rail does, and returns the task acting on them.
    private func drop(_ threadIDs: [String], on target: Place, _ store: MailStore) -> Task<Void, Never>? {
        let outcome = MailDrop.outcome(
            of: MailDrag(threadIDs: threadIDs), on: target, lists: store.lists, now: store.now)
        guard case .act(let action, let ids) = outcome else { return nil }
        return Task { await store.perform(action, on: ids) }
    }

    @Test func fromHomeOntoToReplyThenOntoPinned() async throws {
        let store = try await heldStore()
        #expect(inHome(store, "thr_2") && ids(store, .toReply) == ["thr_7"])

        let toReply = try #require(drop(["thr_2"], on: .toReply, store))
        defer { toReply.cancel() }
        try await waitUntil("thr_2 shows in To reply") { ids(store, .toReply) == ["thr_2", "thr_7"] }
        #expect(!inHome(store, "thr_2"))

        // From To reply onto Pinned: it leaves To reply.
        let pinned = try #require(drop(["thr_2"], on: .pinned, store))
        defer { pinned.cancel() }
        try await waitUntil("thr_2 moves to Pinned") { ids(store, .pinned) == ["thr_2", "thr_10"] }
        #expect(ids(store, .toReply) == ["thr_7"] && !inHome(store, "thr_2"))
        // Onto Pinned again: nothing to do.
        #expect(drop(["thr_2"], on: .pinned, store) == nil)
    }

    @Test func aNotificationGroupsRowMovesTheWholeGroup() async throws {
        let store = try await heldStore()
        let group = ["thr_21", "thr_24", "thr_23"]
        let task = try #require(drop(group, on: .pinned, store))
        defer { task.cancel() }
        try await waitUntil("the parcel's three mails show in Pinned") {
            ids(store, .pinned) == ["thr_21", "thr_24", "thr_23", "thr_10"]
        }
    }

    @Test func snoozedOnceATimeIsChosen() async throws {
        let store = try await heldStore()
        let drag = MailDragState()
        guard
            case .chooseSnooze(let threadIDs) = MailDrop.outcome(
                of: MailDrag(threadIDs: ["thr_1"]), on: .snoozed, lists: store.lists, now: store.now)
        else {
            Issue.record("Snoozed didn't ask for a time")
            return
        }
        drag.snoozing = threadIDs
        // Still in Home while the person chooses.
        #expect(inHome(store, "thr_1"))
        let tuesday = try #require(SnoozeChoice.choices(now: store.now).first { $0.title == "Tomorrow, 08:00" })
        guard case .act(let action, let chosen) = drag.choose(tuesday) else {
            Issue.record("Choosing a time didn't snooze")
            return
        }
        let task = Task { await store.perform(action, on: chosen) }
        defer { task.cancel() }
        try await waitUntil("thr_1 shows in Snoozed") { ids(store, .snoozed) == ["thr_1", "thr_9"] }
        #expect(!inHome(store, "thr_1"))
    }
}
