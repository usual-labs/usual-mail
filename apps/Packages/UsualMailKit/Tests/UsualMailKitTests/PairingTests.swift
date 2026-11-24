import Foundation
import Testing

@testable import UsualMailKit

@MainActor
struct PairingTests {
    private func session(_ server: SampleServer, credentials: MemoryCredentialStore = MemoryCredentialStore())
        -> AppSession
    {
        AppSession(
            credentials: credentials, transport: server, databaseDirectory: nil, deviceName: "Test Mac",
            listens: false, clock: { SampleData.bundled.now })
    }

    @Test func anUnpairedDeviceShowsPairing() {
        let session = session(SampleServer())
        session.restore()
        guard case .unpaired = session.state else {
            Issue.record("Expected unpaired")
            return
        }
    }

    @Test func pairingKeepsTheTokenAndOpensTheStore() async throws {
        let server = SampleServer()
        let credentials = MemoryCredentialStore()
        let session = session(server, credentials: credentials)
        await session.pair(address: "mail.local:8787", code: " ABCD-1234 ")

        let saved = try #require(try credentials.load())
        #expect(saved.token == "tok_secret")
        #expect(saved.deviceId == "dev_test" && saved.deviceName == "Test Mac")
        #expect(saved.server.baseURL.absoluteString == "http://mail.local:8787")
        #expect(session.pairingProblem == nil)
        let store = try #require(session.store)
        #expect(server.requests.map(\.pathAndQuery) == ["/v1/info", "/v1/pair"])
        #expect(server.requests[1].jsonBody == json(#"{"code":"ABCD-1234","name":"Test Mac"}"#))

        await store.refresh()
        #expect(server.requests.last?.value(forHTTPHeaderField: "Authorization") == "Bearer tok_secret")
        #expect(store.lists.home.count == 5)
    }

    @Test func aSavedPairingOpensWithoutAsking() throws {
        let credentials = MemoryCredentialStore(
            Credentials(server: testServer, token: "tok_secret", deviceId: "dev_test", deviceName: "Mac"))
        let session = session(SampleServer(), credentials: credentials)
        session.restore()
        #expect(session.store != nil)
        #expect(session.credentials?.deviceId == "dev_test")
    }

    @Test func aWrongCodeSaysWhatToDo() async throws {
        let credentials = MemoryCredentialStore()
        let session = session(SampleServer(), credentials: credentials)
        await session.pair(address: "mail.local:8787", code: "WRONG")
        #expect(session.pairingProblem?.hasPrefix("That code didn't work.") == true)
        #expect(session.pairingProblem?.contains("run usual-mail pair") == true)
        #expect(try credentials.load() == nil)
        #expect(session.store == nil)
    }

    @Test func tooManyWrongCodesSaysToWait() async throws {
        let server = SampleServer()
        server.failOnce("POST /v1/pair", with: .error("rate_limited", "Too many tries", status: 429))
        let session = session(server)
        await session.pair(address: "mail.local:8787", code: "ABCD-1234")
        // Without Retry-After, the longest the limit lasts.
        #expect(session.pairingProblem == "Too many wrong codes. Wait ten minutes, then try again.")
        #expect(session.store == nil)

        var limited = StubReply.error("rate_limited", "Too many tries", status: 429)
        limited.headers["Retry-After"] = "95"
        server.failOnce("POST /v1/pair", with: limited)
        await session.pair(address: "mail.local:8787", code: "ABCD-1234")
        #expect(session.pairingProblem == "Too many wrong codes. Wait 2 minutes, then try again.")
    }

    @Test func otherRefusalsSayWhatTheServerSaid() {
        let error = APIError.server(code: .invalid, message: "A device name is required.", status: 400)
        #expect(AppSession.pairingProblem(error, address: "mail.local") == "A device name is required.")
    }

    @Test(arguments: [
        (URLError.Code.cannotConnectToHost, "No Usual Mail server answered at 127.0.0.1:8585."),
        (.timedOut, "No Usual Mail server answered at 127.0.0.1:8585."),
        (.cannotFindHost, "No Usual Mail server answered at 127.0.0.1:8585."),
        (.secureConnectionFailed, "A secure connection to 127.0.0.1:8585 couldn't be made."),
        (.notConnectedToInternet, "This Mac is offline, so it couldn't reach 127.0.0.1:8585."),
    ])
    func whyNothingAnsweredIsSaidInWords(code: URLError.Code, start: String) async {
        let transport = StubTransport { _ in throw URLError(code) }
        let session = AppSession(
            credentials: MemoryCredentialStore(), transport: transport, databaseDirectory: nil, deviceName: "Mac",
            listens: false)
        await session.pair(address: " 127.0.0.1:8585 ", code: "ABCD")
        #expect(session.pairingProblem?.hasPrefix(start) == true)
        #expect(session.store == nil)
    }

    @Test func disconnectingRevokesThisDeviceThenForgetsTheToken() async throws {
        let server = SampleServer()
        let credentials = MemoryCredentialStore()
        let session = session(server, credentials: credentials)
        await session.pair(address: "mail.local:8787", code: "ABCD-1234")
        #expect(session.store != nil)

        await session.disconnect()
        let revoke = try #require(server.requests.last)
        #expect(revoke.httpMethod == "DELETE" && revoke.pathAndQuery == "/v1/devices/dev_test")
        #expect(revoke.value(forHTTPHeaderField: "Authorization") == "Bearer tok_secret")
        #expect(server.state.withLock { $0.revoked } == ["dev_test"])
        #expect(try credentials.load() == nil)
        #expect(session.store == nil && session.pairingProblem == nil)
    }

