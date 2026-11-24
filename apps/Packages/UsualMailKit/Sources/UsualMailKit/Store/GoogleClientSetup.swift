import Foundation

/// Setting up the server's Google client from this device, where Sign in with Google would be while the server has
/// none: the server's guided set-up (`GET /v1/google/setup`: the browser agent's prompt, the steps by hand, and whether
/// a device may give the client), then the file Google downloads, given to the server as it is
/// (`PUT /v1/google/client`). Every refusal shows in the server's words.
///
/// The set-up is asked for again before each file is sent, after a `conflict`, and when the screen asks (the app
/// coming to the front), so a client that came from elsewhere, or a server that no longer takes one from a device, is
/// seen rather than overwritten. Once the server has a client it can use, `settled` runs.
@MainActor
@Observable
public final class GoogleClientSetup {
    public enum Loading: Hashable, Sendable {
        case loading
        /// It couldn't be had: why, with Try again.
        case failed(String)
        /// The server is older than the guided set-up.
        case older
        case loaded(GoogleSetup)
    }

    /// What the loaded set-up offers.
    public enum Shown: Hashable, Sendable {
        /// Only whoever runs the server can do it: the server's words, nothing to give.
        case hostOnly([String])
        /// The paths there are, the agent's first, and the file at their end.
        case guided(paths: [Path])
    }

    public enum Path: Hashable, Sendable, CaseIterable {
        case agent, byHand
    }

    public enum Giving: Hashable, Sendable {
        case idle
        /// Reading the file, asking the server again, or sending.
        case sending
        /// Not taken, or taken and still not usable: the server's words, or the app's when it never got there.
        case refused(String)
        /// The server already has a client file or inboxes under another client: its words, then Replace it or Cancel.
        case askingToReplace(String)
        case saved(GoogleClientSaved)
    }

    /// What the set-up hands back once the server has a Google client it can use.
    public enum Settled: Hashable, Sendable {
        /// This device gave it.
        case saved(GoogleClientSaved)
        /// It came from elsewhere meanwhile (the command, another device): sign-in as the server says it now.
        case alreadyThere(GoogleSignInInfo)

        public var googleSignIn: GoogleSignInInfo {
            switch self {
            case .saved(let saved): saved.googleSignIn
            case .alreadyThere(let info): info
            }
        }
    }

    public private(set) var loading: Loading = .loading
    /// The path the person chose; the agent's at first.
    public var path: Path = .agent
    public private(set) var giving: Giving = .idle

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let settled: @MainActor (Settled) async -> Void
    /// The file the server asked about replacing with, sent again only on Replace it; dropped on Cancel.
    @ObservationIgnored private(set) var heldForReplacing: Data?
    /// The file being read or sent, which `stop()` cancels.
    @ObservationIgnored private var work: Task<Void, Never>?

    public init(client: APIClient, settled: @escaping @MainActor (Settled) async -> Void) {
        self.client = client
        self.settled = settled
    }

    /// Asks the server for its set-up, showing that it asks.
    public func load() async {
        loading = .loading
        do {
            try await take(client.googleSetup())
        } catch let error as APIError where error.code == .notFound {
            loading = .older
        } catch {
            loading = .failed("\(Onboarding.GoogleClient.notLoaded) \(Self.words(error))")
        }
    }

    /// Asks the server again without showing it, for the screen coming back to the front: what it had stays when the
    /// server can't be asked. Nothing while a file is on its way.
    public func refresh() async {
        guard !isBusy else { return }
        guard case .answered = await reload() else { return }
        if !mayGive { forgetGiving() }
    }

    /// What the loaded set-up offers; nil until it is loaded.
    public var shown: Shown? {
        guard case .loaded(let setup) = loading else { return nil }
        return Self.shown(setup)
    }

    /// What the server says to know before giving a client (`GoogleClientState.note`), while one may be given.
    public var note: String? {
        guard case .loaded(let setup) = loading, case .guided = shown else { return nil }
        return Self.given(setup.client.note)
    }

    /// The path showing: the chosen one, or the only one there is.
    public var shownPath: Path? {
        guard case .guided(let paths) = shown else { return nil }
        return paths.contains(path) ? path : paths.first
    }

    /// True while a file is being read, checked against the server or sent: another one waits.
    public var isBusy: Bool { giving == .sending }

    /// Only whoever runs the server can give it a client while it doesn't know its own address or a device may not
    /// give one; otherwise the paths the server sent words for.
    public nonisolated static func shown(_ setup: GoogleSetup) -> Shown {
        let hostWords = [setup.noAddress, setup.client.reason].compactMap(given)
        if setup.noAddress != nil || !setup.client.changeable {
            return .hostOnly(hostWords.isEmpty ? [Onboarding.GoogleClient.empty] : hostWords)
        }
        var paths: [Path] = []
        if given(setup.prompt) != nil { paths.append(.agent) }
        if !(setup.steps ?? []).isEmpty { paths.append(.byHand) }
        return paths.isEmpty ? .hostOnly([Onboarding.GoogleClient.empty]) : .guided(paths: paths)
    }

