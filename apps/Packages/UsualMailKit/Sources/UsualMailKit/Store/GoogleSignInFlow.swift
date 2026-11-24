import Foundation

/// Connecting Gmail the way other mail apps do: the person signs in with Google in their browser and allows Usual
/// Mail, and their server receives Google's answer and keeps the token (core/src/google.ts). The app asks the server
/// whether it can, starts a sign-in, opens Google's page and asks how it ended, about once a second, until it has. The same flow reconnects
/// a Gmail inbox in place, which a server whose Google client is in Testing needs each week.
@MainActor
@Observable
public final class GoogleSignInFlow {
    public enum Step: Hashable, Sendable {
        /// Asking the server whether it can.
        case checking
        /// It can't yet: what whoever runs it has to set up, or that it couldn't be asked.
        case unavailable(String)
        /// It has no Google client yet: the guided set-up (`GoogleClientSetup`) shows instead of the button.
        case needsClient
        /// It can: Google's sign-in is one click away.
        case ready
        /// Starting the sign-in.
        case starting
        /// Google's page is open in the browser; waiting for the person to finish there.
        case waiting
        /// The inbox connected, or reconnected in place.
        case connected(inboxId: String?, reconnected: Bool)
        /// It didn't work, in words a person can act on. Starting again is allowed.
        case failed(String)
    }

    public private(set) var step: Step = .checking
    /// Notes under the button once this device gave the server its Google client: that it has it, and the server's
    /// hint about the file's redirect addresses when it sent one.
    public private(set) var notes: [String] = []
    /// The Gmail inbox being reconnected, or nil to connect a new one.
    public let inboxId: String?

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let open: @MainActor (URL) -> Void
    @ObservationIgnored private let connected: @MainActor () async -> Void
    @ObservationIgnored private let pause: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let clock: @Sendable () -> Date

    /// How often to ask how the sign-in stands while the person is at Google.
    static let interval: Duration = .seconds(1)
    /// How long past a sign-in's end to keep asking, so the server's own `expired` answer comes back rather than a
    /// guess.
    static let grace: TimeInterval = 15

    /// `open` shows Google's page in the browser; `connected` runs once an inbox connected, to fetch it.
    public init(
        client: APIClient, reconnecting inboxId: String? = nil, open: @escaping @MainActor (URL) -> Void,
        connected: @escaping @MainActor () async -> Void,
        pause: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.inboxId = inboxId
        self.open = open
        self.connected = connected
        self.pause = pause
        self.clock = clock
    }

    /// Asks the server whether it can connect Gmail by signing in with Google (`GET /v1/info`).
    public func check() async {
        step = .checking
        do {
            let info = try await client.info()
            step = Self.readiness(info.googleSignIn)
        } catch {
            step = .unavailable("Your server couldn't be asked. \(Self.words(error))")
        }
    }

    /// Starts a sign-in, opens Google's page and follows it until it ends, it expires, or the calling task is
    /// cancelled (the server lets an unfinished sign-in expire on its own). For a new inbox, `name`, `color` and
    /// `icon` are its own; the server picks them otherwise.
    public func start(name: String? = nil, color: String? = nil, icon: InboxIcon? = nil) async {
        step = .starting
        let input =
            inboxId.map { GoogleSignInInput(inboxId: $0) }
            ?? GoogleSignInInput(name: name, color: color, icon: icon)
        let started: GoogleSignInStart
        do {
            started = try await client.startGoogleSignIn(input)
        } catch {
            step = .failed("The sign-in couldn't start. \(Self.words(error))")
            return
        }
        // Only a web page is opened (Google's, or a stand-in's on a test server): never another kind of address,
        // whatever a server says.
        guard let url = URL(string: started.url), let scheme = url.scheme?.lowercased(),
            Self.webSchemes.contains(scheme)
        else {
            step = .failed("Your server answered with an address that isn't a web page, so nothing was opened.")
            return
        }
        open(url)
        step = .waiting
        await follow(started)
    }

    /// Back to the button after a failure, or to stop waiting.
    public func reset() {
        step = .ready
    }

