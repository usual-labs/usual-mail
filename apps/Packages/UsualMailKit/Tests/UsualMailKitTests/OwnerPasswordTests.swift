import Foundation
import Testing

@testable import UsualMailKit

/// Connecting with the owner's password (docs/contract.md, "The owner's password"): what the server's info asks for,
/// signing in, claiming an unclaimed server, and the words for each refusal.
@MainActor
struct OwnerPasswordTests {
    private func session(_ server: SampleServer, credentials: MemoryCredentialStore = MemoryCredentialStore())
        -> AppSession
    {
        AppSession(
            credentials: credentials, transport: server, databaseDirectory: nil, deviceName: "Test Mac",
            listens: false, clock: { SampleData.bundled.now })
    }

    @Test func theServersInfoSaysWhatAPasswordNeeds() {
        #expect(AppSession.passwordStep(OwnerInfo(password: true, claimable: false)) == .signIn)
        #expect(AppSession.passwordStep(OwnerInfo(password: false, claimable: true, claim: .password)) == .claim)
        #expect(AppSession.passwordStep(OwnerInfo(password: false, claimable: true, claim: .google)) == .claimInBrowser)
        #expect(AppSession.passwordStep(OwnerInfo(password: false, claimable: false)) == .codeOnly)
        // An older server says nothing of an owner: no password, so a pairing code.
        #expect(AppSession.passwordStep(.none) == .codeOnly)
    }

    @Test func thePasswordSignsThisDeviceIn() async throws {
        let server = SampleServer()
        server.owner(password: "correct horse battery", info: OwnerInfo(password: true, claimable: false))
        let credentials = MemoryCredentialStore()
        let session = session(server, credentials: credentials)

        #expect(await session.passwordStep(address: "127.0.0.1:8787") == .signIn)
        await session.signIn(address: "127.0.0.1:8787", password: "not the password")
        #expect(session.pairingProblem?.hasPrefix("That password is wrong.") == true)
        #expect(session.store == nil)

        await session.signIn(address: "127.0.0.1:8787", password: "correct horse battery")
        #expect(session.pairingProblem == nil)
        #expect(try credentials.load()?.token == "tok_secret")
        #expect(session.store != nil)
        #expect(server.requests.last?.jsonBody == json(#"{"name":"Test Mac","password":"correct horse battery"}"#))
    }

    @Test func anUnclaimedServerIsSetUpWithANewPassword() async throws {
        let server = SampleServer()
        server.owner(password: nil, info: OwnerInfo(password: false, claimable: true, claim: .password))
        let session = session(server)

        #expect(await session.passwordStep(address: "127.0.0.1:8787") == .claim)
        await session.claim(
            address: "127.0.0.1:8787", email: "", password: "correct horse battery", again: "correct horse")
        #expect(session.pairingProblem == "The two passwords aren't the same. Type them again.")
        await session.claim(address: "127.0.0.1:8787", email: "", password: "short", again: "short")
        #expect(session.pairingProblem == "The password needs at least 12 characters.")
        #expect(!server.requests.contains { $0.url?.path == "/v1/owner/claim" }, "neither was sent")

        await session.claim(
            address: "127.0.0.1:8787", email: " me@example.org ", password: "correct horse battery",
            again: "correct horse battery")
        #expect(session.pairingProblem == nil)
        #expect(session.store != nil)
        let sent = try #require(server.requests.last { $0.url?.path == "/v1/owner/claim" })
        #expect(
            sent.jsonBody == json(#"{"email":"me@example.org","name":"Test Mac","password":"correct horse battery"}"#))
    }

    @Test func aServerClaimedInABrowserOrWithoutAPasswordSaysWhatToDo() async {
        let server = SampleServer()
        server.owner(password: nil, info: OwnerInfo(password: false, claimable: true, claim: .google))
        let session = session(server)
        #expect(await session.passwordStep(address: "127.0.0.1:8787") == .claimInBrowser)
        #expect(session.pairingProblem?.contains("Open 127.0.0.1:8787 in a browser, sign in with Google") == true)

        server.owner(password: nil, info: OwnerInfo(password: false, claimable: false))
        #expect(await session.passwordStep(address: "127.0.0.1:8787") == .codeOnly)
        #expect(
            session.pairingProblem
                == "This server has no password yet. Connect with a pairing code, then set a password in Settings.")
    }

    @Test func refusalsAreSaidInWords() {
        let wrong = AppSession.ownerProblem(
            .server(code: .unauthorized, message: "x", status: 401, retryAfter: nil), address: "a")
        #expect(wrong.hasPrefix("That password is wrong."))
        let many = AppSession.ownerProblem(
            .server(code: .rateLimited, message: "x", status: 429, retryAfter: 600), address: "a")
        #expect(many == "Too many wrong codes or passwords. Wait 10 minutes, then try again.")
        let google = AppSession.ownerProblem(
            .server(code: .forbidden, message: "x", status: 403, retryAfter: nil), address: "mail.example")
        #expect(google.contains("Open mail.example in a browser"))
    }

    @Test func aPasswordTravelsOnlyOverHTTPSToThisMachineOrOverTailscale() throws {
        for address in [
            "https://mail.example.org", "https://192.168.1.20", "http://127.0.0.1:8484", "localhost:8484",
            "http://[::1]:8484", "http://100.101.102.103:8484", "http://box.tailnet-abc.ts.net",
            "http://[fd7a:115c:a1e0::1]:8484",
        ] {
            #expect(try ServerAddress(parsing: address).carriesPasswords, "\(address)")
        }
        for address in ["192.168.1.20:8484", "http://10.0.0.5", "mail.local", "nas:8484", "http://[fe80::1]:8484"] {
            #expect(try !ServerAddress(parsing: address).carriesPasswords, "\(address)")
        }
    }

    @Test func overPlainHTTPOnALocalNetworkNoPasswordIsSentAndACodeIsOffered() async {
        let server = SampleServer()
        server.owner(password: "correct horse battery", info: OwnerInfo(password: true, claimable: false))
        let session = session(server)

        #expect(await session.passwordStep(address: "192.168.1.20:8484") == .codeOnly)
        #expect(session.pairingProblem?.hasPrefix("192.168.1.20:8484 is reached over plain http") == true)
        #expect(server.requests.isEmpty, "asked before anything is sent")

        await session.signIn(address: "192.168.1.20:8484", password: "correct horse battery")
        await session.claim(
            address: "192.168.1.20:8484", email: "", password: "correct horse battery", again: "correct horse battery")
        #expect(session.store == nil)
        #expect(session.pairingProblem?.contains("Connect with a pairing code instead") == true)
        #expect(!server.requests.contains { $0.url?.path.hasPrefix("/v1/owner") == true }, "no password was sent")
    }
}
