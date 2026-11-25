#if os(iOS)
    import SwiftUI
    import UsualMailKit

    /// The paired iPhone, as the owner's concept of 2026-11-20 lays it out: over the wallpaper, a top row (search, the
    /// switcher, settings: the Mac's rail, `PhoneTopBar`), then the card as wide as the screen and running to its foot,
    /// and at the card's foot the Mac's row of tabs and mail buttons (`WindowBar`, compact). Everything else is the
    /// Mac's: the same stacks (`Navigation`), the same pages in the card (`Pages`), the same store. While the first run
    /// isn't done it shows the first run's steps instead, as the Mac's window does (`MailStage`).
    struct PhoneWindow: View {
        let session: AppSession
        @Environment(MailStore.self) private var store
        @Environment(\.scenePhase) private var scenePhase
        /// The stack showing, what each holds (the mail stack's profile among it), and search over it.
        @State private var nav = LaunchOptions.current.navigation
        /// The Feed's posts' messages, kept while the window is open.
        @State private var feed = FeedPosts()
        /// The notification groups shown expanded, kept while the window is open.
        @State private var expandedGroups = ExpandedGroups()
        /// Where each stack's list was scrolled to, so coming back to it or from a mail finds it there.
        @State private var scrolls = ScrollPlaces()
        /// The search page's query and answers, kept while the window is open.
        @State private var search = LaunchOptions.current.searchModel()
        /// Rises with each press of search, to give its field the focus again.
        @State private var searchFocus = 0
        /// Whether the app has been in front before: coming back to the front asks the server again.
        @State private var wasActive = false

        var body: some View {
            let stage = MailStage.showing(store, onboarding: Onboarding.isNeeded(store))
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
            // iOS stops the app's connection while it is in the background, and no event that came meanwhile is sent
            // again: back in front, the lists are asked for afresh.
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                if wasActive { Task { await store.refresh() } }
                wasActive = true
            }
        }

        /// The top row, the card and the row at its foot.
        private var mail: some View {
            GeometryReader { geometry in
                // The wallpaper fills the screen, under the status bar and the home indicator too.
                let insets = geometry.safeAreaInsets
                let screen = CGSize(
                    width: geometry.size.width + insets.leading + insets.trailing,
                    height: geometry.size.height + insets.top + insets.bottom)
                VStack(spacing: PhoneLayout.gap) {
                    PhoneTopBar(
                        nav: nav, inboxes: store.lists.inboxes, counts: store.counts,
                        chooseProfile: { id in withAnimation(Motion.move) { nav.choose(profile: id) } }
                    ) { target in
                        withAnimation(Motion.move) { nav.press(target) }
                        if target == .search { searchFocus += 1 }
                    }
                    .padding(.horizontal, PhoneLayout.topMargin)
                    PhoneCard {
                        Pages(
                            session: session, nav: nav, feed: feed, expandedGroups: $expandedGroups, kept: kept,
                            search: search, searchFocus: searchFocus, read: read, leaveSearch: leaveSearch,
                            openAISettings: openAISettings, fixSync: fixSync,
                            accountsSignInStarted: { nav.accountsSignInStarted() })
                    }
                }
                // At the card's foot, over it: the lists scroll under the row and end above it.
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 8) {
                        UndoStrip()
                        WindowBar(
                            nav: $nav, screeningCount: screeningCount, namesSettingsTabs: false, compact: true,
                            back: back, act: { action, threadID in act(action, on: threadID) })
                    }
                    .padding(.horizontal, PhoneLayout.barMargin)
                }
                // Settings' preview of the background blurs against the screen, and the top row's ink takes the tone of
                // the wallpaper under it.
                .environment(\.windowSize, screen)
                .environment(\.railWindow, screen)
            }
            // Another tab or profile in the mail stack starts its list at the top; the other lists stay where they
            // were left (`ScrollPlaces`).
            .onChange(of: nav.mailPlace) { old, _ in scrolls.forget(scrollKey(old, profile: nav.profile)) }
            .onChange(of: nav.profile) { old, _ in scrolls.forget(scrollKey(nav.mailPlace, profile: old)) }
            .onChange(of: nav.reading) { _, id in
                if id == nil { Task { await store.open(threadID: nil) } }
            }
        }

        /// Reads a thread in the card.
        private func read(_ threadID: String) {
            withAnimation(Motion.move) { nav.open(threadID) }
        }

        /// Search's way out once its field is clear: the stack as it was.
        private func leaveSearch() {
            withAnimation(Motion.move) { nav.leaveSearch() }
        }

        /// Search's offer when asking needs the AI set up: the Settings stack on its AI tab.
        private func openAISettings() {
            withAnimation(Motion.move) { nav.openSettings(.ai) }
        }

        /// The sync notice's button: Settings' Accounts tab, signing a Gmail inbox in again at once.
        private func fixSync(_ action: SyncNotice.Action) {
            withAnimation(Motion.move) { nav.fixSync(action) }
        }

        /// The mail page's back: back to the list; search's capsule: the stack as it was.
        private func back() {
            withAnimation(Motion.move) { nav.back() }
        }

        /// Does what the person chose to the open mail. The card goes back to the list it was opened from, where the
        /// undo strip says what happened.
        private func act(_ action: ActionInput, on threadID: String) {
            back()
            Task { await store.perform(action, on: [threadID]) }
        }

        /// The server's count when the iPhone has one, else what the copy holds, in the mail stack's profile.
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
    }

    /// The concept's measures, read off its frame (414 points wide): the top row's controls 16 from the screen's edges
    /// and 16 above the card (24 in the concept, made "a bit less" at the owner's word of 2026-11-24); the row at the
    /// card's foot 16 from the edges too, since its controls grew to 44 points (2026-11-25; it was 20, so the tabs
    /// fitted a 393-point screen with the longest name showing; now a chosen tab is named when it fits, `BarFit`).
    enum PhoneLayout {
        static let gap: CGFloat = 16
        static let topMargin: CGFloat = 16
        static let barMargin: CGFloat = 16
    }

    /// The frosted card on the iPhone: as wide as the screen, rounded at the top, its ground running under the row at
    /// its foot, the home indicator and the keyboard to the screen's edge. The content keeps to the safe area, so a
    /// list ends above that row; what scrolls on under the row fades out within its height, so mail doesn't show
    /// through the row's glass (seen in the simulator on real mail, 2026-11-20; the system's own scroll edge effect
    /// didn't reach lists this deep under a `safeAreaBar`).
    struct PhoneCard<Content: View>: View {
        @ViewBuilder var content: Content

        /// How far under the content's foot it fades to nothing: the row's height.
        static var fade: CGFloat { 44 }

        /// The radius of its top corners: the system's inset cards' and buttons' inside it (Settings' sections), so
        /// the pane and what it holds round alike (the owner's words of 2026-11-25: "increase the content pane border
        /// radius, so it matches the other buttons and cards within the page"; it was 16).
        static var radius: CGFloat { 26 }

        var body: some View {
            let shape = UnevenRoundedRectangle(topLeadingRadius: Self.radius, topTrailingRadius: Self.radius)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .mask {
                    Color.black.overlay(alignment: .bottom) {
                        LinearGradient(
                            stops: [.init(color: .black, location: 0), .init(color: .clear, location: 0.75)],
                            startPoint: .top, endPoint: .bottom
                        )
                        .frame(height: Self.fade)
                        .offset(y: Self.fade)
                    }
                }
                .background {
                    shape.fill(Theme.card)
                        .background(.ultraThinMaterial, in: shape)
                        .ignoresSafeArea(edges: .bottom)
                }
                .mask { shape.ignoresSafeArea(edges: .bottom) }
        }
    }
#endif
