#if os(iOS)
    import SwiftUI
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
                        profile(inbox.id, icon: Icon(inbox.icon), name: inbox.name, address: inbox.address)
                    }
                }
                Section {
                    ForEach(PhoneSwitch.pages, id: \.self) { page in
                        Toggle(isOn: ticked(PhoneSwitch.ticks(page, nav: nav)) { press(page) }) {
                            Label {
                                Text(page.title)
                            } icon: {
                                page.icon.image.renderingMode(.template)
                            }
                        }
                        .badge(RailCount.count(page, in: counts))
                    }
                }
                Section {
                    Button {
                        addingGmail = true
                    } label: {
                        Label {
                            Text(AddGmailSheet.title)
                        } icon: {
                            Icon.add.image.renderingMode(.template)
                        }
                    }
                }
            } label: {
                SwitcherLabel(label: label)
            }
            .menuOrder(.fixed)
            .buttonStyle(.plain)
            .accessibilityLabel("Showing \(label.title)")
            .accessibilityHint("Chooses an inbox or a list.")
        }

        /// A profile's row: the mail stack on it, from any stack, at the page the mail stack last had. An inbox whose
        /// name isn't its address shows the address under it.
        private func profile(_ id: String?, icon: Icon, name: String, address: String?) -> some View {
            Toggle(isOn: ticked(nav.profileMark.marks(id)) { chooseProfile(id) }) {
                Label {
                    Text(verbatim: name)
                    if let address, !address.isEmpty, address != name { Text(verbatim: address) }
                } icon: {
                    icon.image.renderingMode(.template)
                }
            }
        }

        /// A menu row's tick: on while its page shows; choosing it, ticked or not, goes there.
        private func ticked(_ on: Bool, go: @escaping () -> Void) -> Binding<Bool> {
            Binding(get: { on }, set: { _ in go() })
        }
    }

    /// The switcher's capsule: the icon and name of what shows, and a chevron, in the wallpaper's tone under it.
    private struct SwitcherLabel: View {
        let label: PhoneSwitch
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
        }
    }
#endif
