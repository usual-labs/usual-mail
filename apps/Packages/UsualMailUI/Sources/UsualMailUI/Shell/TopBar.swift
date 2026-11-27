import SwiftUI
import UsualMailDesign
import UsualMailKit

/// The row above the card. On a page it is the four tabs (Home, Feed, Receipts, Notifications) and, at the right, the
/// screening queue with how many wait. With a mail open (owner's direction of
/// 2026-11-17):
/// - the chosen tab stays where it is and becomes the back button: only its icon changes, to the arrow, in a blur;
/// - the mail's buttons (reply later, pin, snooze, archive, more) pop in as glass, from small to full size, and the
///   other tabs and the screening queue pop out the same way. (Until 2026-11-19 To reply, Pinned and Snoozed were tabs
///   and slid right to become their buttons; they are the rail's now.)
/// A mail opened from Screening: the Screening capsule goes to the left and becomes the back button, its icon turning
/// to the arrow, and the buttons for a mail from someone not yet let in pop in: let in, block, more.
/// Each capsule keeps its glass (`glassEffectID`) while it stays, so it moves rather than being swapped.
/// Those are the mail stack's. Every other stack has its own row (each sidebar destination its own stack, owner's words
/// of 2026-11-20), which the window draws over this one (`MailWindow.bar`), with no way back to another stack:
/// - To reply, Pinned, Snoozed and the Inbox page: a quiet title capsule with the page's icon and name where the tabs
///   are, not a button; with a mail open, it becomes the back to the list, as a chosen tab does, the mail's actions
///   popping in;
/// - Settings: only its five tabs;
/// - search, over any stack: a capsule back to where the person was ("← Pinned"), and with a mail open from the
///   results, back to them ("← Search").
/// Whichever bar is `hidden` blurs out: its words and icons out of focus, its glass fading.
///
/// On the iPhone the same row sits at the foot of the card (`compact`, the owner's concept of 2026-11-20: the tabs and
/// controls "come down from the top"), with what a narrow screen and a finger ask for: capsules 44 points high
/// (`ControlSize`); a back button is the arrow alone once a mail is open, so the mail's five buttons fit; To reply,
/// Pinned, Snoozed and the Inbox page show no title capsule, as the switcher above the card names them; Settings' tabs
/// sit in the middle of the row, not at its right; the chosen tab is named only when the row fits it (`BarFit`), else
/// it is its lit icon alone; snooze and more are the system's menus (`PhoneBarMenu`), where the Mac has popovers; and a
/// tab holding mail not seen yet has a dot at its icon's corner (`TabNews`).
struct TopBar: View {
    @Binding var place: Place
    let screeningCount: Int
    /// The open mail, while one is.
    let mail: MailThread?
    /// On search's results, the name of where its capsule goes back to.
    var returnTitle = Place.tab(.home).title
    /// Out of sight and out of reach: no clicks, no Esc, nothing for accessibility.
    var hidden = false
    /// On Settings: the tab its page shows, which its capsules at the right choose.
    var settingsTab: Binding<SettingsTab> = .constant(.accounts)
    /// On Settings: whether the tabs not chosen show their names (`SettingsTab.showsNames`), or only their icons.
    var namesSettingsTabs = true
    /// The iPhone's row, at the foot of the card.
    var compact = false
    /// On the iPhone, the row's width, so a chosen tab is named only when it fits (`BarFit`); nil names it always.
    var room: CGFloat? = nil
    /// The moment the mail's buttons are drawn for: whether it still waits to come back (`BarAction.button`).
    var now = Date()
    /// On the iPhone, the tabs holding mail not seen yet, each with a dot (`TabNews`); none on the Mac.
    var dots: Set<Tab> = []
    let back: () -> Void
    let act: (ActionInput) -> Void
    @Namespace private var glass
    @State private var menu: BarAction?

    private var reading: Bool { mail != nil }

    var body: some View {
        let items = TopBar.items(place: place, reading: reading, compact: compact)
        // Whether the chosen tab is named: always on the Mac; on the iPhone when the row fits it.
        let names = room.map { BarFit.fits(items, room: $0, title: { title(of: $0, names: true) }) } ?? true
        GlassEffectContainer(spacing: ControlSize.spacing) {
            HStack(spacing: ControlSize.spacing) {
                ForEach(items) { item in
                    switch item {
                    case .tab(let tab): slot(tab, names: names)
                    case .action(let action):
                        if let mail { actionButton(action, item: item, mail: mail) }
                    case .gap: Spacer(minLength: ControlSize.spacing)
                    case .screening: screeningButton(names: names)
                    case .back: backButton
                    case .title: titleCapsule
                    case .settings(let tab): settingsSlot(tab, names: names)
                    }
                }
            }
        }
        .frame(maxWidth: TopBar.centres(place: place, compact: compact) ? .infinity : nil)
        .frame(height: ControlSize.height)
        .opacity(hidden ? 0 : 1)
        .allowsHitTesting(!hidden)
        .disabled(hidden)
        .accessibilityHidden(hidden)
        .animation(hidden ? Motion.leave : Motion.reveal, value: hidden)
        .animation(Motion.move, value: reading)
        .animation(Motion.move, value: place)
        .animation(Motion.reveal, value: screeningCount)
        .animation(Motion.move, value: settingsTab.wrappedValue)
        .animation(Motion.move, value: namesSettingsTabs)
        .onChange(of: reading) { menu = nil }
    }

