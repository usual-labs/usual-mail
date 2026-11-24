import SwiftUI

/// Whether the rail is open: wider, each button named beside its icon (owner's words of 2026-11-20: "when user hover on
/// the sidebar, the items should get widened smoothly and show the lables"). The pointer resting on the rail opens it
/// after `delay`, so a pointer only crossing it doesn't. A mail drag opens it at once, wherever it starts, so To reply,
/// Pinned and Snoozed are named before the pointer gets there (owner's words of 2026-11-20: "when starting drag and
/// drop, the side bar items should extend (like hover effect) to make drop easier"); a drop on one of them keeps it open
/// for the drop's beat, and the choice of when mail dropped on Snoozed comes back for as long as it is up. When none of
/// these holds any longer, it narrows at once, unless the pointer rests on it: then it stays open as hovering keeps it.
/// The rail tells it where the pointer and the mail are. A debug build launched with `-UsualMailRailOpen YES` keeps it
/// open throughout (`staysOpen`).
@MainActor
@Observable
final class RailOpening {
    private(set) var isOpen = false

    /// How long the pointer rests on the rail before it opens: as long as a tooltip waits (`Tooltip.delay`), so the
    /// rail opens instead of its button's tooltip.
    @ObservationIgnored let delay: Duration
    /// While the rail only supposes the pointer is on it, how often it looks again (`findPointer`).
    @ObservationIgnored let recheck: Duration
    /// Whether the pointer is on the rail now, read from the window (`RailPointer`): no hover is reported while mail is
    /// dragged, so when mail lets the rail go, this says where the pointer really is. Without it, the hover's word.
    @ObservationIgnored var findPointer: (@MainActor () -> Bool)?
    /// Open for good, as if the pointer rested on it (`LaunchOptions.railOpening`), so the open rail can be captured.
    @ObservationIgnored let staysOpen: Bool
    @ObservationIgnored private var pointerOn = false
    @ObservationIgnored private var rested = false
    /// The pointer counts as on the rail from `findPointer`, with no hover reported since.
    @ObservationIgnored private var supposed = false
    @ObservationIgnored private var mailHolds = false
    @ObservationIgnored private var waiting: Task<Void, Never>?
    @ObservationIgnored private var checking: Task<Void, Never>?

    init(
        delay: Duration = Tooltip.delay, recheck: Duration = .milliseconds(100),
        findPointer: (@MainActor () -> Bool)? = nil, staysOpen: Bool = false
    ) {
        self.delay = delay
        self.recheck = recheck
        self.findPointer = findPointer
        self.staysOpen = staysOpen
        isOpen = staysOpen
    }

    /// The pointer came onto the rail (anywhere in its column, the gaps between its buttons too), or left it. The hover's
    /// word is the rail's again from here.
    func pointerOnRail(_ on: Bool) {
        stopChecking()
        guard on != pointerOn else { return }
        pointerOn = on
        rested = false
        waiting?.cancel()
        waiting = nil
        if on {
            let delay = self.delay
            waiting = Task { [weak self] in
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, let self else { return }
                rested = true
                settle()
            }
        }
        settle()
    }

    /// Where dragged mail stands (`MailDragState`): a drag going on, a drop just landed on one of the rail's buttons
    /// (its beat), and the choice of when mail dropped on Snoozed comes back. Any of them holds the rail open.
    func mail(dragging: Bool, landed: Bool, choosingSnooze: Bool) {
        let holds = dragging || landed || choosingSnooze
        guard holds != mailHolds else { return }
        mailHolds = holds
        if holds {
            stopChecking()
        } else {
            letGo()
        }
        settle()
    }

