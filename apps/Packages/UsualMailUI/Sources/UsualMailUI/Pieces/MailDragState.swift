import SwiftUI

#if os(macOS)
    import AppKit
#endif

/// What a drag's start and its watchdog read from the Mac: whether a mouse button is held, where the pointer is on the
/// screen, and whether the event being handled is a press (a click that may still not become a drag).
struct MouseReading: Equatable, Sendable {
    var held: Bool
    var location: CGPoint = .zero
    var pressing = false

    /// The Mac's own, now: the buttons as the hardware has them, which may run a moment ahead of the events.
    /// An iPhone has no mouse and no rail to drag onto: nothing is ever held.
    @MainActor static func now() -> MouseReading {
        #if os(macOS)
            let pressing =
                switch NSApp?.currentEvent?.type {
                case .leftMouseDown, .rightMouseDown, .otherMouseDown: true
                default: false
                }
            return MouseReading(
                held: NSEvent.pressedMouseButtons != 0, location: NSEvent.mouseLocation, pressing: pressing)
        #else
            return MouseReading(held: false)
        #endif
    }
}

/// A mail being dragged in the window, kept by the window and handed down (`environment`): whether a drag goes on, the
/// threads its row carries, which of the rail's buttons is under the pointer, the button mail was just dropped on, and
/// the threads dropped on Snoozed while the person chooses when they come back.
///
/// A drag counts from when SwiftUI makes its item (`itemMade`), the row says it is active, or mail first shows over the
/// rail, whichever comes first. It ends on whichever of these comes first, as no one of them is sure on its own: a drop
/// on the rail (`dropped(on:)`), the row saying it ended, mail let go over the rail off its buttons (`leftRail`), or the
/// watchdog: while a drag goes on it looks at the mouse every `watchEvery`, and the second look in a row with no button
/// held ends it. That covers mail let go anywhere else, outside the window, and a drag cancelled with Esc once the
/// button is let go.
@MainActor
@Observable
final class MailDragState {
    /// Whether mail is being dragged, from its start until it ends: the rail opens for it and dims what takes no mail.
    private(set) var isDragging = false
    /// The threads the drag carries, when its row said; nil otherwise.
    private(set) var dragged: [String]?
    /// The button under the pointer while mail is dragged over the rail, when it is one that takes mail.
    private(set) var target: Place?
    /// The button mail was just dropped on, for `dropBeat`, so the drop shows on the open rail before it narrows.
    private(set) var landed: Place?
    /// Threads dropped on Snoozed, while the person chooses when they come back; nil when no choice is open.
    var snoozing: [String]?

    /// How long the button mail was dropped on keeps showing it took it.
    @ObservationIgnored let dropBeat: Duration
    /// How often the watchdog looks at the mouse while a drag goes on.
    @ObservationIgnored let watchEvery: Duration
    /// How far the pointer must move with the button held for a press to count as a drag: more than the Mac's own
    /// drag threshold, so a click that only trembles isn't one.
    static let dragDistance: CGFloat = 6

    @ObservationIgnored private let mouse: @MainActor () -> MouseReading
    /// A row's item made on a press, waiting for the pointer to move before it counts as a drag.
    @ObservationIgnored private var pressed: (threadIDs: [String], at: CGPoint)?
    /// The watchdog's last look found no button held.
    @ObservationIgnored private var letGo = false
    @ObservationIgnored private var watching: Task<Void, Never>?
    @ObservationIgnored private var landing: Task<Void, Never>?

    init(
        dropBeat: Duration = .milliseconds(350), watchEvery: Duration = .milliseconds(100),
        mouse: @escaping @MainActor () -> MouseReading = MouseReading.now
    ) {
        self.dropBeat = dropBeat
        self.watchEvery = watchEvery
        self.mouse = mouse
    }

    /// Whether a rail button shows it takes mail: To reply, Pinned and Snoozed while mail is dragged, and the one it was
    /// just dropped on for the beat after.
    func accepts(_ place: Place) -> Bool {
        MailDrop.targets.contains(place) && (isDragging || landed == place)
    }

    /// SwiftUI made the drag's item for a row carrying `threadIDs`, which it does as the drag starts. With no button
    /// held it is no drag's (an item asked for again after a drop); made on a press, which may yet be a click, it counts
    /// once the pointer has moved `dragDistance` with the button held (`look`).
    func itemMade(_ threadIDs: [String]) {
        let mouse = self.mouse()
        guard mouse.held, !isDragging else { return }
        if mouse.pressing {
            pressed = (threadIDs, mouse.location)
            watch()
        } else {
            began(threadIDs)
        }
    }

