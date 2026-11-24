import SwiftUI
import UsualMailDesign
import UsualMailKit

/// Where Sign in with Google would be while the server has no Google client (`GoogleSignInStep`: the first run's Gmail
/// step, "Add a Gmail account", Settings' "Sign in with Google again", and search's sheet for signing in again): the
/// server's guided set-up. Two paths, the person's own browser agent with the server's prompt or the steps by hand,
/// both ending with the file Google downloads, given to the server. Only the server's words when only whoever runs it
/// can do it. It asks the server again whenever the app comes back to the front, and stops a file still on its way
/// when it goes away.
struct GoogleClientSetupView: View {
    /// Runs once the server has a client it can use, so the step and what the app knows of the server follow.
    let settled: @MainActor (GoogleClientSetup.Settled) async -> Void
    @Environment(MailStore.self) private var store
    @State private var setup: GoogleClientSetup?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch setup?.loading ?? .loading {
            case .loading:
                ProgressView().controlSize(.small)
            case .failed(let words):
                StepText(words, color: UsualColor.danger)
                QuietButton("Try again") { Task { await setup?.load() } }
            case .older:
                StepText(Onboarding.GoogleClient.older)
                GoogleSetupGuideLink()
            case .loaded:
                if let setup { GoogleClientGuide(setup: setup) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(Motion.reveal, value: setup?.loading)
        .task {
            guard setup == nil else { return }
            let setup = GoogleClientSetup(client: store.apiClient, settled: settled)
            self.setup = setup
            await setup.load()
        }
        .onAppBecomesActive {
            guard let setup else { return }
            Task {
                if case .loaded = setup.loading { await setup.refresh() } else { await setup.load() }
            }
        }
        .onDisappear { setup?.stop() }
    }
}

/// The loaded set-up, as tall as all of it wherever there is room. When it can't show whole, the file section (its
/// heading, the server's note, the drop area with "Choose file…", and any refusal or question about replacing) stays
/// in view below, and only the part above it (the lead, the path choice and the chosen path) scrolls, with its fades
/// and gutter (`GuideLayout`). In the first run's card the room is the window's height less the card's margins, title,
/// words and foot. The sheets and Settings offer no height of their own (a sheet takes its content's, Settings' page
/// scrolls), so there the room is worked out from the window's (`cap(window:)`).
struct GoogleClientGuide: View {
    let setup: GoogleClientSetup
    /// The window's size where the screens share it (the mail window's columns, and the sheets they present); zero in
    /// the first run, whose card is offered the window's height itself.
    @Environment(\.windowSize) private var window

    typealias Words = Onboarding.GoogleClient

    /// What a sheet or Settings keeps of the window's height for everything around the set-up: the sheet's margins,
    /// title, notes and Done, or Settings' top row and title.
    static let around: CGFloat = 240

    /// The most the set-up takes where nothing offers it a height: the window's height less what is around it, at least
    /// `around`; no limit without a window, where the card's room decides.
    static func cap(window: CGSize) -> CGFloat {
        window.height > 0 ? max(window.height - around, around) : .infinity
    }

    var body: some View {
        Group {
            switch setup.shown {
            case .hostOnly(let words):
                FittedScroll(cap: Self.cap(window: window)) {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(words, id: \.self) { StepText($0) }
                        GoogleSetupGuideLink()
                    }
                }
            case .guided(let paths):
                GuideLayout(cap: Self.cap(window: window)) {
                    FittedScroll(floor: 0) {
                        VStack(alignment: .leading, spacing: 12) {
                            above(paths)
                        }
                    }
                    ClientFileDrop(setup: setup)
                }
            case nil:
                EmptyView()
            }
        }
        .animation(Motion.reveal, value: setup.giving)
    }

    /// What scrolls when the set-up can't show whole: the lead, the path choice and the chosen path.
    @ViewBuilder private func above(_ paths: [GoogleClientSetup.Path]) -> some View {
        StepText(Words.lead, color: Theme.ink)
        if paths.count > 1 {
            PathChoice(paths: paths, chosen: setup.shownPath) { path in
                withAnimation(Motion.move) { setup.path = path }
            }
        }
        if case .loaded(let answer) = setup.loading {
            switch setup.shownPath {
            case .agent:
                AgentPath(prompt: answer.prompt ?? "", note: answer.promptNote)
            case .byHand:
                StepsPath(steps: answer.steps ?? [])
            case nil:
                EmptyView()
            }
        }
    }
}

