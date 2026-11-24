import SwiftUI
import UsualMailDesign
import UsualMailKit

/// Before the Mac is paired, over the wallpaper with the wordmark at the top left: the welcome, where Usual Mail should
/// run, then the server's address and a pairing code. A Mac signed out with a reason, or whose person already chose
/// their own server, starts at the address.
struct PairingView: View {
    let session: AppSession
    @State private var step: Onboarding.Step?

    private var progress: OnboardingProgress { .shared }

    var body: some View {
        GeometryReader { geometry in
            let margin = PairingLayout.margin(for: geometry.size)
            ZStack(alignment: .topLeading) {
                Wordmark()
                    .padding(.leading, margin.width)
                    .padding(.top, margin.height)
                    .revealOnAppear()
                Group {
                    switch shown {
                    case .welcome:
                        WelcomeStep { go(.whereToRun) }
                            .padding(.horizontal, margin.width)
                            .padding(.bottom, margin.width)
                    case .whereToRun:
                        WhereToRunStep(back: { go(.welcome) }) {
                            progress.chooseOwnServer()
                            go(.server)
                        }
                        .padding(.bottom, OnboardingLayout.cardsAtFoot ? margin.width : 0)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: OnboardingLayout.cardAlignment)
                    default:
                        ServerStep(session: session) { go(.whereToRun) }
                            .padding(.bottom, OnboardingLayout.cardsAtFoot ? margin.width : 0)
                            .frame(
                                maxWidth: .infinity, maxHeight: .infinity, alignment: OnboardingLayout.cardAlignment)
                    }
                }
                .id(shown)
                .transition(.handOver)
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
        .background { Wallpaper() }
        // On the iPhone the keyboard's room is kept, so a card at the foot rises above it; the wallpaper fills the
        // screen anyway.
        #if os(iOS)
            .ignoresSafeArea(.container)
        #else
            .ignoresSafeArea()
        #endif
    }

    private var shown: Onboarding.Step {
        step ?? (session.pairingProblem != nil || progress.choseOwnServer ? .server : .welcome)
    }

    private func go(_ next: Onboarding.Step) {
        withAnimation(Motion.move) { step = next }
    }
}

/// The welcome's margins, as usual.dev sets them: 6% of the width, between 24 and 80 points; at the top, clear of the
/// window's buttons.
enum PairingLayout {
    static func margin(for size: CGSize) -> CGSize {
        let side = min(80, max(24, size.width * 0.06))
        // On the iPhone, clear of the status bar and the Dynamic Island.
        #if os(macOS)
            return CGSize(width: side, height: max(52, side))
        #else
            return CGSize(width: side, height: max(76, side))
        #endif
    }
}

/// "Usual Mail" in the wordmark's face, the second word lighter, as usual.dev writes "Usual" and "dev".
struct Wordmark: View {
    var size: CGFloat = 40

    var body: some View {
        let usual = Text(verbatim: "Usual ").foregroundStyle(Theme.ink)
        let mail = Text(verbatim: "Mail").foregroundStyle(Theme.ink.opacity(0.45))
        Text("\(usual)\(mail)")
            .font(Theme.wordmark(size))
            .accessibilityLabel("Usual Mail")
            .accessibilityAddTraits(.isHeader)
    }
}

/// The server's address, then its owner's password (`AppSession.signIn`) or a pairing code (`AppSession.pair`), with the
/// server's problem in words. With the password, the app first asks what the server wants (`passwordStep`): an
/// unclaimed server is set up here with a new password (`claim`; the owner's decisions of 2026-11-24); one whose host
/// named the owner's email is set up in a browser; one with no password yet takes a pairing code.
struct ServerStep: View {
    let session: AppSession
    let back: () -> Void
    @State private var address = ""
    @State private var code = ""
    @State private var password = ""
    @State private var again = ""
    @State private var email = ""
    @State private var mode = Mode.password

    /// What the card asks for after the address.
    enum Mode: Equatable {
        /// The owner's password.
        case password
        /// A new password for a server nobody owns yet.
        case claim
        /// A pairing code.
        case code
    }

