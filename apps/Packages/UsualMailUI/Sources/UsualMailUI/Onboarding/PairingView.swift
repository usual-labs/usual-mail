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
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    default:
                        ServerStep(session: session) { go(.whereToRun) }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .id(shown)
                .transition(.handOver)
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
        .background { Wallpaper() }
        .ignoresSafeArea()
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

/// The server's address and a pairing code (`AppSession.pair`), with the server's problem in the approved words.
struct ServerStep: View {
    let session: AppSession
    let back: () -> Void
    @State private var address = ""
    @State private var code = ""

    /// Where a code comes from. The server prints one only when it makes one, so the help names the command and the
    /// file (the coordinator's wording of 2026-11-17, replacing the approved "prints a pairing code when it starts").
    static let help =
        "Get a code with usual-mail pair on your server, or from the file owner-pairing-code in its data folder. A "
        + "code works once."

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepTitle("Connect to your server")
            VStack(alignment: .leading, spacing: 10) {
                // The approved placeholder named 8585; the server and its guide default to 8484.
                StepField(label: "Server address", prompt: "127.0.0.1:8484 or mail.example.com", text: $address)
                StepField(label: "Pairing code", text: $code)
                    .onSubmit(pair)
            }
            StepText(Self.help, size: 10, color: Theme.time)
            if let guide = Onboarding.selfHostingGuide {
                HStack(spacing: 4) {
                    Text("Don't have a server yet?").font(Theme.sans(10)).foregroundStyle(Theme.time)
                    WebLink(title: "Set one up", destination: guide)
                }
            }
            if let problem = session.pairingProblem {
                StepText(problem, color: UsualColor.danger)
                    .transition(.blurReveal)
            }
            HStack {
                QuietButton("Back", action: back)
                Spacer(minLength: 12)
                PrimaryButton(title: "Connect", busy: session.isPairing, enabled: canPair, action: pair)
            }
        }
        .animation(Motion.reveal, value: session.pairingProblem)
        .onboardingCard(width: 400)
        .revealOnAppear()
    }

    private var canPair: Bool {
        !session.isPairing && !address.trimmingCharacters(in: .whitespaces).isEmpty
            && !code.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func pair() {
        guard canPair else { return }
        Task { await session.pair(address: address, code: code) }
    }
}