    @Test func disconnectingWhileTheServerIsAwayStillForgetsAndSaysSo() async throws {
        let credentials = MemoryCredentialStore(
            Credentials(server: testServer, token: "tok_secret", deviceId: "dev_test", deviceName: "Test Mac"))
        let transport = StubTransport { _ in throw URLError(.cannotConnectToHost) }
        let session = AppSession(
            credentials: credentials, transport: transport, databaseDirectory: nil, deviceName: "Test Mac",
            listens: false)
        session.restore()
        await session.disconnect()
        #expect(transport.requests.map(\.pathAndQuery) == ["/v1/devices/dev_test"])
        #expect(try credentials.load() == nil)
        #expect(session.store == nil)
        #expect(session.pairingProblem?.contains("still lists \"Test Mac\"") == true)
    }

    @Test func disconnectingATokenTheServerAlreadyEndedJustForgets() async throws {
        let server = SampleServer()
        let session = session(server)
        await session.pair(address: "mail.local:8787", code: "ABCD-1234")
        server.failOnce("DELETE /v1/devices/dev_test", with: .error("unauthorized", "Revoked", status: 401))
        await session.disconnect()
        #expect(session.store == nil && session.pairingProblem == nil)
    }

    @Test func addressesAreCheckedFirst() async throws {
        let server = SampleServer()
        let session = session(server)
        await session.pair(address: "http://mail.example.com", code: "ABCD-1234")
        #expect(session.pairingProblem?.contains("only connects to it over https") == true)
        await session.pair(address: "", code: "ABCD-1234")
        #expect(session.pairingProblem == "Enter your server's address.")
        await session.pair(address: "mail.local", code: "")
        #expect(session.pairingProblem == "Enter the pairing code your server gave you.")
        #expect(server.requests.isEmpty)
    }

    @Test func somethingThatIsNotAUsualMailServerIsRefused() async throws {
        let transport = StubTransport { _ in .raw(#"{"name":"other","version":"1","apiVersion":1}"#) }
        let session = AppSession(
            credentials: MemoryCredentialStore(), transport: transport, databaseDirectory: nil, deviceName: "Mac",
            listens: false)
        await session.pair(address: "mail.local", code: "ABCD")
        #expect(session.pairingProblem == "mail.local answered, but it isn't a Usual Mail server.")
        #expect(transport.requests.count == 1)
    }

    @Test func signingOutForgetsTheTokenAndTheCopy() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "usualmail-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let credentials = MemoryCredentialStore()
        let session = AppSession(
            credentials: credentials, transport: SampleServer(), databaseDirectory: directory, deviceName: "Mac",
            listens: false)
        await session.pair(address: "mail.local:8787", code: "ABCD-1234")
        await session.store?.refresh()
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))
        #expect(files.contains { $0.hasPrefix("mail-") && $0.hasSuffix(".sqlite") })

        session.signOut(reason: "Signed out.")
        #expect(try credentials.load() == nil)
        #expect(session.pairingProblem == "Signed out.")
        #expect(session.store == nil)
        let left = try FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))
        #expect(!left.contains { $0.hasSuffix(".sqlite") })
    }

    @Test func pairingAgainStartsAFreshCopy() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "usualmail-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = AppSession(
            credentials: MemoryCredentialStore(), transport: SampleServer(), databaseDirectory: directory,
            deviceName: "Mac", listens: false)
        await first.pair(address: "mail.local:8787", code: "ABCD-1234")
        let firstStore = try #require(first.store)
        await firstStore.refresh()
        #expect(try await firstStore.local.thread(id: "thr_1") != nil)

        // The same address paired again, say after the server's store was reset: its versions start over, so
        // nothing the old copy held may stay to outrank them.
        let second = AppSession(
            credentials: MemoryCredentialStore(), transport: SampleServer(), databaseDirectory: directory,
            deviceName: "Mac", listens: false)
        await second.pair(address: "mail.local:8787", code: "ABCD-1234")
        let secondStore = try #require(second.store)
        #expect(try await secondStore.local.thread(id: "thr_1") == nil)
    }

    @Test func theServerRefusingTheTokenSignsOut() async throws {
        let server = SampleServer()
        let session = session(server)
        await session.pair(address: "mail.local:8787", code: "ABCD-1234")
        server.failOnce("GET /v1/inboxes", with: .error("unauthorized", "Revoked", status: 401))
        await session.store?.refresh()
        #expect(session.store == nil)
        #expect(session.pairingProblem?.contains("signed this device out") == true)
    }
}

/// Uses the real Keychain under a service name made for this run, and deletes the item afterwards.
struct KeychainCredentialStoreTests {
    @Test func savesLoadsAndDeletes() throws {
        let store = KeychainCredentialStore(service: "Usual Mail tests \(UUID().uuidString)")
        defer { try? store.delete() }
        let credentials = Credentials(server: testServer, token: "tok_\(UUID())", deviceId: "dev", deviceName: "Mac")
        // Fails with errSecInteractionNotAllowed (-25308) while the login keychain is locked: keep the Mac
        // unlocked when running the checks.
        try store.save(credentials)
        #expect(try store.load() == credentials)
        var changed = credentials
        changed.token = "tok_changed"
        try store.save(changed)
        #expect(try store.load()?.token == "tok_changed")
        try store.delete()
        #expect(try store.load() == nil)
    }
}