    /// Where a code comes from. The server prints one only when it makes one, so the help names the command and the
    /// file (the coordinator's wording of 2026-11-17, replacing the approved "prints a pairing code when it starts"),
    /// and since 2026-11-24, at the owner's yes, where the Cloudflare server keeps it, which has neither: its first
    /// code in the Worker's Data Studio, later ones on the dashboard (docs/self-hosting.md, "On Cloudflare").
    static let help =
        "Get a code with usual-mail pair on your server, or from the file owner-pairing-code in its data folder. "
        + "On Cloudflare, the first code is in the Worker's Data Studio, table owner_pairing_code; later ones come "
        + "from the dashboard's Devices and agents page. A code works once."

    /// The password's help: the same one opens the server's dashboard in a browser.
    static let passwordHelp =
        "The password you set for your server, the same one its dashboard takes in a browser. Forgot it? Open the "
        + "server's address in a browser and choose \"Forgot your password?\"."

    /// Setting up a server nobody owns yet.
    static let claimHelp =
        "Nobody owns this server yet. Set its password, and this device is its owner's: you'll sign in with it here, "
        + "in the other apps and on its dashboard. At least 12 characters."

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepTitle(mode == .claim ? "Set up your server" : "Connect to your server")
            VStack(alignment: .leading, spacing: 10) {
                // The approved placeholder named 8585; the server and its guide default to 8484.
                StepField(label: "Server address", prompt: "127.0.0.1:8484 or mail.example.com", text: $address)
                switch mode {
                case .password:
                    StepField(label: "Password", text: $password, secure: true)
                        .onSubmit(connect)
                case .claim:
                    StepField(label: "Email (optional)", text: $email)
                    StepField(label: "New password", text: $password, secure: true)
                    StepField(label: "New password again", text: $again, secure: true)
                        .onSubmit(connect)
                case .code:
                    StepField(label: "Pairing code", text: $code)
                        .onSubmit(connect)
                }
            }
            StepText(
                mode == .code ? Self.help : mode == .claim ? Self.claimHelp : Self.passwordHelp, size: 10,
                color: Theme.time)
            HStack(spacing: 4) {
                QuietButton(mode == .code ? "Use the password instead" : "Use a pairing code instead") {
                    withAnimation(Motion.move) { mode = mode == .code ? .password : .code }
                }
                if let guide = Onboarding.selfHostingGuide {
                    Text(verbatim: "·").font(Theme.sans(10)).foregroundStyle(Theme.time)
                    WebLink(title: "Set up a server", destination: guide)
                }
            }
            if let problem = session.pairingProblem {
                StepText(problem, color: UsualColor.danger)
                    .transition(.blurReveal)
            }
            HStack {
                QuietButton("Back", action: back)
                Spacer(minLength: 12)
                PrimaryButton(
                    title: mode == .claim ? "Set up" : "Connect", busy: session.isPairing, enabled: canConnect,
                    action: connect)
            }
        }
        .animation(Motion.reveal, value: session.pairingProblem)
        .animation(Motion.move, value: mode)
        .onboardingCard(width: 400)
        .revealOnAppear()
    }

    private var canConnect: Bool {
        let filled: Bool =
            switch mode {
            case .password: !password.isEmpty
            case .claim: !password.isEmpty && !again.isEmpty
            case .code: !code.trimmingCharacters(in: .whitespaces).isEmpty
            }
        return !session.isPairing && !address.trimmingCharacters(in: .whitespaces).isEmpty && filled
    }

    private func connect() {
        guard canConnect else { return }
        Task {
            switch mode {
            case .code:
                await session.pair(address: address, code: code)
            case .claim:
                await session.claim(address: address, email: email, password: password, again: again)
            case .password:
                switch await session.passwordStep(address: address) {
                case .signIn: await session.signIn(address: address, password: password)
                case .claim: withAnimation(Motion.move) { mode = .claim }
                case .codeOnly: withAnimation(Motion.move) { mode = .code }
                case .claimInBrowser, nil: break
                }
            }
        }
    }
}
