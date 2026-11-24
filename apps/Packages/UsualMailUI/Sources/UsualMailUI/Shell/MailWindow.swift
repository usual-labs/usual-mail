#if os(macOS)
    import SwiftUI
    import UsualMailKit

    /// The paired window, as the design lays it out: the rail on the left, the top row and the card in a 700-point column
    /// in the middle (900 on the classic inbox and search, `MailLayout`), an empty column on the right, all over the
    /// wallpaper. Each sidebar destination is its own stack (`Navigation`). While
    /// the first run isn't done it shows the onboarding session's steps over the whole window instead
    /// (`Onboarding.isNeeded`: no inbox, no AI key, or the first run unfinished on this Mac). It starts the store (the
    /// copy on disk, a refresh, the server's events) for as long as it is open, whichever it shows.
    struct MailWindow: View {
        let session: AppSession
        @Environment(MailStore.self) private var store
        /// The stack showing, what each holds (the mail stack's profile among it), and search over it.
        @State private var nav = LaunchOptions.current.navigation
        /// The Feed's posts' messages, kept while the window is open.
        @State private var feed = FeedPosts()
        /// The notification groups shown expanded, kept while the window is open, so coming back from a mail finds them so.
        @State private var expandedGroups = ExpandedGroups()
        /// Where each stack's list was scrolled to, so coming back to it or from a mail finds it there.
        @State private var scrolls = ScrollPlaces()
        /// A mail row being dragged, for the rail's drop targets (`RailDrop`).
        @State private var drag = MailDragState()
        /// The search page's query and answers, kept while the window is open, so coming back from a mail finds them.
        @State private var search = LaunchOptions.current.searchModel()
        /// Rises with each ⌘K, to give the search field the focus again.
        @State private var searchFocus = 0

        typealias Stage = MailStage

        @MainActor
        static func stage(_ store: MailStore, onboarding: Bool) -> Stage {
            MailStage.showing(store, onboarding: onboarding)
        }

        var body: some View {
            let stage = Self.stage(store, onboarding: Onboarding.isNeeded(store))
            ZStack {
                switch stage {
                case .waiting:
                    Color.clear
                case .onboarding:
                    OnboardingView(session: session)
                        .transition(.blurReveal)
                case .mail:
                    mail
                        .transition(.blurReveal)
                }
            }
            .background { Wallpaper().ignoresSafeArea() }
            .animation(Motion.move, value: stage)
            .environment(\.senderPictures, store.senderPictures)
            .task { await store.start() }
        }

        /// The rail, the tabs and the card.
        private var mail: some View {
            GeometryReader { geometry in
                let layout = MailLayout(size: geometry.size, wide: nav.wide)
                HStack(alignment: .top, spacing: MailLayout.gap) {
                    Rail(
                        place: nav.place, mark: nav.profileMark, inboxes: store.lists.inboxes, counts: store.counts,
                        room: layout.railRoom, window: geometry.size,
                        chooseProfile: { id in withAnimation(Motion.move) { nav.choose(profile: id) } }
                    ) { target in
                        withAnimation(Motion.move) { nav.press(target) }
                        if target == .search { searchFocus += 1 }
                    }
                    .padding(.leading, layout.railInset)
                    .frame(width: layout.side, alignment: .leading)
                    // Above the card, so the rail's tooltips aren't covered, nor the rail open over the card's edge in a
                    // narrow window.
                    .zIndex(2)
                    VStack(spacing: MailLayout.gap) {
                        bar(namesSettingsTabs: SettingsTab.showsNames(cardWidth: layout.center))
                            .zIndex(1)
                        Card { content }
                            .overlay(alignment: .bottom) {
                                UndoStrip().padding(.bottom, 20)
                            }
                    }
                    .frame(width: layout.center)
                    Color.clear.frame(width: layout.side)
                }
                .padding(.top, layout.top)
                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
                // Settings' preview of the background takes the window's shape.
                .environment(\.windowSize, geometry.size)
                .overlay(alignment: .bottomTrailing) {
                    // In the right column, where there is room for it.
                    if layout.side >= 120 {
                        ActivityNote(window: geometry.size)
                            .frame(maxWidth: layout.side - 24, alignment: .trailing)
                            .padding(20)
                    }
                }
            }
            .ignoresSafeArea()
            .environment(drag)
            .background {
                // ⌘K: search, its field ready.
                Button("") { openSearch() }
                    .keyboardShortcut("k", modifiers: .command)
                    .buttonStyle(.plain)
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            // Another tab or profile in the mail stack starts its list at the top, as before; the other lists stay where
            // they were left (`ScrollPlaces`).
            .onChange(of: nav.mailPlace) { old, _ in scrolls.forget(scrollKey(old, profile: nav.profile)) }
            .onChange(of: nav.profile) { old, _ in scrolls.forget(scrollKey(nav.mailPlace, profile: old)) }
            .onChange(of: nav.reading) { _, id in
                if id == nil { Task { await store.open(threadID: nil) } }
            }
        }

        /// The row above the card (`WindowBar`).
        private func bar(namesSettingsTabs: Bool) -> some View {
            WindowBar(
                nav: $nav, screeningCount: screeningCount, namesSettingsTabs: namesSettingsTabs, back: back,
                act: { action, threadID in act(action, on: threadID) })
        }

        /// Reads a thread in the card.
        private func read(_ threadID: String) {
            withAnimation(Motion.move) { nav.open(threadID) }
        }

        /// Search's second Esc, once its field is clear: the stack as it was.
        private func leaveSearch() {
            withAnimation(Motion.move) { nav.leaveSearch() }
        }

        /// ⌘K: search over the stack, its field given the focus; from a mail read from the results, back to them.
        private func openSearch() {
            withAnimation(Motion.move) { nav.openSearch() }
            searchFocus += 1
        }

        /// Search's offer when asking needs the AI set up: the Settings stack on its AI tab. ⌘K finds search again.
        private func openAISettings() {
            withAnimation(Motion.move) { nav.openSettings(.ai) }
        }

        /// The mail page's back and Esc: back to the list; search's capsule, and its second Esc: the stack as it was.
        private func back() {
            withAnimation(Motion.move) { nav.back() }
        }

        /// Does what the person chose to the open mail. The card goes back to the list it was opened from (Home, Feed,
        /// Receipts, Notifications, the classic inbox, To reply, Pinned, Snoozed), where the undo strip says what
        /// happened.
        private func act(_ action: ActionInput, on threadID: String) {
            back()
            Task { await store.perform(action, on: [threadID]) }
        }

        /// The server's count when the Mac has one, else what the copy holds, in the mail stack's profile.
        private var screeningCount: Int {
            store.counts?.counts(for: nav.profile)?.screened ?? store.lists.screening(inbox: nav.profile).count
        }

        /// A list's kept place: on the mail stack, in the profile it shows.
        private func scrollKey(_ place: Place, profile: String?) -> ScrollPlaces.Key {
            ScrollPlaces.Key(place: place, inbox: place.destination == .mail ? profile : nil)
        }

        /// The list on show's kept place, for its scroll view (`keepsScroll`).
        private var kept: KeptScroll {
            scrolls.kept(scrollKey(nav.place, profile: nav.profile))
        }

        /// The card's content (`Pages`).
        private var content: some View {
            Pages(
                session: session, nav: nav, feed: feed, expandedGroups: $expandedGroups, kept: kept, search: search,
                searchFocus: searchFocus, read: read, leaveSearch: leaveSearch, openAISettings: openAISettings)
        }
    }
#endif