/// Lays out the set-up's two parts, the scrolling part above and the file section below, in the room it is offered
/// (at most `cap`):
/// - both whole, when they fit;
/// - else the file section whole and the part above scrolling in what is left, while that keeps a useful height;
/// - else the file section compact (the drop area one row) and the part above in what is left, down to a sliver, so
///   the file section, the server's note and any message stay in view;
/// - and where even that doesn't fit, the part above keeps its sliver and the file section scrolls in what is left
///   (`ClientFileDrop`), so nothing ever runs past the room.
struct GuideLayout: Layout {
    let cap: CGFloat
    var spacing: CGFloat = 12

    /// The least the part above keeps before the file section goes compact.
    static let useful: CGFloat = 120
    /// The least the part above keeps at all.
    static let sliver: CGFloat = 48

    struct Plan: Equatable {
        /// The scrolling part's height.
        var above: CGFloat
        /// The file section's height.
        var file: CGFloat
        /// Whether the file section is shown compact.
        var compact: Bool
    }

    /// The plan for parts of these heights (`above` whole, the file section `regular` or `compact`) in `room`.
    static func plan(above: CGFloat, regular: CGFloat, compact: CGFloat, room: CGFloat, spacing: CGFloat) -> Plan {
        if above + spacing + regular <= room { return Plan(above: above, file: regular, compact: false) }
        if min(useful, above) + spacing + regular <= room {
            return Plan(above: room - spacing - regular, file: regular, compact: false)
        }
        let rest = room - spacing - compact
        if rest >= min(sliver, above) { return Plan(above: min(above, rest), file: compact, compact: true) }
        let kept = min(sliver, above)
        return Plan(above: kept, file: max(room - spacing - kept, 0), compact: true)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let plan = plan(proposal, subviews)
        let width = proposal.width ?? subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        return CGSize(width: width, height: plan.above + spacing + plan.file)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        let plan = plan(ProposedViewSize(width: bounds.width, height: proposal.height), subviews)
        subviews[0].place(
            at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: plan.above))
        subviews[1].place(
            at: CGPoint(x: bounds.minX, y: bounds.minY + plan.above + spacing),
            proposal: ProposedViewSize(width: bounds.width, height: plan.file))
    }

    private func plan(_ proposal: ProposedViewSize, _ subviews: Subviews) -> Plan {
        guard subviews.count == 2 else { return Plan(above: 0, file: 0, compact: false) }
        let width = proposal.width
        let above = subviews[0].sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        let regular = subviews[1].sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        // Offered just less than whole, the file section shows compact and says how tall that is.
        let compact = min(
            subviews[1].sizeThatFits(ProposedViewSize(width: width, height: regular - 0.5)).height, regular)
        let room = min(proposal.height ?? .infinity, cap)
        return Self.plan(above: above, regular: regular, compact: compact, room: room, spacing: spacing)
    }
}

/// The host's guide, hidden until the repository is public (`Onboarding.googleSetupGuide`).
private struct GoogleSetupGuideLink: View {
    var body: some View {
        if let guide = Onboarding.googleSetupGuide {
            WebLink(title: "Open the setup guide", destination: guide)
        }
    }
}

/// The two paths as choice rows, side by side where they fit, one above the other where they don't.
private struct PathChoice: View {
    let paths: [GoogleClientSetup.Path]
    let chosen: GoogleClientSetup.Path?
    let choose: (GoogleClientSetup.Path) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { rows }
            VStack(spacing: 6) { rows }
        }
    }

    private var rows: some View {
        ForEach(paths, id: \.self) { path in
            ChoiceRow(title: Self.title(path), selected: chosen == path) { choose(path) }
        }
    }

    static func title(_ path: GoogleClientSetup.Path) -> String {
        switch path {
        case .agent: Onboarding.GoogleClient.agentPath
        case .byHand: Onboarding.GoogleClient.byHandPath
        }
    }
}