    /// Gives the server the file at `url` (chosen), read off the main actor. Nothing while another is on its way.
    public func give(fileAt url: URL) async {
        await run {
            let read = await Task.detached { GoogleClientFile.read(at: url) }.value
            guard !Task.isCancelled else { return }
            await self.accept(read)
        }
    }

    /// Gives the server a file that was read (dropped): refused in the app's words when too large or unreadable,
    /// otherwise sent as it is. Nothing while another is on its way.
    public func give(_ read: GoogleClientFile.Read) async {
        await run { await self.accept(read) }
    }

    /// Replace it: the same file again, now replacing what the server has.
    public func replace() async {
        guard case .askingToReplace = giving, let file = heldForReplacing else { return }
        await run { await self.send(file, replacing: true) }
    }

    /// Cancel: the server keeps what it has, and the file is forgotten.
    public func cancelReplacing() {
        heldForReplacing = nil
        if case .askingToReplace = giving { giving = .idle }
    }

    /// Stops a file still being read or sent, for a screen that goes away.
    public func stop() {
        work?.cancel()
    }

    private var mayGive: Bool {
        if case .guided = shown { true } else { false }
    }

    /// Runs one file's giving as the one piece of work `stop()` cancels; nothing while another runs, or while there is
    /// nothing a device may give.
    private func run(_ body: @escaping @MainActor () async -> Void) async {
        guard mayGive, !isBusy else { return }
        heldForReplacing = nil
        giving = .sending
        let task = Task { await body() }
        work = task
        await task.value
        work = nil
        if Task.isCancelled || task.isCancelled, giving == .sending { giving = .idle }
    }

    private func accept(_ read: GoogleClientFile.Read) async {
        switch read {
        case .tooLarge: giving = .refused(Onboarding.GoogleClient.tooLarge)
        case .unreadable: giving = .refused(Onboarding.GoogleClient.unreadable)
        case .file(let data): await send(data, replacing: false)
        }
    }

    private func send(_ file: Data, replacing: Bool) async {
        if !replacing {
            // The server as it is now: a client that came from elsewhere is used, not overwritten; one that can't be
            // given any more shows the server's words instead.
            if case .settled = await reload() { return forgetGiving() }
            guard !Task.isCancelled else { return }
            guard mayGive else { return forgetGiving() }
        }
        do {
            let answer = try await client.setGoogleClient(file: file, replace: replacing)
            if Self.lacksClient(answer.googleSignIn) {
                // Kept, but not usable: the server's note says why, once asked again.
                _ = await reload()
                giving = .refused(Onboarding.GoogleClient.keptUnused)
                return
            }
            giving = .saved(answer)
            await settled(.saved(answer))
        } catch is CancellationError {
            giving = .idle
        } catch let error as APIError where error.code == .conflict && !replacing {
            await conflicted(error, file: file)
        } catch let error as APIError where error.isOffline {
            giving = .refused("\(Onboarding.GoogleClient.notSent) \(Self.words(error))")
        } catch {
            giving = .refused(Self.words(error))
        }
    }

    /// A first `conflict`: the server is asked again, and Replace it is offered only while a device may still give a
    /// client (the host may have set one in the environment or restarted in demo mode meanwhile).
    private func conflicted(_ error: APIError, file: Data) async {
        switch await reload() {
        case .settled:
            forgetGiving()
        case .unanswered:
            giving = .refused(Self.words(error))
        case .answered:
            if mayGive {
                heldForReplacing = file
                giving = .askingToReplace(Self.words(error))
            } else {
                forgetGiving()
            }
        }
    }

    private enum Reloaded {
        case unanswered, answered, settled
    }

    /// Asks the set-up again, quietly; hands back a client the server now has.
    private func reload() async -> Reloaded {
        guard let fresh = try? await client.googleSetup() else { return .unanswered }
        return await take(fresh) ? .settled : .answered
    }

    /// Keeps a set-up the server sent; true when it says the server has a client now, which is handed back.
    @discardableResult
    private func take(_ fresh: GoogleSetup) async -> Bool {
        loading = .loaded(fresh)
        guard !Self.lacksClient(fresh.googleSignIn) else { return false }
        await settled(.alreadyThere(fresh.googleSignIn))
        return true
    }

    private func forgetGiving() {
        heldForReplacing = nil
        giving = .idle
    }

    /// Whether Google sign-in still waits for a client.
    nonisolated static func lacksClient(_ info: GoogleSignInInfo) -> Bool {
        !info.available && (info.missing ?? []).contains(.client)
    }

    /// The server's own words for a refusal, written for a person; for a device the server no longer knows, and when
    /// the server never answered, the app's.
    nonisolated static func words(_ error: any Error) -> String {
        if let api = error as? APIError, case .server(let code, let message, _, _) = api, code != .unauthorized,
            let message = given(message)
        {
            return message
        }
        return (error as? APIError)?.errorDescription ?? error.localizedDescription
    }

    private nonisolated static func given(_ words: String?) -> String? {
        guard let words = words?.trimmingCharacters(in: .whitespacesAndNewlines), !words.isEmpty else { return nil }
        return words
    }
}

extension MailStore {
    /// Once the server has its Google client: what the app knows of the server (`serverInfo`) says so at once.
    public func googleSignInChanged(_ info: GoogleSignInInfo) {
        serverInfo?.googleSignIn = info
    }
}