    /// Mail no longer holds the rail open: the pointer on it then counts as resting there, as hovering keeps an open
    /// rail open, and it narrows when the pointer leaves; elsewhere, at once. Where the pointer is comes from
    /// `findPointer` when the rail has it, as no hover was reported during the drag; then, until the hover reports
    /// again, it looks every `recheck`, so the rail can't stay open after the pointer has gone.
    private func letGo() {
        stopChecking()
        let found = findPointer?() ?? pointerOn
        pointerOn = found
        rested = found
        waiting?.cancel()
        waiting = nil
        supposed = found && findPointer != nil
        if supposed {
            let every = recheck
            checking = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: every)
                    guard !Task.isCancelled, let self, self.supposed else { return }
                    if self.findPointer?() != true {
                        self.supposed = false
                        self.pointerOn = false
                        self.rested = false
                        self.settle()
                        return
                    }
                }
            }
        }
    }

    private func stopChecking() {
        supposed = false
        checking?.cancel()
        checking = nil
    }

    private func settle() {
        let open = staysOpen || mailHolds || (pointerOn && rested)
        if isOpen != open { isOpen = open }
    }

    /// How the rail opens and narrows: the app's spring (`Motion.move`), its capsules widening; under Reduce Motion at
    /// once, only the names fading (`reveal`).
    static func animation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : Motion.move
    }
}

/// How the rail draws now, handed to its buttons: open or narrow, whether it is open over the card, and whether mail
/// is being dragged.
struct RailLook: Equatable {
    var isOpen = false
    /// The open rail reaches over the card in this window (`RailFit.reachesCard`).
    var reachesCard = false
    /// Mail is being dragged: the buttons that take none (search, the switch with its plus, the classic inbox,
    /// settings) dim, so To reply, Pinned and Snoozed stand out.
    var dimsOthers = false

    /// How much of a dimmed button's icon and name shows.
    static let dimmed = 0.45
    /// How the dimming comes and goes: the reveal's fade, the same under Reduce Motion, as it only fades.
    static let dimming = Motion.reveal

    /// Each button's and the switch's width.
    var width: CGFloat { isOpen ? RailFit.openWidth : RailFit.button }

    /// Open over the card: each button white under its glass, as the dragged mail's pill, and its icon and name in the
    /// design's own dark colours whatever the wallpaper, so they read over the card's rows.
    var frosted: Bool { isOpen && reachesCard }

    /// How much of a button's icon and name shows: all, or `dimmed` while mail is dragged for one that takes none.
    /// Its glass stays as it is.
    func strength(takesMail: Bool) -> Double {
        dimsOthers && !takesMail ? Self.dimmed : 1
    }

    /// The fill under a button's glass: none, or while frosted white at 70%, and the light grey of the design's
    /// hairline for a chosen one (its place showing, or taking dragged mail), as a sidebar marks its choice, since the
    /// glass's white tint doesn't show over white.
    func frosting(chosen: Bool) -> Color {
        guard frosted else { return .clear }
        return chosen ? Theme.hairline : Color.white.opacity(0.7)
    }

    /// How much white lights the current stack's button (the coordinator's brief of 2026-11-20, from the owner's
    /// captures: its tinted glass differed from the others' by 2 to 4 levels over the sky, so no one could tell which
    /// stack showed). Lit, it reads as chosen over the sky and the hills alike, as the mail page's chosen buttons do,
    /// its icon and name in the design's dark ink (`RailIcon`, `RailLabel`).
    static let lit = 0.8

    /// The fill under a button's glass: `chosen` while its stack shows, `accepting` while it takes dragged mail. Frosted,
    /// as `frosting`. Otherwise the chosen one is lit, white at `lit`, faded as its icon is while mail is dragged and it
    /// takes none (`strength`), so To reply, Pinned and Snoozed lead; the others have none, those taking mail tinted by
    /// their glass instead.
    func fill(chosen: Bool, accepting: Bool, takesMail: Bool) -> Color {
        if frosted { return frosting(chosen: chosen || accepting) }
        return chosen ? Color.white.opacity(Self.lit * strength(takesMail: takesMail)) : .clear
    }
}

extension EnvironmentValues {
    @Entry var railLook = RailLook()
}
