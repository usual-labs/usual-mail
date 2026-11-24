import Testing
import UsualMailKit

@testable import UsualMailUI

/// What fills the paired window: the first run while it is needed, else the mail.
@MainActor
struct MailWindowStageTests {
    @Test func theFirstRunCoversTheWholeWindowWhileItIsNeeded() async throws {
        let store = try await MailStore.sample()
        #expect(MailWindow.stage(store, onboarding: true) == .onboarding)
        #expect(MailWindow.stage(store, onboarding: false) == .mail)
    }
}
