import Foundation
import Synchronization
import Testing

@testable import UsualMailKit

/// Connecting Gmail by signing in with Google (core/src/google.ts): the routes, the models, and the flow the app runs.
struct GoogleSignInModelTests {
    @Test func theRoutesSendWhatTheContractSays() async throws {
        let transport = StubTransport { request in
            if request.httpMethod == "POST" {
                return .raw(
                    #"{"id":"gsi_1","url":"https://accounts.google.com/o/oauth2/v2/auth?x=1","#
                        + #""expiresAt":"2026-11-17T10:10:00Z"}"#)
            }
            return .raw(
                #"{"id":"gsi/1","state":"failed","failure":"scope_missing","message":"Tick Gmail.","expiresAt":"2026-11-17T10:10:00Z","later":1}"#
            )
        }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        let started = try await client.startGoogleSignIn(GoogleSignInInput(name: "Work", icon: .briefcase))
        #expect(started.id == "gsi_1" && started.url.hasPrefix("https://accounts.google.com/"))
        var request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "POST" && request.pathAndQuery == "/v1/google/sign-ins")
        #expect(request.jsonBody == json(#"{"name":"Work","icon":"briefcase"}"#))
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_1")

        let signIn = try await client.googleSignIn(id: "gsi/1")
        #expect(signIn.state == .failed && signIn.failure == .scopeMissing && signIn.message == "Tick Gmail.")
        request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "GET" && request.pathAndQuery == "/v1/google/sign-ins/gsi%2F1")
    }

    @Test func theServerSaysWhetherItCan() throws {
        let decoder = MailJSON.decoder()
        let current = try decoder.decode(
            ServerInfo.self,
            from: Data(
                #"{"name":"usual-mail","version":"0.2.0","apiVersion":1,"googleSignIn":{"available":false,"missing":["client","later"]}}"#
                    .utf8))
        #expect(current.googleSignIn?.available == false)
        #expect(current.googleSignIn?.missing == [.client, .unknown("later")])
        let older = try decoder.decode(
            ServerInfo.self, from: Data(#"{"name":"usual-mail","version":"0.1.0","apiVersion":1}"#.utf8))
        #expect(older.googleSignIn == nil)
    }

    @Test func aGmailInboxSaysWhetherItWasSignedInWithGoogle() throws {
        let decoder = MailJSON.decoder()
        let signedIn = try decoder.decode(
            InboxConnection.self, from: Data(#"{"kind":"gmail","clientId":"c.apps","signIn":"google"}"#.utf8))
        #expect(signedIn == .gmail(clientId: "c.apps", signIn: "google") && signedIn.signsInWithGoogle)
        #expect(try encodedJSON(signedIn) == json(#"{"kind":"gmail","clientId":"c.apps","signIn":"google"}"#))
        let byHand = try decoder.decode(InboxConnection.self, from: Data(#"{"kind":"gmail","clientId":"c.apps"}"#.utf8))
        #expect(byHand == .gmail(clientId: "c.apps") && !byHand.signsInWithGoogle)
        #expect(try encodedJSON(byHand) == json(#"{"kind":"gmail","clientId":"c.apps"}"#))
    }

    @Test func whatIsMissingIsSaidInWordsOrSetUp() {
        #expect(GoogleSignInFlow.readiness(GoogleSignInInfo(available: true)) == .ready)
        // Without a client, the guided set-up; it says itself when the address is missing too.
        #expect(GoogleSignInFlow.readiness(GoogleSignInInfo(available: false, missing: [.client])) == .needsClient)
        #expect(
            GoogleSignInFlow.readiness(GoogleSignInInfo(available: false, missing: [.client, .address]))
                == .needsClient)
        guard case .unavailable(let older) = GoogleSignInFlow.readiness(nil),
            case .unavailable(let address) = GoogleSignInFlow.readiness(
                GoogleSignInInfo(available: false, missing: [.address]))
        else {
            Issue.record("Expected unavailable")
            return
        }
        #expect(older.contains("older"))
        #expect(address.contains("its own address"))
        // The approved words for a server without a Google client (onboarding copy, 2026-11-17), now for a server
        // older than the guided set-up.
        #expect(
            Onboarding.GoogleClient.older
                == "Your server can't sign in to Google yet. Give it a Google client first; the setup guide shows how.")
    }
}

@MainActor
struct GoogleSignInFlowTests {
    /// A server that is ready, starts `gsi_1`, and answers the sign-in's state from `states` in turn (the last one
    /// repeating).
    private func server(
        info: String = #"{"name":"usual-mail","version":"0.2.0","apiVersion":1,"googleSignIn":{"available":true}}"#,
        url: String = "https://accounts.google.com/o/oauth2/v2/auth?state=s",
        states: [String]
    ) -> StubTransport {
        let asked = Mutex(0)
        return StubTransport { request in
            let path = request.url!.path
            if path == "/v1/info" { return .raw(info) }
            if path == "/v1/google/sign-ins" {
                return .raw(#"{"id":"gsi_1","url":"\#(url)","expiresAt":"2026-11-17T10:10:00Z"}"#)
            }
            let index = asked.withLock { count in
                defer { count += 1 }
                return min(count, states.count - 1)
            }
            return .raw(#"{"id":"gsi_1",\#(states[index]),"expiresAt":"2026-11-17T10:10:00Z"}"#)
        }
    }

    private final class Opened: @unchecked Sendable {
        var urls: [URL] = []
        var fetched = 0
    }

    private func flow(_ transport: StubTransport, reconnecting: String? = nil, opened: Opened) -> GoogleSignInFlow {
        GoogleSignInFlow(
            client: APIClient(server: testServer, token: "tok_1", transport: transport), reconnecting: reconnecting,
            open: { opened.urls.append($0) }, connected: { opened.fetched += 1 }, pause: { _ in },
            clock: { ISO8601DateFormatter().date(from: "2026-11-17T10:00:00Z")! })
    }

    @Test func signingInConnectsANewInbox() async throws {
        let transport = server(states: [
            #""state":"waiting""#, #""state":"connected","inboxId":"inb_9","reconnected":false"#,
        ])
        let opened = Opened()
        let flow = flow(transport, opened: opened)
        await flow.check()
        #expect(flow.step == .ready)
        await flow.start()
        #expect(flow.step == .connected(inboxId: "inb_9", reconnected: false))
        #expect(opened.urls.map(\.host) == ["accounts.google.com"])
        #expect(opened.fetched == 1)
        let paths = transport.requests.map(\.pathAndQuery)
        #expect(paths == ["/v1/info", "/v1/google/sign-ins", "/v1/google/sign-ins/gsi_1", "/v1/google/sign-ins/gsi_1"])
        #expect(transport.requests[1].jsonBody == json("{}"))
    }

    @Test func reconnectingNamesOnlyTheInbox() async throws {
        let transport = server(states: [#""state":"connected","inboxId":"inb_1","reconnected":true"#])
        let opened = Opened()
        let flow = flow(transport, reconnecting: "inb_1", opened: opened)
        await flow.start(name: "ignored")
        #expect(flow.step == .connected(inboxId: "inb_1", reconnected: true))
        #expect(transport.requests[0].jsonBody == json(#"{"inboxId":"inb_1"}"#))
    }

    @Test func aFailureShowsTheServersWordsOrOurs() async throws {
        let opened = Opened()
        let withWords = flow(
            server(states: [#""state":"failed","failure":"declined","message":"You said no at Google.""#]),
            opened: opened)
        await withWords.start()
        #expect(withWords.step == .failed("You said no at Google."))

        let without = flow(server(states: [#""state":"failed","failure":"wrong_account""#]), opened: opened)
        await without.start()
        #expect(without.step == .failed(GoogleSignInFlow.failureWords(.wrongAccount)))
        #expect(opened.fetched == 0)
    }

    @Test func onlyAWebPageIsOpened() async throws {
        let opened = Opened()
        let flow = flow(server(url: "file:///etc/hosts", states: [#""state":"waiting""#]), opened: opened)
        await flow.start()
        #expect(opened.urls.isEmpty)
        guard case .failed = flow.step else {
            Issue.record("Expected failed")
            return
        }
    }

    @Test func aServerThatCantSaysWhatIsMissing() async throws {
        let transport = server(
            info: #"{"name":"usual-mail","version":"0.2.0","apiVersion":1,"#
                + #""googleSignIn":{"available":false,"missing":["address"]}}"#,
            states: [])
        let flow = flow(transport, opened: Opened())
        await flow.check()
        guard case .unavailable(let words) = flow.step else {
            Issue.record("Expected unavailable")
            return
        }
        #expect(words.contains("its own address"))
    }

    @Test func aTestServersWebPageOpensToo() async throws {
        let opened = Opened()
        let flow = flow(
            server(
                url: "http://127.0.0.1:9999/fake-google?state=s", states: [#""state":"connected","inboxId":"inb_9""#]),
            opened: opened)
        await flow.start()
        #expect(opened.urls.map(\.absoluteString) == ["http://127.0.0.1:9999/fake-google?state=s"])
        #expect(flow.step == .connected(inboxId: "inb_9", reconnected: false))
    }

    @Test func itAsksAboutOnceASecond() async throws {
        #expect(GoogleSignInFlow.interval == .seconds(1))
        let pauses = Mutex<[Duration]>([])
        let flow = GoogleSignInFlow(
            client: APIClient(
                server: testServer, token: "tok_1",
                transport: server(states: [#""state":"waiting""#, #""state":"connected","inboxId":"inb_9""#])),
            open: { _ in }, connected: {}, pause: { duration in pauses.withLock { $0.append(duration) } },
            clock: { ISO8601DateFormatter().date(from: "2026-11-17T10:00:00Z")! })
        await flow.start()
        #expect(pauses.withLock { $0 } == [.seconds(1), .seconds(1)])
    }

    @Test func itKeepsAskingForAWhilePastTheEnd() async throws {
        // Twelve seconds past the sign-in's end the server may still say how it ended.
        let opened = Opened()
        let lateButInTime = GoogleSignInFlow(
            client: APIClient(
                server: testServer, token: "tok_1",
                transport: server(states: [#""state":"waiting""#, #""state":"connected","inboxId":"inb_9""#])),
            open: { opened.urls.append($0) }, connected: {}, pause: { _ in },
            clock: { ISO8601DateFormatter().date(from: "2026-11-17T10:10:12Z")! })
        await lateButInTime.start()
        #expect(lateButInTime.step == .connected(inboxId: "inb_9", reconnected: false))

        // Sixteen seconds past it, the flow stops asking.
        let tooLate = GoogleSignInFlow(
            client: APIClient(server: testServer, token: "tok_1", transport: server(states: [#""state":"waiting""#])),
            open: { opened.urls.append($0) }, connected: {}, pause: { _ in },
            clock: { ISO8601DateFormatter().date(from: "2026-11-17T10:10:16Z")! })
        await tooLate.start()
        #expect(tooLate.step == .failed(GoogleSignInFlow.failureWords(.expired)))
    }

    @Test func aSignInThatStaysWaitingPastItsEndExpires() async throws {
        let transport = server(states: [#""state":"waiting""#])
        let opened = Opened()
        // The clock is already past the sign-in's end.
        let late = GoogleSignInFlow(
            client: APIClient(server: testServer, token: "tok_1", transport: transport),
            open: { opened.urls.append($0) }, connected: {}, pause: { _ in },
            clock: { ISO8601DateFormatter().date(from: "2026-11-17T10:11:00Z")! })
        await late.start()
        #expect(late.step == .failed(GoogleSignInFlow.failureWords(.expired)))
    }
}