    /// A row's drag started, or goes on. The first row to say so names the threads, so rows asked again while it goes
    /// on change nothing.
    func began(_ threadIDs: [String]) {
        pressed = nil
        if dragged == nil { dragged = threadIDs }
        if !isDragging { start() }
    }

    /// The drag ended with no drop on the rail: let go anywhere else, cancelled, or let go outside the window. Nothing
    /// shows of it; a drop's beat and the snooze choice are left as they are.
    func ended() {
        pressed = nil
        letGo = false
        watching?.cancel()
        watching = nil
        if isDragging { isDragging = false }
        if dragged != nil { dragged = nil }
        if target != nil { target = nil }
    }

    /// Mail was let go on `place`, one of the rail's buttons: the drag is over, and the button shows it took the mail
    /// for `dropBeat`.
    func dropped(on place: Place) {
        ended()
        landed = place
        landing?.cancel()
        let beat = dropBeat
        landing = Task { [weak self] in
            try? await Task.sleep(for: beat)
            guard !Task.isCancelled else { return }
            self?.landed = nil
        }
    }

    /// Mail is over the rail, with `place` under the pointer (nil between buttons, over one that takes no mail, or over
    /// the card). A drag the row didn't report counts from here.
    func over(_ place: Place?) {
        if target != place { target = place }
        if !isDragging { start() }
    }

    /// Mail left the rail: no button is under the pointer. Let go there, between the buttons or over one that takes no
    /// mail, the drag is over at once.
    func leftRail() {
        if target != nil { target = nil }
        if isDragging, !mouse().held { ended() }
    }

    /// The person chose when the mail dropped on Snoozed comes back: the action to take, which closes the choice.
    /// Nothing when no choice is open.
    func choose(_ choice: SnoozeChoice) -> MailDrop.Outcome {
        guard let threadIDs = snoozing, !threadIDs.isEmpty else { return .nothing }
        snoozing = nil
        return .act(.comeBack(at: choice.at, ifNoReply: choice.ifNoReply), threadIDs)
    }

    /// The choice was closed without choosing: the mail stays where it was.
    func dismissSnooze() {
        snoozing = nil
    }

    /// One look at the mouse while a drag goes on or a press may become one, as the watchdog takes every
    /// `watchEvery`. No button held twice in a row ends the drag: once alone could be a drop the rail is about to take,
    /// as the buttons run a moment ahead of the events. A press that moved `dragDistance` with the button held is a
    /// drag; let go before, a click. Returns whether to keep looking.
    @discardableResult
    func look() -> Bool {
        let mouse = self.mouse()
        if let pressed, !isDragging {
            let moved = hypot(mouse.location.x - pressed.at.x, mouse.location.y - pressed.at.y)
            if !mouse.held {
                self.pressed = nil
            } else if moved >= Self.dragDistance {
                began(pressed.threadIDs)
            }
        }
        if isDragging {
            if mouse.held {
                letGo = false
            } else if letGo {
                ended()
            } else {
                letGo = true
            }
        }
        let goesOn = isDragging || pressed != nil
        if !goesOn {
            watching?.cancel()
            watching = nil
        }
        return goesOn
    }

    private func start() {
        isDragging = true
        letGo = false
        watch()
    }

    /// Starts the watchdog unless it runs: it looks every `watchEvery` until nothing is left to watch.
    private func watch() {
        guard watching == nil else { return }
        let every = watchEvery
        watching = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: every)
                guard !Task.isCancelled, let self, self.look() else { return }
            }
        }
    }
}

extension MailDragState {
    /// A row's drag item carrying `threadIDs`, made when SwiftUI asks for it as the drag starts; it tells `drag`
    /// (`itemMade`), so the rail opens at once. SwiftUI asks on the main thread; asked elsewhere, `drag` hears right
    /// after.
    nonisolated static func item(_ threadIDs: [String], telling drag: MailDragState?) -> MailDrag {
        if let drag {
            if Thread.isMainThread {
                MainActor.assumeIsolated { drag.itemMade(threadIDs) }
            } else {
                Task { @MainActor in drag.itemMade(threadIDs) }
            }
        }
        return MailDrag(threadIDs: threadIDs)
    }
}