    /// The tab whose page is showing, if a tab's is.
    private var selectedTab: Tab? { place.tab }

    /// The screening capsule's ends and the room between its icon and its count, a little less than the others'.
    nonisolated static let screeningInset: CGFloat = 10
    nonisolated static let screeningSpacing: CGFloat = 4

    /// A back button's name: none on the iPhone, where the arrow alone leaves room for the mail's buttons.
    private func backTitle(_ title: String) -> String? { compact && reading ? nil : title }

    /// The words an item's capsule shows, `names` saying whether a chosen tab is named: the one place they are
    /// decided, for drawing the row and for seeing whether it fits (`BarFit`).
    func title(of item: Item, names: Bool) -> String? {
        switch item {
        case .tab(let tab):
            if reading, tab == selectedTab { return backTitle(tab.title) }
            return names && tab == selectedTab ? tab.title : nil
        case .settings(let tab):
            let selected = settingsTab.wrappedValue == tab
            return (selected ? names : namesSettingsTabs) ? tab.title : nil
        case .screening:
            if reading && place == .screening { return backTitle("Screening") }
            if place == .screening { return names ? "Screening" : nil }
            return screeningCount > 0 ? "\(screeningCount)" : nil
        case .back: return backTitle(reading ? place.title : returnTitle)
        case .title: return reading ? backTitle(place.title) : place.title
        case .action, .gap: return nil
        }
    }

    // MARK: Arrangement

    enum Item: Hashable, Identifiable, Sendable {
        case tab(Tab)
        case action(BarAction)
        case gap
        case screening
        /// Search's capsule: back to where the person was, or with a mail open, to the results.
        case back
        /// The page's name on To reply, Pinned, Snoozed and the Inbox page; with a mail open, the back to the list.
        case title
        /// One of Settings' tabs, at the right of its row.
        case settings(SettingsTab)

        var id: Self { self }
    }

    /// On a tab's page: every tab, a gap, the screening queue. With a mail open from a tab: that tab, a gap, then the
    /// five mail actions. With a mail open from Screening: the screening capsule, a gap, let in, block and more. On To
    /// reply, Pinned, Snoozed and the Inbox page: the title capsule, and with a mail open, the five mail actions after
    /// it. On Settings: a gap, then its five tabs, at the right. On search: its capsule back, and with a mail open, the
    /// five mail actions after it. `compact`, the iPhone's: no title capsule until a mail is open, and Settings' tabs
    /// with no gap, as the row centres them (`centres`).
    static func items(place: Place, reading: Bool, compact: Bool = false) -> [Item] {
        let actions = reading ? BarAction.mailActions.map(Item.action) : []
        if compact, !reading, [.toReply, .pinned, .snoozed, .inbox].contains(place) { return [] }
        switch place {
        case .settings:
            let tabs = SettingsTab.allCases.map(Item.settings)
            return compact ? tabs : [.gap] + tabs
        case .search:
            return [.back, .gap] + actions
        case .toReply, .pinned, .snoozed, .inbox:
            return [.title, .gap] + actions
        case .tab(let selected) where reading:
            return [.tab(selected), .gap] + actions
        case .screening where reading:
            return [.screening, .gap] + BarAction.screeningActions.map(Item.action)
        case .tab, .screening:
            return Tab.allCases.map(Item.tab) + [.gap, .screening]
        }
    }

    /// Whether the row's items sit in its middle rather than from its left: Settings' tabs on the iPhone (the owner's
    /// words of 2026-11-24, "in settings page, make the bottom tabs centered. only in iphone", and again on 2026-11-25,
    /// "bring back the settings tabs to center and remove the back button"). The Mac keeps them at the right, past the
    /// gap.
    static func centres(place: Place, compact: Bool) -> Bool {
        compact && place == .settings
    }

    // MARK: Capsules

