import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The server's password in Settings and on the pairing card (docs/contract.md, "The owner's password").
@MainActor
struct ServerPasswordTests {
    @Test func theRowSaysWhetherAPasswordIsSet() {
        #expect(ServerPasswordWords.state(Owner(password: false)).hasPrefix("No password yet."))
        #expect(ServerPasswordWords.state(Owner(password: true)) == "Password set.")
        let set = ServerPasswordWords.state(
            Owner(password: true, passwordSetAt: Date(timeIntervalSince1970: 1_795_000_000)))
        #expect(set.hasPrefix("Password set ") && set.hasSuffix("."))
    }

    @Test func twoFieldsThatDifferOrAreTooShortAreRefusedBeforeTheServerIsAsked() {
        #expect(ServerPasswordWords.refusal(password: "correct horse battery", again: "correct horse") != nil)
        #expect(ServerPasswordWords.refusal(password: "short", again: "short")?.contains("12 characters") == true)
        #expect(ServerPasswordWords.refusal(password: "correct horse battery", again: "correct horse battery") == nil)
    }

    @Test func thePairingCardSaysWhereEachSecretComesFrom() {
        #expect(ServerStep.passwordHelp.contains("Forgot your password?"))
        #expect(ServerStep.claimHelp.hasPrefix("Nobody owns this server yet."))
        #expect(ServerStep.help.contains("A code works once."))
    }
}
