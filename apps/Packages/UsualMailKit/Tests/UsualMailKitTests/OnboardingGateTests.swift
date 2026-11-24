import Foundation
import Testing

@testable import UsualMailKit

/// When the paired window shows the first run (`Onboarding.isNeeded`), where it starts, and what this Mac keeps of it.
@MainActor
struct OnboardingGateTests {
    /// Defaults in memory, of the test's own, so no test sees another's progress or the app's.
    private final class MemoryDefaults: OnboardingDefaults {
        var values: [String: Any] = [:]
        func object(forKey defaultName: String) -> Any? { values[defaultName] }
        func set(_ value: Any?, forKey defaultName: String) { values[defaultName] = value }
    }

    private func freshProgress() -> (OnboardingProgress, MemoryDefaults) {
        let defaults = MemoryDefaults()
        return (OnboardingProgress(defaults: defaults), defaults)
    }

    /// A store with nothing on the device yet, talking to the sample server as `change` leaves it.
    private func store(
        _ change: (inout SampleData) -> Void = { _ in }, server serverChange: (SampleServer) -> Void = { _ in }
    ) throws -> MailStore {
        var data = SampleData.bundled
        change(&data)
        let server = SampleServer(data)
        serverChange(server)
        let now = data.now
        return MailStore(client: server.client(), local: try LocalStore(), clock: { now })
    }

    private static func withoutKey(_ data: inout SampleData) {
        data.ai.credentialsSet = false
        data.ai.connection = nil
        data.aiStatus.state = .notSetUp
    }

    @Test func nothingShowsUntilTheServerHasAnswered() async throws {
        let (progress, _) = freshProgress()
        let store = try store { $0.inboxes = [] }
        await store.loadFromDisk()
        #expect(store.counts == nil)
        #expect(!Onboarding.isNeeded(store, progress: progress))
        await store.refresh()
        #expect(Onboarding.isNeeded(store, progress: progress))
    }

    @Test func aServerWithoutAnInboxNeedsTheFirstRun() async throws {
        let (progress, _) = freshProgress()
        let store = try store { $0.inboxes = [] }
        await store.refresh()
        #expect(Onboarding.isNeeded(store, progress: progress))
        #expect(Onboarding.resume(store, progress: progress) == .history)
        #expect(Onboarding.step(after: .history, in: store) == .gmail)
        // Without an inbox, Gmail's Continue can't go on.
        #expect(Onboarding.step(after: .gmail, in: store) == .gmail)
    }

    @Test func aServerWithoutAKeyNeedsTheFirstRun() async throws {
        let (progress, _) = freshProgress()
        let store = try store(Self.withoutKey)
        await store.refresh()
        #expect(store.aiSettings?.credentialsSet == false)
        #expect(Onboarding.isNeeded(store, progress: progress))
        #expect(Onboarding.resume(store, progress: progress) == .aiKey)
        #expect(Onboarding.step(after: .gmail, in: store) == .aiKey)
    }

    @Test func aSecondMacPairingWithASetUpServerGoesStraightHome() async throws {
        let (progress, _) = freshProgress()
        let store = try store()
        await store.refresh()
        #expect(!store.lists.inboxes.isEmpty && store.aiSettings?.credentialsSet == true)
        #expect(!Onboarding.isNeeded(store, progress: progress))
    }

    @Test func thisMacsUnfinishedFirstRunStaysUntilGoToHome() async throws {
        let (progress, _) = freshProgress()
        let store = try store()
        await store.refresh()
        progress.save(.gmail, for: store.apiClient.server)
        #expect(Onboarding.isNeeded(store, progress: progress))
        #expect(Onboarding.resume(store, progress: progress) == .gmail)
        // With the key working, Gmail's Continue passes the key step by.
        #expect(Onboarding.step(after: .gmail, in: store) == .whileWaiting)
        // How much old mail, saved before the inbox came, is behind it now.
        progress.save(.history, for: store.apiClient.server)
        #expect(Onboarding.resume(store, progress: progress) == .gmail)
        progress.finish(for: store.apiClient.server)
        #expect(!Onboarding.isNeeded(store, progress: progress))
    }

    @Test func settingsNotHeardDoNotDecide() async throws {
        let (progress, _) = freshProgress()
        // The settings are a person's only; a refusal leaves them unknown, and the key then decides nothing.
        let store = try store(Self.withoutKey) {
            $0.failOnce("GET /v1/ai", with: .error("forbidden", "No", status: 403))
        }
        await store.refresh()
        #expect(store.counts != nil && store.aiSettings == nil)
        #expect(!Onboarding.isNeeded(store, progress: progress))
    }

    @Test func theProgressIsKeptPerServerAcrossLaunches() throws {
        let (progress, defaults) = freshProgress()
        let one = try ServerAddress(parsing: "http://mail.local:8787")
        let other = try ServerAddress(parsing: "https://mail.example.com")
        #expect(progress.step(for: one) == nil)
        progress.save(.aiKey, for: one)
        // Steps before pairing aren't kept per server.
        progress.save(.server, for: other)
        let relaunched = OnboardingProgress(defaults: defaults)
        #expect(relaunched.step(for: one) == .aiKey && relaunched.step(for: other) == nil)
        // The address isn't spelled out in the defaults.
        let stored = String(describing: defaults.values)
        #expect(!stored.contains("mail.local") && !stored.contains("mail.example.com"))
        relaunched.finish(for: one)
        #expect(OnboardingProgress(defaults: defaults).step(for: one) == nil)
    }

    @Test func choosingTheirOwnServerIsRemembered() {
        let (progress, defaults) = freshProgress()
        #expect(!progress.choseOwnServer)
        progress.chooseOwnServer()
        #expect(progress.choseOwnServer && OnboardingProgress(defaults: defaults).choseOwnServer)
    }
}
