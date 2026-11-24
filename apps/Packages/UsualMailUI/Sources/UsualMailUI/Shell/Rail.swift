#if os(macOS)
    import SwiftUI
    import UsualMailKit

    /// The left side, top to bottom: search; the profile switch (every inbox, then each inbox in its `position`, with its
    /// `icon`, then the plus that adds a Gmail account, `AddGmailButton`); the person's lists, To reply, Pinned and
    /// Snoozed (owner's request of 2026-11-19: they were tabs); the classic inbox; and, at the foot of the column,
    /// settings. Each of those but search is a stack of its own, as the switcher's profiles are the mail stack's (owner's
    /// words of 2026-11-20): a button whose stack is showing is chosen, lit (white under its glass, its icon dark,
    /// `RailLook.lit`), and pressing it again does nothing; pressing another goes to its stack as it was left
    /// (`Navigation.press`). The switcher marks a profile only in the mail stack (`ProfileMark`). Its sizes, its height
    /// and how many profiles show at once are `RailFit`'s. A mail row dragged onto To reply, Pinned or Snoozed moves there
    /// (`RailDrop`, owner's words of 2026-11-20).
    ///
    /// The rail opens while the pointer rests on it, and at once while mail is dragged anywhere in the window
    /// (`RailOpening`, owner's words of 2026-11-20): its buttons and the switch widen as shapes to `RailFit.openWidth`, the
    /// icons staying where they are, and each is named beside its icon, To reply, Pinned and Snoozed with how many they
    /// hold (`RailCount`), which a narrow button shows in a badge. Open, it lies over the wallpaper to its right, and over
    /// the card's edge in a narrow window, frosted there (`RailLook.frosted`); nothing else moves. While mail is dragged
    /// the buttons that take none dim (`RailLook.dimsOthers`).
    struct Rail: View {
        let place: Place
        /// The profile the switcher marks, if any.
        let mark: ProfileMark
        let inboxes: [Inbox]
        /// The server's counts, for To reply, Pinned and Snoozed in every inbox (`RailCount`).
        let counts: Counts?
        /// The rail's room before the card (`MailLayout.railRoom`): whether it opens over the card.
        let room: CGFloat
        /// The window's size: its height sets the column's (settings at its foot) and how many profiles show at once; with
        /// its width it tells the icons what wallpaper lies under them (`RailTone`).
        let window: CGSize
        private var windowHeight: CGFloat { window.height }
        /// A profile was chosen in the switcher (nil: every inbox).
        let chooseProfile: (String?) -> Void
        /// A button's place was pressed.
        let press: (Place) -> Void
        /// Mail being dragged in the window: To reply, Pinned and Snoozed take it (`railDropZone`).
        @Environment(MailDragState.self) private var drag: MailDragState?
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        /// Those three buttons' frames in the rail, to tell which one dropped mail is over (`RailDrop`).
        @State private var dropFrames: [Place: CGRect] = [:]
        @State private var opening = LaunchOptions.current.railOpening()
        /// Where the pointer really is, for when no hover is reported: during and right after a drag.
        @State private var pointer = RailPointer()

        /// The person's lists, between the switch and the classic inbox, in this order.
        static let lists: [Place] = [.toReply, .pinned, .snoozed]

        /// The circle for every inbox: a dot in it while it is picked (owner's words of 2026-11-20: "the all inboxes icon
        /// shoould become filled when selected (or add a dot in the circle icon"), the plain circle otherwise.
        static func allInboxesIcon(picked: Bool) -> Icon {
            picked ? .allInboxesChosen : .allInboxes
        }

        /// The switch's pill: a capsule while narrow, and open a rectangle with the same round corners, so it widens as a
        /// shape rather than swelling into an oval.
        static let pillShape = RoundedRectangle(cornerRadius: RailFit.button / 2, style: .continuous)

        private var look: RailLook {
            RailLook(
                isOpen: opening.isOpen, reachesCard: RailFit.reachesCard(room: room),
                dimsOthers: drag?.isDragging ?? false)
        }

        var body: some View {
            GlassEffectContainer(spacing: RailFit.spacing) {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: RailFit.spacing) {
                        railButton(.search)
                        profiles
                        ForEach(Self.lists, id: \.self) { railButton($0) }
                        railButton(.inbox)
                    }
                    Spacer(minLength: RailFit.spacing)
                    railButton(.settings)
                }
                .frame(height: RailFit.column(windowHeight: windowHeight))
                // The whole column is the rail for the pointer, the gaps between buttons too, so moving down it doesn't
                // narrow it.
                .contentShape(Rectangle())
                .onHover { opening.pointerOnRail($0) }
                // The card starts past the rail's room and the gap: over it the open rail takes no mail.
                .railDropZone(frames: dropFrames, cardEdge: room + MailLayout.gap)
            }
            // Outside the container, which draws its glass over everything else inside it: a badge drawn inside sat under
            // its button's glass (owner's report of 2026-11-20).
            .railBadges()
            // Up to the card's edge, as drops: mail let go over the card, where the open rail lies in a narrow window, isn't
            // the pointer resting on the rail.
            .background(alignment: .leading) {
                RailPointerArea(pointer: pointer)
                    .frame(width: min(look.width, room + MailLayout.gap))
                    .allowsHitTesting(false)
            }
            .environment(\.railWindow, window)
            .environment(\.railLook, look)
            .animation(RailOpening.animation(reduceMotion: reduceMotion), value: look.isOpen)
            .onAppear { opening.findPointer = { [pointer] in pointer.isOnRail } }
            .onChange(of: [drag?.isDragging ?? false, drag?.landed != nil, drag?.snoozing != nil]) { _, mail in
                opening.mail(dragging: mail[0], landed: mail[1], choosingSnooze: mail[2])
            }
        }

        /// A round button: its place's icon, chosen (lit, `RailLook.fill`) while its place shows, and its name beside it
        /// while the rail is open, named on hover while it is narrow. While mail is dragged, To reply, Pinned and Snoozed
        /// show they take it, their glass tinted as a chosen tab's (the current one stays lit too), and the one under the
        /// pointer brightens and grows a little around its icon; the one mail was dropped on stays tinted for the drop's
        /// beat. The other buttons dim and don't react, a lit one's white fading with its icon. Mail dropped on Snoozed asks
        /// when it comes back, in a popover here.
        private func railButton(_ target: Place) -> some View {
            let takesMail = MailDrop.targets.contains(target)
            let accepting = drag?.accepts(target) ?? false
            let underMail = accepting && drag?.target == target
            let choosing = target == .snoozed && drag?.snoozing != nil
            let chosen = place == target
            let count = RailCount.count(target, in: counts)
            let look = self.look
            return Button {
                press(target)
            } label: {
                ZStack(alignment: .leading) {
                    RailIcon(icon: target.icon, lit: chosen)
                        .frame(width: RailFit.button, height: RailFit.button)
                    RailLabel(title: target.title, count: count, lit: chosen)
                }
                .animation(RailLook.dimming) { $0.opacity(look.strength(takesMail: takesMail)) }
                .frame(width: look.width, height: RailFit.button, alignment: .leading)
                .clipShape(Capsule())
                .background(look.fill(chosen: chosen, accepting: accepting, takesMail: takesMail), in: Capsule())
                // Chosen by its fill, its glass clear: offscreen, a tint on one glass of the rail's container lightened the
                // others with it (`RailChosenTests`).
                .glassControl(selected: accepting)
                .transformEnvironment(\.isControlHovered) { if underMail { $0 = true } }
                .scaleEffect(underMail ? 1.1 : 1, anchor: UnitPoint(x: RailFit.button / 2 / look.width, y: 0.5))
                .animation(Motion.move, value: underMail)
                .animation(Motion.reveal, value: accepting)
            }
            .buttonStyle(PlainControlStyle())
            .tooltip(choosing || look.isOpen ? nil : target.title, edge: .trailing)
            .accessibilityLabel(target.title)
            .accessibilityValue(count > 0 ? "\(count)" : "")
            .accessibilityHint(takesMail ? "Drop a mail here to move it to \(target.title)." : "")
            .accessibilityAddTraits(chosen ? .isSelected : [])
            // Its count's badge, drawn by the rail over all its glass (`railBadges`).
            .railBadge(target, count: count, grows: underMail)
            .onGeometryChange(for: CGRect.self) {
                $0.frame(in: .named(RailDrop.space))
            } action: { frame in
                if takesMail { dropFrames[target] = frame }
            }
            .popover(isPresented: snoozeChoice(at: target), arrowEdge: .trailing) {
                SnoozeDropMenu()
            }
        }

        /// Whether the choice of when dropped mail comes back shows at `target`: only at Snoozed, while it is open. Closing
        /// it chooses nothing.
        private func snoozeChoice(at target: Place) -> Binding<Bool> {
            Binding(
                get: { target == .snoozed && drag?.snoozing != nil },
                set: { if !$0 { drag?.dismissSnooze() } })
        }

        /// One pill: a circle for every inbox, an icon per inbox, then the plus. With more inboxes than fit
        /// (`RailFit.scrollHeight`), the inboxes scroll between the circle and the plus, their tooltips drawn outside the
        /// scrolling part so it doesn't cut them off.
        private var profiles: some View {
            let look = self.look
            return VStack(alignment: .leading, spacing: RailFit.rowSpacing) {
                profile(nil, icon: Self.allInboxesIcon(picked: mark.marks(nil)), name: "All inboxes")
                if let height = RailFit.scrollHeight(inboxes: inboxes.count, windowHeight: windowHeight) {
                    ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: RailFit.rowSpacing) { inboxRows }
                    }
                    .scrollIndicators(.never)
                    .frame(height: height)
                    .hostsTooltips()
                } else {
                    inboxRows
                }
                AddGmailButton()
            }
            // None of the switch takes mail: it dims while mail is dragged, its glass as it is.
            .animation(RailLook.dimming) { $0.opacity(look.strength(takesMail: false)) }
            .padding(.vertical, RailFit.pillPadding)
            .frame(width: look.width, alignment: .leading)
            .background(look.frosting(chosen: false), in: Self.pillShape)
            // The same glass as the rail's other buttons at rest (`GlassControl`, unselected): clear, untinted (owner's
            // direction of 2026-11-20); a picked profile shows by its icon's full strength. Not interactive: the pill holds
            // several buttons, so pressing one shouldn't light the whole capsule.
            .glassEffect(.clear, in: Self.pillShape)
        }

        /// Each inbox in the order given (`position`), by its id, so one that changes keeps its button.
        private var inboxRows: some View {
            ForEach(inboxes) { inbox in
                profile(inbox.id, icon: Icon(inbox.icon), name: inbox.name)
            }
        }

        /// A profile: the mail stack on it, from any stack, at the page the mail stack last had.
        private func profile(_ id: String?, icon: Icon, name: String) -> some View {
            let selected = mark.marks(id)
            return Button {
                chooseProfile(id)
            } label: {
                ProfileIcon(icon: icon, selected: selected, name: name)
            }
            .buttonStyle(PlainControlStyle())
            .tooltip(look.isOpen ? nil : name, edge: .trailing)
            .accessibilityLabel(name)
            .accessibilityAddTraits(selected ? .isSelected : [])
        }
    }

    /// A profile in the switch: its icon, faint until picked and half-way up under the pointer, and its name beside it
    /// while the rail is open (`RailLabel`), as faint. Picked, the inbox's icon is at full strength, as is the circle for
    /// every inbox, which also takes a dot (`Rail.allInboxesIcon`). The plus draws the same way, never picked. The row
    /// widens with the rail, cutting the name off while narrow.
    struct ProfileIcon: View {
        let icon: Icon
        let selected: Bool
        let name: String
        @Environment(\.isControlHovered) private var hovered
        @Environment(\.railLook) private var look

        var body: some View {
            ZStack(alignment: .leading) {
                // The circle picked or not: the new drawing crossfades with the old.
                RailIcon(icon: icon)
                    .frame(width: RailFit.button, height: RailFit.row)
                    .id(icon)
                    .transition(.opacity)
                RailLabel(title: name)
            }
            .opacity(selected ? 1 : (hovered ? 0.75 : 0.45))
            .frame(width: look.width, height: RailFit.row, alignment: .leading)
            .clipped()
            .contentShape(Rectangle())
        }
    }
#endif