    @ViewBuilder private func slot(_ tab: Tab, names: Bool) -> some View {
        if reading, tab == selectedTab {
            Button(action: back) {
                capsule(.tab(tab), icon: .back, title: title(of: .tab(tab), names: names), tinted: true)
            }
            .buttonStyle(PlainControlStyle())
            .keyboardShortcut(.cancelAction)
            .tooltip("Back to \(tab.title) (Esc)")
            .accessibilityLabel("Back to \(tab.title)")
        } else {
            let selected = selectedTab == tab
            let dot = dots.contains(tab) && !selected
            Button {
                withAnimation(Motion.move) { place = .tab(tab) }
            } label: {
                capsule(
                    .tab(tab), icon: tab.icon, title: title(of: .tab(tab), names: names), tinted: false, lit: selected,
                    dot: dot)
            }
            .buttonStyle(PlainControlStyle())
            .tooltip(selected ? nil : tab.title)
            .accessibilityLabel(tab.title)
            .accessibilityValue(dot ? "New mail" : "")
            .accessibilityAddTraits(selected ? .isSelected : [])
        }
    }

    /// One of Settings' tabs: the chosen one lit (`GlassControl.lit`) with its icon and name (on the iPhone when the
    /// row fits it); the others clear, named too when there is room, else their icon alone with the name as a tooltip.
    private func settingsSlot(_ tab: SettingsTab, names: Bool) -> some View {
        let selected = settingsTab.wrappedValue == tab
        let title = title(of: .settings(tab), names: names)
        return Button {
            withAnimation(Motion.move) { settingsTab.wrappedValue = tab }
        } label: {
            capsule(.settings(tab), icon: tab.icon, title: title, tinted: false, lit: selected)
        }
        .buttonStyle(PlainControlStyle())
        .tooltip(title == nil ? tab.title : nil)
        .accessibilityLabel(tab.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// One capsule of glass, `ControlSize.height` high: an icon that changes in a blur (the chosen tab's, turning to the arrow), and a
    /// tab's name that comes and goes in one. Glass that comes or goes pops: from small to full size, and back. A
    /// `still` one is no button, so its glass doesn't answer the pointer. The chosen tab, the mail stack's or
    /// Settings', is `lit` as the rail's current button is, white under its clear glass, so it reads over the sky and
    /// the hills alike (`TabChosenTests`); its icon and name are in the design's dark ink anyway. Its glass stays the
    /// others' and keeps its `glassEffectID`, so switching tabs only moves the light and the capsules' widths. With a
    /// mail open it is the back button, tinted as every back button is. A `dot` sits at its icon's top right corner: a
    /// tab with mail not seen yet (`TabNews`).
    private func capsule(
        _ item: Item, icon: Icon, title: String?, tinted: Bool, lit: Bool = false, still: Bool = false,
        spacing: CGFloat = 6, inset: CGFloat = ControlSize.inset, dot: Bool = false
    ) -> some View {
        HStack(spacing: spacing) {
            icon.view(size: ControlSize.icon, tint: icon.isGrey ? Theme.icon : nil)
                .overlay(alignment: .topTrailing) {
                    if dot { NewDot().transition(.scale.combined(with: .opacity)) }
                }
                .animation(Motion.reveal, value: dot)
                .id(icon)
                .transition(.blurReveal)
            if let title {
                Text(title)
                    .font(Theme.sans(ControlSize.text))
                    .foregroundStyle(Theme.ink)
                    .fixedSize()
                    .contentTransition(.numericText())
                    .transition(.blurReveal)
            }
        }
        // A hidden bar's words and icons go out of focus; its glass only fades (glass isn't blurred).
        .modifier(BlurReveal(progress: hidden ? 0 : 1))
        .padding(.horizontal, inset)
        .glassControl(selected: tinted, lit: lit, interactive: !still)
        .glassEffectID(item, in: glass)
        .glassEffectTransition(.materialize)
        .transition(.glassPop)
        .contentShape(Capsule())
    }

    /// An action's button. Reply later, pin and snooze offer the way back when the mail is already there, drawn chosen
    /// (`BarAction.button`): lit as a chosen tab is, its glass clear, so it reads over the sky and the hills alike
    /// (`BarChosenTests`); snooze then unsnoozes at once instead of opening its menu.
    @ViewBuilder
    private func actionButton(_ action: BarAction, item: Item, mail: MailThread) -> some View {
        let button = action.button(for: mail, now: now)
        if let input = button.input {
            Button {
                act(input)
            } label: {
                capsule(item, icon: action.icon, title: nil, tinted: !button.chosen, lit: button.chosen)
            }
            .buttonStyle(PlainControlStyle())
            .tooltip(button.title)
            .accessibilityLabel(button.title)
            .accessibilityAddTraits(button.chosen ? .isSelected : [])
        } else {
            #if os(iOS)
                // The system's menu on the iPhone (the owner's words of 2026-11-25: "this menu does not look native"). Its
                // times are worked out afresh every minute, and on coming back to the front, not from when the mail
                // was opened: a phone locked at 16:45 and opened at 17:55 offers no "Later today, 18:00".
                TimelineView(.everyMinute) { context in
                    Menu {
                        PhoneBarMenu(action: action, mail: mail, now: context.date, choose: act)
                    } label: {
                        capsule(item, icon: action.icon, title: nil, tinted: true)
                    }
                    .menuOrder(.fixed)
                    .buttonStyle(.plain)
                    .accessibilityLabel(action.title)
                }
            #else
                Button {
                    menu = action
                } label: {
                    capsule(item, icon: action.icon, title: nil, tinted: true)
                }
                .buttonStyle(PlainControlStyle())
                .tooltip(menu == action ? nil : action.title)
                .accessibilityLabel(action.title)
                // Under the row, the app's own popover.
                .popover(
                    isPresented: Binding(get: { menu == action }, set: { if !$0 { menu = nil } }), arrowEdge: .bottom
                ) {
                    if action == .snooze {
                        SnoozeMenu { choice in choose(choice.input) }
                    } else {
                        MoreMenu(mail: mail) { choose($0) }
                    }
                }
            #endif
        }
    }

    private func choose(_ input: ActionInput) {
        menu = nil
        act(input)
    }

    /// Search's capsule, where the tabs were, in the mail page's back button's style: on the results, back to where the
    /// person was ("← Home", "← Pinned"), only on a click, as its Esc clears the field first (`SearchView`); with a
    /// mail open from them, back to the results ("← Search"), Esc too, its name changing in place.
    private var backButton: some View {
        let title = reading ? place.title : returnTitle
        return Button(action: back) {
            capsule(.back, icon: .back, title: self.title(of: .back, names: true), tinted: true)
        }
        .buttonStyle(PlainControlStyle())
        .keyboardShortcut(reading ? .cancelAction : nil)
        .tooltip(reading ? "Back to \(title) (Esc)" : "Back to \(title)")
        .accessibilityLabel("Back to \(title)")
    }

    /// To reply's, Pinned's, Snoozed's or the Inbox page's name where the tabs are (the coordinator's spec of
    /// 2026-11-20): the page's icon and name in a tab's capsule without the chosen tint, not a button, so the top isn't
    /// bare and nothing jumps between stacks. With a mail open from the list it is the back to it, as a chosen tab is:
    /// tinted, only its icon turning to the arrow, in a blur; Esc too.
    @ViewBuilder private var titleCapsule: some View {
        if reading {
            Button(action: back) {
                capsule(.title, icon: .back, title: backTitle(place.title), tinted: true)
            }
            .buttonStyle(PlainControlStyle())
            .keyboardShortcut(.cancelAction)
            .tooltip("Back to \(place.title) (Esc)")
            .accessibilityLabel("Back to \(place.title)")
        } else {
            capsule(.title, icon: place.icon, title: place.title, tinted: false, still: true)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(place.title)
                .accessibilityAddTraits(.isHeader)
        }
    }

    /// The screening queue: how many wait, or "Screening" on its own page; with a mail opened from it, the back
    /// button (its icon turning to the arrow).
    @ViewBuilder private func screeningButton(names: Bool) -> some View {
        if reading && place == .screening {
            Button(action: back) {
                capsule(
                    .screening, icon: .back, title: title(of: .screening, names: names), tinted: true,
                    spacing: Self.screeningSpacing, inset: Self.screeningInset)
            }
            .buttonStyle(PlainControlStyle())
            .keyboardShortcut(.cancelAction)
            .tooltip("Back to Screening (Esc)")
            .accessibilityLabel("Back to Screening")
        } else {
            let here = place == .screening
            Button {
                withAnimation(Motion.move) { place = here ? .tab(.home) : .screening }
            } label: {
                // On its own page it carries its name, as a chosen tab does (Figma frame "MacBook Pro 14" - 8");
                // elsewhere how many wait.
                capsule(
                    .screening, icon: .screening, title: title(of: .screening, names: names), tinted: here,
                    spacing: Self.screeningSpacing, inset: Self.screeningInset)
            }
            .buttonStyle(PlainControlStyle())
            .tooltip(here ? nil : "Screening")
            .accessibilityLabel("Screening, \(screeningCount) waiting")
        }
    }
}

/// A tab's dot for mail not seen yet (`TabNews`): 8 points of the danger colour, ringed in white so it reads on the
/// glass over the sky and the hills alike, just past its icon's top right corner, as iOS badges an app.
struct NewDot: View {
    static let side: CGFloat = 8

    var body: some View {
        Circle()
            .fill(UsualColor.danger)
            .frame(width: Self.side, height: Self.side)
            .overlay(Circle().strokeBorder(.white, lineWidth: 1.5).padding(-1.5))
            .offset(x: 3, y: -2)
            .accessibilityHidden(true)
    }
}
