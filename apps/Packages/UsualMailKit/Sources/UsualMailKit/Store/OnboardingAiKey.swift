import Foundation
import Observation

/// The first run's AI key step. It asks the server what leaves it and to whom (core's words, `aiDisclosure`) before a
/// key can be saved, since saving one is the person's yes for every inbox's mail; it saves a Vercel AI Gateway key
/// through the store, which the server tests before it answers; then it reads the status and says how the test went.
///
/// The key is used for that one request only: this type never keeps it, and nothing here writes it anywhere. The
/// store keeps it out of any words it shows (`updateAiSettings`).
@MainActor
@Observable
public final class OnboardingAiKey {
    /// The words on what leaves the server.
    public enum Disclosure: Hashable, Sendable {
        case loading
        case loaded(AiDisclosure)
        /// They couldn't be had, in words, so no key may be saved yet.
        case failed(String)
    }

    /// Where saving or testing the key stands.
    public enum Check: Hashable, Sendable {
        case idle
        /// Saving it, or testing it again; the server answers once its test has run.
        case busy
        case done(Onboarding.KeyCheck)
    }

    /// The one service the first run offers.
    public static let connection = AiConnection.gateway(.vercel)

    public private(set) var disclosure = Disclosure.loading
    public private(set) var check = Check.idle

    @ObservationIgnored private let store: MailStore

    public init(store: MailStore) {
        self.store = store
        // A key saved earlier that the service refused (the person quit before fixing it) says why at once.
        if store.aiSettings?.credentialsSet == true, let status = store.aiStatus,
            case .problem = Onboarding.keyCheck(status)
        {
            check = .done(Onboarding.keyCheck(status))
        }
    }

    /// A key may be saved once the words are on screen, and not while one is being saved.
    public var canSave: Bool {
        guard case .loaded = disclosure else { return false }
        return check != .busy
    }

    /// The server already holds a key the test refused: it can be tested again without typing it, once the person
    /// fixed their account.
    public var canTestAgain: Bool {
        guard store.aiSettings?.credentialsSet == true, check != .busy else { return false }
        if case .done(.problem) = check { return true }
        return false
    }

    /// Asks the server for the words to show before a key for Vercel's AI Gateway is saved.
    public func loadDisclosure() async {
        disclosure = .loading
        do {
            let words = try await store.apiClient.aiDisclosure(for: Self.connection)
            guard Self.says(words.destination), Self.says(words.terms) else {
                disclosure = .failed("Your server sent no words on what the AI would be sent.")
                return
            }
            disclosure = .loaded(words)
        } catch is CancellationError {
            return
        } catch {
            disclosure = .failed(
                "Your server couldn't say what the AI would be sent, so the key can't be saved yet. "
                    + Self.words(error))
        }
    }

    /// Saves `key` as the server's AI key and says how the server's test of it went. Only once the words are shown.
    public func save(key: String) async {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSave, !key.isEmpty else { return }
        check = .busy
        let shown = store.problem?.id
        let patch = AiSettingsPatch(credentials: .set(AiCredentials(Self.connection, apiKey: key)))
        guard await store.updateAiSettings(patch) else {
            check = .done(.problem(refusal(since: shown, otherwise: "The key couldn't be saved. Try again.")))
            return
        }
        // The server answered after its test, so the status read now says how it went.
        do {
            let status = try await store.apiClient.aiStatus()
            await store.keep(aiStatus: status)
            check = .done(Onboarding.keyCheck(status))
        } catch {
            check = .done(
                .problem("The key was saved, but your server couldn't say whether it works. \(Self.words(error))"))
        }
    }

    /// Tests the key the server holds again, after the person fixed their Vercel account.
    public func testAgain() async {
        guard canTestAgain else { return }
        check = .busy
        let shown = store.problem?.id
        if let status = await store.testAi() {
            check = .done(Onboarding.keyCheck(status))
        } else {
            check = .done(.problem(refusal(since: shown, otherwise: "The key couldn't be tested. Try again.")))
        }
    }

    /// The store's words for a refusal it reported since `shown`, taken from it, since this step shows them.
    private func refusal(since shown: UUID?, otherwise: String) -> String {
        guard let problem = store.problem, problem.id != shown else { return otherwise }
        store.dismissProblem()
        return problem.message
    }

    private static func says(_ words: String) -> Bool {
        !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func words(_ error: any Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}

extension MailStore {
    /// Keeps a status read straight after saving a key, unless the copy holds a newer one.
    func keep(aiStatus status: AiStatus) async {
        await write(RefreshKeep()) { try $0.save(aiStatus: status) }
        await reloadLists()
    }
}
