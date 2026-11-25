#if os(iOS)
    import SwiftUI
    import UsualMailDesign
    import UsualMailKit

    /// The iPhone's top row, over the wallpaper (the owner's concept of 2026-11-20): search on the left, the switcher in
    /// the middle, settings on the right. Together they are the Mac's rail: search opens over the stack showing; the
    /// switcher's menu goes to a profile's mail or to To reply, Pinned, Snoozed or the Inbox page, each a stack kept as
    /// it was left (`Navigation`); settings is its own stack. The glass is the Mac's (`GlassControl`), 32 points; the
    /// two round buttons take touches 6 points beyond it (the switcher doesn't: room around a `Menu`'s label is drawn
    /// as glass). Its ink follows the wallpaper under it as the rail's does (`RailTone`).
    struct PhoneTopBar: View {
        let nav: Navigation
        let inboxes: [Inbox]
        /// The server's counts, for To reply, Pinned and Snoozed in the menu (`RailCount`).
        let counts: Counts?
        /// A profile was chosen in the menu (nil: every inbox).
        let chooseProfile: (String?) -> Void
        /// Search, settings or one of the menu's pages was pressed.
        let press: (Place) -> Void
        @Environment(MailStore.self) private var store
        @Environment(\.windowSize) private var window
        @State private var addingGmail = false

        /// How far beyond its glass a control takes touches.
        static let touchSlop: CGFloat = 6

        var body: some View {
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 0) {
                    round(.search)
                    Spacer(minLength: 4)
                    switcher
                    Spacer(minLength: 4)
                    round(.settings)
                }
            }
            .animation(Motion.move, value: nav.place)
            .sheet(isPresented: $addingGmail) {
                AddGmailSheet { addingGmail = false }
                    .environment(store)
                    .environment(\.windowSize, window)
                    .presentationDetents([.medium, .large])
            }
        }

        /// Search or settings: a round glass button, lit while its page shows.
        private func round(_ target: Place) -> some View {
            let lit = nav.place == target
            return Button {
                press(target)
            } label: {
                RailIcon(icon: target.icon, lit: lit)
                    .glassControl(lit: lit)
                    .padding(Self.touchSlop)
                    .contentShape(Circle())
            }
            .buttonStyle(PlainControlStyle())
            .accessibilityLabel(target.title)
            .accessibilityAddTraits(lit ? .isSelected : [])
        }

        /// The switcher: where the window is, and under it the system's menu of everywhere else.
        private var switcher: some View {
            let label = PhoneSwitch.label(nav: nav, inboxes: inboxes)
            return Menu {
                Section {
                    profile(nil, icon: .allInboxes, name: PhoneSwitch.allInboxes, address: nil)
                    ForEach(inboxes) { inbox in
                        profile(
                            inbox.id, icon: Icon(inbox.icon), name: inbox.name, address: inbox.address,
                            stopped: SyncWarning.stopped(inbox))
                    }
                }
                Section {
                    ForEach(PhoneSwitch.pages, id: \.self) { page in
                        row(icon: page.icon, chosen: PhoneSwitch.ticks(page, nav: nav)) {
                            press(page)
                        } title: {
                            Text(page.title)
                        }
                        .badge(RailCount.count(page, in: counts))
                    }
                }
                Section {
                    row(icon: .add, chosen: false) {
                        addingGmail = true
                    } title: {
                        Text(PhoneSwitch.addGmail)
                    }
                }
            } label: {
                SwitcherLabel(label: label, warns: PhoneSwitch.warning(inboxes: inboxes) != nil)
            }
            .menuOrder(.fixed)
            .buttonStyle(.plain)
            .accessibilityLabel("Showing \(label.title)")
            .accessibilityValue(PhoneSwitch.warning(inboxes: inboxes) ?? "")
            .accessibilityHint("Chooses an inbox or a list.")
        }

        /// A profile's row: the mail stack on it, from any stack, at the page the mail stack last had. An inbox whose
        /// name isn't its address shows the address under it. Both are cut to one line (`PhoneSwitch.menuTitle`). An
        /// inbox that stopped syncing has the warning triangle for its icon and "Stopped syncing" under its name
        /// (`SyncWarning`).
        private func profile(
            _ id: String?, icon: Icon, name: String, address: String?, stopped: Bool = false
        ) -> some View {
            Group {
                if let subtitle = PhoneSwitch.menuSubtitle(name: name, address: address, stopped: stopped) {
                    row(icon: icon, chosen: nav.profileMark.marks(id), warns: stopped) {
                        chooseProfile(id)
                    } title: {
                        Text(verbatim: PhoneSwitch.menuTitle(name))
                        Text(verbatim: PhoneSwitch.menuTitle(subtitle))
                    }
                } else {
                    row(icon: icon, chosen: nav.profileMark.marks(id), warns: stopped) {
                        chooseProfile(id)
                    } title: {
                        Text(verbatim: PhoneSwitch.menuTitle(name))
                    }
                }
            }
            .accessibilityLabel(Text(verbatim: stopped ? "\(name), \(SyncWarning.words.lowercased())" : name))
        }

        /// One row of the menu: a plain button, so the system keeps no column for ticks, whose icon is a tick while
        /// it is what shows (owner's words of 2026-11-24: "change the selected icon to [a] check mark"), else the
        /// warning triangle for an inbox that stopped syncing. Every icon is drawn into the same box (`Icon.menuImage`),
        /// since the design package's are drawn larger than the app's. The texts and the picture are the button's own
        /// label, not a `Label`'s: from a `Label` the system's menu took the first text only, so no line ever showed
        /// under a name (seen 2026-11-25).
        private func row<Title: View>(
            icon: Icon, chosen: Bool, warns: Bool = false, action: @escaping () -> Void,
            @ViewBuilder title: () -> Title
        ) -> some View {
            Button(action: action) {
                title()
                if chosen {
                    Image(systemName: "checkmark")
                } else if warns {
                    Icon.warningMenuImage
                } else {
                    icon.menuImage
                }
            }
            .accessibilityAddTraits(chosen ? .isSelected : [])
        }
    }

    extension Icon {
        /// The side of the box every icon of the switcher's menu is drawn into.
        static let menuSide: CGFloat = 18

        /// The icon drawn into a `menuSide` box, as a template the menu tints. The system's menu shows a picture at
        /// its own size, and the design package's drawings are larger than this package's 16-point ones.
        var menuImage: Image {
            let side = Icon.menuSide
            guard let drawing = UIImage(named: rawValue, in: catalog, with: nil) else { return image }
            let box = CGSize(width: side, height: side)
            let drawn = UIGraphicsImageRenderer(size: box).image { _ in
                drawing.draw(in: CGRect(origin: .zero, size: box))
            }
            return Image(uiImage: drawn.withRenderingMode(.alwaysTemplate))
        }

        /// The warning triangle for the menu, in the danger colour: drawn as it is, since the menu tints templates.
        static var warningMenuImage: Image {
            let configuration = UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
            guard let triangle = UIImage(systemName: SyncWarning.symbol, withConfiguration: configuration) else {
                return Image(systemName: SyncWarning.symbol)
            }
            return Image(uiImage: triangle.withTintColor(UIColor(UsualColor.danger), renderingMode: .alwaysOriginal))
        }
    }

    /// The switcher's capsule: the icon and name of what shows, and a chevron, in the wallpaper's tone under it. While
    /// an inbox has stopped syncing (`warns`), the warning triangle before the chevron, so the menu says it without
    /// being opened.
    private struct SwitcherLabel: View {
        let label: PhoneSwitch
        var warns = false
        @Environment(\.railWindow) private var window
        @State private var frame: CGRect = .zero

        var body: some View {
            let tint = RailTone.tint(for: frame, in: window)
            HStack(spacing: 8) {
                label.icon.view(tint: tint ?? Theme.icon)
                    .id(label.icon)
                    .transition(.blurReveal)
                Text(verbatim: label.title)
                    .font(Theme.sans(12))
                    .foregroundStyle(tint ?? Theme.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .contentTransition(.opacity)
                if warns {
                    SyncWarningMark(size: 11)
                        .transition(.blurReveal)
                }
                Icon.expand.view(tint: tint ?? Theme.icon)
            }
            .padding(.horizontal, 14)
            .glassControl()
            .onGeometryChange(for: CGRect.self) {
                $0.frame(in: .global)
            } action: {
                frame = $0
            }
            .animation(Motion.reveal, value: tint == nil)
            .animation(Motion.move, value: label)
            .animation(Motion.reveal, value: warns)
        }
    }
#endif