    /// The server has a Google client now, given from this device or from elsewhere: the step follows what it says
    /// (the button, once it can sign in; nothing is opened until the person presses it), with a note that it has the
    /// client and, for a file this device gave, the server's hint, if any.
    public func clientSettled(_ settled: GoogleClientSetup.Settled) {
        step = Self.readiness(settled.googleSignIn)
        var notes = [Onboarding.GoogleClient.saved]
        if case .saved(let saved) = settled, let hint = saved.redirectHint.flatMap(Self.nonEmpty) { notes.append(hint) }
        self.notes = notes
    }

    /// Asks the server again whether it can, quietly, for a screen coming back to the front: only while there is
    /// nothing to sign in with yet (the set-up, or words on what is missing), and the step changes only when the answer
    /// does. What it had stays when the server can't be asked.
    public func recheck() async {
        switch step {
        case .needsClient, .unavailable: break
        default: return
        }
        guard let info = try? await client.info() else { return }
        switch step {
        case .needsClient, .unavailable: break
        default: return
        }
        let now = Self.readiness(info.googleSignIn)
        if now != step { step = now }
    }

    private func follow(_ started: GoogleSignInStart) async {
        let giveUp = started.expiresAt.addingTimeInterval(Self.grace)
        while !Task.isCancelled {
            do {
                try await pause(Self.interval)
            } catch {
                return
            }
            let signIn: GoogleSignIn
            do {
                signIn = try await client.googleSignIn(id: started.id)
            } catch let error as APIError where error.code == .notFound {
                step = .failed("The sign-in ended before it finished. Start again.")
                return
            } catch {
                // Offline for a moment: keep asking until the sign-in would have expired.
                if clock() > giveUp {
                    step = .failed("Your server couldn't be asked how the sign-in went. \(Self.words(error))")
                    return
                }
                continue
            }
            switch signIn.state {
            case .waiting:
                if clock() > giveUp {
                    step = .failed(Self.failureWords(.expired))
                    return
                }
            case .connected:
                await connected()
                step = .connected(inboxId: signIn.inboxId, reconnected: signIn.reconnected ?? (inboxId != nil))
                return
            case .failed:
                step = .failed(signIn.message.flatMap(Self.nonEmpty) ?? Self.failureWords(signIn.failure))
                return
            case .unknown:
                step = .failed(signIn.message.flatMap(Self.nonEmpty) ?? Self.failureWords(nil))
                return
            }
        }
    }

    // MARK: Words

    /// Ready; the guided set-up while the server has no Google client (it says itself when its address is missing
    /// too); or what whoever runs the server has to set up first.
    nonisolated static func readiness(_ info: GoogleSignInInfo?) -> Step {
        guard let info else {
            return .unavailable(
                "Your server is older than signing in with Google. Once whoever runs it updates it, you can sign in "
                    + "here.")
        }
        if info.available { return .ready }
        let missing = info.missing ?? []
        if missing.contains(.client) { return .needsClient }
        var words: [String] = []
        if missing.contains(.address) {
            words.append(
                "Your server doesn't know its own address yet, which Google sends you back to. Whoever runs it "
                    + "sets it.")
        }
        if words.isEmpty {
            words.append("Your server can't connect Gmail by signing in with Google yet.")
        }
        return .unavailable(words.joined(separator: " "))
    }

    /// Why a sign-in failed, when the server gave no words of its own.
    nonisolated static func failureWords(_ failure: GoogleSignInFailure?) -> String {
        switch failure {
        case .declined: "You didn't allow Usual Mail at Google, so nothing was connected."
        case .scopeMissing: "Gmail access was left unticked at Google. Start again and allow it."
        case .noRefreshToken: "Google didn't give lasting access. Start again."
        case .expired: "The sign-in wasn't finished in time. Start again."
        case .wrongAccount: "That was another Google account than this inbox's. Start again and choose its account."
        case .cancelled: "The sign-in was cancelled."
        case .googleError: "Google didn't answer as expected. Try again in a moment."
        case .mailboxError: "Gmail didn't accept the new access. Try again in a moment."
        case .unknown, nil: "The sign-in didn't work. Start again."
        }
    }

    /// The addresses the flow opens: web pages only.
    nonisolated static let webSchemes: Set<String> = ["http", "https"]

    private nonisolated static func words(_ error: any Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }

    private nonisolated static func nonEmpty(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
