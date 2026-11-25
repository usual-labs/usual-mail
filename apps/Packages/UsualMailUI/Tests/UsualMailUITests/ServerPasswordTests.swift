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

    @Test func thePasswordRowSaysItShort() {
        // Settings' Password row (since 2026-11-25): its state in a word or two at the row's right.
        #expect(ServerPasswordWords.short(Owner(password: false)) == "Not set")
        #expect(ServerPasswordWords.short(Owner(password: true)) == "Set")
        let at = Date(timeIntervalSince1970: 1_795_000_000)
        #expect(
            ServerPasswordWords.short(Owner(password: true, passwordSetAt: at))
                == "Set \(at.formatted(date: .abbreviated, time: .omitted))")
    }

    @Test func disconnectingNamesThisDevice() {
        // Under the Disconnect row and in its question, "this Mac" on the Mac and "this iPhone" on the iPhone.
        #expect(SettingsWords.disconnecting.hasPrefix("Your server forgets \(SettingsWords.device), and"))
        #if os(iOS)
            #expect(SettingsWords.device == "this iPhone")
        #else
            #expect(SettingsWords.device == "this Mac")
        #endif
        #expect(SettingsWords.disconnecting.hasSuffix("pair it with a new code."))
    }

    @Test func twoFieldsThatDifferOrAreTooShortAreRefusedBeforeTheServerIsAsked() {
        #expect(ServerPasswordWords.refusal(password: "correct horse battery", again: "correct horse") != nil)
        #expect(ServerPasswordWords.refusal(password: "short", again: "short")?.contains("12 characters") == true)
        #expect(ServerPasswordWords.refusal(password: "correct horse battery", again: "correct horse battery") == nil)
    }

    @Test func overPlainHTTPSettingsSaysWhyNoPasswordIsSetHere() {
        #expect(ServerPasswordWords.plainHTTP.hasPrefix("This device reaches the server over plain http"))
        #expect(ServerPasswordWords.plainHTTP.contains("over Tailscale"))
    }

    @Test func thePairingCardSaysWhereEachSecretComesFrom() {
        #expect(ServerStep.passwordHelp.contains("Forgot your password?"))
        #expect(ServerStep.claimHelp.hasPrefix("Nobody owns this server yet."))
        #expect(ServerStep.help.contains("A code works once."))
    }
}
