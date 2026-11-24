import Foundation
import Synchronization
import Testing

@testable import UsualMailKit

/// Adding another Gmail account from the Mac app's switch: its plus opens the shared Sign in with Google step, which
/// runs this `GoogleSignInFlow` as built here (the store's own client and token, the store's refresh once an inbox
/// connects) and starts at once. Each state the step shows, against the sample's stand-in server with Sign in with
/// Google added.
@MainActor
struct AnotherGmailTests {
    private final class Opened: @unchecked Sendable {
        var urls: [URL] = []
    }

    /// A store on the sample's copy, talking to `server`.
    private func store(_ server: SignInServer) async throws -> MailStore {
        let now = SampleData.bundled.now
        let store = MailStore(
            client: APIClient(server: testServer, token: "tok_secret", transport: server),
            local: try await LocalStore.sample(), clock: { now })
        await store.loadFromDisk()
        return store
    }

    /// The flow as `GoogleSignInStep` builds it for a new inbox, without waiting between questions.
    private func flow(
        _ store: MailStore, opened: Opened,
        pause: @escaping @Sendable (Duration) async throws -> Void = { _ in }
    ) -> GoogleSignInFlow {
        GoogleSignInFlow(
            client: store.apiClient, open: { opened.urls.append($0) },
            connected: { [store] in await store.refresh() }, pause: pause,
            clock: { ISO8601DateFormatter().date(from: "2026-11-17T10:00:00Z")! })
    }

    /// What the step does when it starts at once: asks whether it can, then starts if it can.
    private func run(_ flow: GoogleSignInFlow) async {
        await flow.check()
        if flow.step == .ready { await flow.start() }
    }

    private let added = Inbox(
        id: "inb_added", name: "sam@work.example", address: "sam@work.example", color: "#5B6B7F", icon: .briefcase,
        position: 3, provider: .gmail, connection: .gmail(clientId: "c.apps", signIn: "google"), trust: .suggest,
        status: .connecting, createdAt: SampleData.bundled.now)

