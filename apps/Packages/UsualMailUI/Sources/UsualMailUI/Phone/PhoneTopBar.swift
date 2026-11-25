#if os(iOS)
    import SwiftUI
    import UsualMailDesign
    import UsualMailKit

    /// The iPhone's top row, over the wallpaper: the switcher at the left, search at the right, nothing between (the
    /// owner's words of 2026-11-25, "move the search control to the right side and then the drop down menu to the left
    /// side. So center will be empty"; the concept of 2026-11-20 had search at the left, the switcher in the middle and
    /// settings at the right). Together they are the Mac's rail: search opens over the stack showing; the switcher's
    /// menu goes to a profile's mail, to To reply, Pinned, Snoozed or the Inbox page, or to Settings, each a stack kept
    /// as it was left (`Navigation`). The glass is the Mac's (`GlassControl`), at the iPhone's
    /// size, 44 points with 20-point icons and 14-point words (`ControlSize`; the owner's words of 2026-11-25, "make
    /// the header liquid glass controls size bigger"), a finger's size, so nothing takes touches beyond it. Its ink
    /// follows the wallpaper under it as the rail's does (`RailTone`).
    struct PhoneTopBar: View {
        let nav: Navigation
        let inboxes: [Inbox]
        /// The server's counts, for To reply, Pinned and Snoozed in the menu (`RailCount`).
        let counts: Counts?
        /// A profile was chosen in the menu (nil: every inbox).
        let chooseProfile: (String?) -> Void
        /// Search, Settings or one of the menu's pages was pressed.
        let press: (Place) -> Void
        var body: some View {
            GlassEffectContainer(spacing: ControlSize.spacing) {
                HStack(spacing: 0) {
                    switcher
                    Spacer(minLength: 12)
                    round(.search)
                }
            }
            .animation(Motion.move, value: nav.place)
        }

        /// Search: a round glass button, lit while its page shows.
        private func round(_ target: Place) -> some View {
            let lit = nav.place == target
            return Button {
                press(target)
            } label: {
                RailIcon(icon: target.icon, lit: lit, size: ControlSize.icon)
                    .glassControl(lit: lit)
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
                    profile(nil, icon: .allInboxes, name: PhoneSwitch.allInboxes)
                    ForEach(inboxes) { inbox in
                        profile(
                            inbox.id, icon: Icon(inbox.icon), name: inbox.name,
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
                    row(icon: .settings, chosen: PhoneSwitch.ticks(.settings, nav: nav)) {
                        press(.settings)
                    } title: {
                        Text(Place.settings.title)
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

        /// A profile's row: the mail stack on it, from any stack, at the page the mail stack last had. Its name only,
        /// cut to one line (`PhoneSwitch.menuTitle`), not its address (the owner's word of 2026-11-25: "Hide them").
        /// An inbox that stopped syncing has the warning triangle for its icon and "Stopped syncing" under its name
        /// (`SyncWarning`).
        private func profile(_ id: String?, icon: Icon, name: String, stopped: Bool = false) -> some View {
            Group {
                if let subtitle = PhoneSwitch.menuSubtitle(stopped: stopped) {
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
                label.icon.view(size: ControlSize.icon, tint: tint ?? Theme.icon)
                    .id(label.icon)
                    .transition(.blurReveal)
                Text(verbatim: label.title)
                    .font(Theme.sans(ControlSize.text))
                    .foregroundStyle(tint ?? Theme.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .contentTransition(.opacity)
                if warns {
                    SyncWarningMark(size: 13)
                        .transition(.blurReveal)
                }
                Icon.expand.view(size: 18, tint: tint ?? Theme.icon)
            }
            .padding(.horizontal, 16)
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