    @Test func aNewAccountConnectsAndJoinsTheSwitchWithoutARelaunch() async throws {
        let server = SignInServer(
            states: [#""state":"waiting""#, #""state":"connected","inboxId":"inb_added","reconnected":false"#],
            adds: added)
        let store = try await store(server)
        #expect(store.lists.inboxes.count == 3)
        let opened = Opened()
        let flow = flow(store, opened: opened)
        await run(flow)

        #expect(flow.step == .connected(inboxId: "inb_added", reconnected: false))
        #expect(opened.urls.map(\.host) == ["accounts.google.com"])
        // A new inbox with the person's own token; the server picks its name, colour and icon.
        let start = try #require(server.requests.first { $0.url?.path == "/v1/google/sign-ins" })
        #expect(start.jsonBody == json("{}"))
        #expect(start.value(forHTTPHeaderField: "Authorization") == "Bearer tok_secret")
        // The flow's refresh brought it in, last by its position, with the server's icon, its first sync under way.
        let lastAsked = try #require(server.requests.lastIndex { $0.url?.path == "/v1/google/sign-ins/gsi_1" })
        #expect(server.requests[lastAsked...].contains { $0.url?.path == "/v1/inboxes" })
        #expect(store.lists.inboxes.map(\.id) == ["inb_northwind", "inb_harbor", "inb_personal", "inb_added"])
        let shown = try #require(store.lists.inboxes.last)
        #expect(shown.icon == .briefcase && shown.status == .connecting)
    }

    @Test func anAccountAlreadyConnectedIsSignedInAgainInPlace() async throws {
        // The server matches the address to its Gmail inbox and replaces that inbox's access; nothing new is made.
        let server = SignInServer(states: [#""state":"connected","inboxId":"inb_northwind","reconnected":true"#])
        let store = try await store(server)
        let flow = flow(store, opened: Opened())
        await run(flow)
        #expect(flow.step == .connected(inboxId: "inb_northwind", reconnected: true))
        #expect(store.lists.inboxes.map(\.id) == ["inb_northwind", "inb_harbor", "inb_personal"])
    }

    @Test func aServerWithoutAGoogleClientShowsItsSetUpInsteadOfFailing() async throws {
        let server = SignInServer(googleSignIn: #"{"available":false,"missing":["client"]}"#)
        let store = try await store(server)
        let opened = Opened()
        let flow = flow(store, opened: opened)
        await run(flow)
        #expect(flow.step == .needsClient)
        #expect(opened.urls.isEmpty)
        #expect(!server.requests.contains { $0.url?.path == "/v1/google/sign-ins" })
    }

    @Test func aFailureSaysTheServersReasonAndChangesNothing() async throws {
        let reason = "You didn't allow Usual Mail to use this Google account, so nothing was connected."
        let server = SignInServer(states: [#""state":"failed","failure":"declined","message":"\#(reason)""#])
        let store = try await store(server)
        let flow = flow(store, opened: Opened())
        await run(flow)
        #expect(flow.step == .failed(reason))
        #expect(!server.requests.contains { $0.url?.path == "/v1/inboxes" })
        #expect(store.lists.inboxes.count == 3)
    }

    @Test func anAgentCantAddAnInbox() async throws {
        let server = SignInServer(
            start: .error("needs_person", "Only a person can sign in with Google", status: 403), states: [])
        let store = try await store(server)
        let flow = flow(store, opened: Opened())
        await run(flow)
        #expect(
            flow.step
                == .failed(
                    "The sign-in couldn't start. Only a person can do that. Only a person can sign in with Google"))
    }

    @Test func itOpensTheBrowserWaitsAndCanBeStopped() async throws {
        let gate = Gate()
        let server = SignInServer(holdsStart: gate, states: [#""state":"waiting""#])
        let store = try await store(server)
        let opened = Opened()
        let flow = flow(store, opened: opened) { _ in try await Task.sleep(for: .seconds(60)) }
        await flow.check()
        let running = Task { await flow.start() }
        try await until { flow.step == .starting }
        #expect(opened.urls.isEmpty)
        await gate.open()
        try await until { flow.step == .waiting }
        #expect(opened.urls.map(\.host) == ["accounts.google.com"])
        // "Stop waiting": the step cancels its task and goes back to the button.
        running.cancel()
        flow.reset()
        await running.value
        #expect(flow.step == .ready)
    }

    /// Waits, up to a second, for the flow to get there.
    private func until(_ condition: () -> Bool) async throws {
        var tries = 0
        while !condition() && tries < 500 {
            try await Task.sleep(for: .milliseconds(2))
            tries += 1
        }
        #expect(condition())
    }
}

/// The sample's stand-in server with Sign in with Google: `/v1/info` says whether it can, a sign-in starts as `gsi_1`
/// (after `holdsStart` opens), and asking how it stands answers `states` in turn, the last repeating. Before a
/// `connected` answer it holds `added`, as the real server keeps the new inbox before it says so. Everything else is
/// the sample's.
private final class SignInServer: HTTPTransport {
    let sample = SampleServer()
    private let googleSignIn: String
    private let start: StubReply?
    private let holdsStart: Gate?
    private let states: [String]
    private let added: Inbox?
    private let asked = Mutex(0)
    private let recorded = Mutex<[URLRequest]>([])

    init(
        googleSignIn: String = #"{"available":true}"#, start: StubReply? = nil, holdsStart: Gate? = nil,
        states: [String] = [], adds added: Inbox? = nil
    ) {
        self.googleSignIn = googleSignIn
        self.start = start
        self.holdsStart = holdsStart
        self.states = states
        self.added = added
    }

    var requests: [URLRequest] { recorded.withLock { $0 } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        recorded.withLock { $0.append(request) }
        let path = request.url!.path
        let reply: StubReply
        if path == "/v1/info" {
            reply = .raw(#"{"name":"usual-mail","version":"0.2.0","apiVersion":1,"googleSignIn":\#(googleSignIn)}"#)
        } else if path == "/v1/google/sign-ins" {
            if let holdsStart { await holdsStart.wait() }
            reply =
                start
                ?? .raw(
                    #"{"id":"gsi_1","url":"https://accounts.google.com/o/oauth2/v2/auth?state=s","#
                        + #""expiresAt":"2026-11-17T10:10:00Z"}"#)
        } else if path.hasPrefix("/v1/google/sign-ins/") {
            let state = asked.withLock { count in
                defer { count += 1 }
                return states[min(count, states.count - 1)]
            }
            if state.contains(#""connected""#), let added {
                sample.state.withLock { state in
                    if !state.data.inboxes.contains(where: { $0.id == added.id }) { state.data.inboxes.append(added) }
                }
            }
            reply = .raw(#"{"id":"gsi_1",\#(state),"expiresAt":"2026-11-17T10:10:00Z"}"#)
        } else {
            return try await sample.data(for: request)
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        return (reply.body, response)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        throw URLError(.unsupportedURL)
    }
}
