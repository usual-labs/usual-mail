import Foundation
import Testing

@testable import UsualMailKit

/// Each family of routes in core/src/api.ts: method, path, query and body as sent, and the answer read.
struct APIClientRequestTests {
    let sample = SampleData.bundled

    private func client(_ reply: StubReply) -> (APIClient, StubTransport) {
        let transport = StubTransport { _ in reply }
        return (APIClient(server: testServer, token: "tok_1", transport: transport), transport)
    }

    @Test func serverRoutesNeedNoToken() async throws {
        let (client, transport) = self.client(.raw(#"{"name":"usual-mail","version":"0.1.0","apiVersion":1}"#))
        let info = try await client.info()
        #expect(info == ServerInfo(name: "usual-mail", version: "0.1.0", apiVersion: 1))
        let request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString == "http://mail.local:8787/v1/info")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)

        let (health, healthTransport) = self.client(.raw(#"{"ok":true}"#))
        #expect(try await health.health())
        #expect(healthTransport.lastRequest?.pathAndQuery == "/healthz")
    }

    @Test func pairingAndDevices() async throws {
        let device = Device(id: "dev_1", name: "Mac", kind: .person, createdAt: sample.now)
        let (client, transport) = self.client(
            .json(["token": "tok_new", "device": try encodedJSON(device)] as JSONValue))
        let result = try await client.withToken("ignored").pair(PairInput(code: "ABCD", name: "Mac"))
        #expect(result.token == "tok_new" && result.device == device)
        var request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "POST" && request.pathAndQuery == "/v1/pair")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.jsonBody == json(#"{"code":"ABCD","name":"Mac"}"#))
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")

        let (codes, codeTransport) = self.client(.raw(#"{"code":"WXYZ","expiresAt":"2026-11-16T10:30:00Z"}"#))
        let code = try await codes.createPairingCode(PairingCodeInput(kind: .agent, inboxIds: ["inb_harbor"]))
        #expect(code.code == "WXYZ")
        request = try #require(codeTransport.lastRequest)
        #expect(request.httpMethod == "POST" && request.pathAndQuery == "/v1/pairing-codes")
        #expect(request.jsonBody == json(#"{"kind":"agent","inboxIds":["inb_harbor"]}"#))
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_1")

        let (devices, deviceTransport) = self.client(.json([device]))
        #expect(try await devices.listDevices() == [device])
        try await devices.revokeDevice(id: "dev/1")
        #expect(deviceTransport.requests.map(\.pathAndQuery) == ["/v1/devices", "/v1/devices/dev%2F1"])
        #expect(deviceTransport.lastRequest?.httpMethod == "DELETE")

        // GET /v1/me: which device this token belongs to.
        let (me, meTransport) = self.client(.json(device))
        #expect(try await me.me() == device)
        request = try #require(meTransport.lastRequest)
        #expect(request.httpMethod == "GET" && request.pathAndQuery == "/v1/me" && request.httpBody == nil)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_1")
    }

    @Test func inboxes() async throws {
        let inbox = sample.inboxes.first { $0.id == "inb_northwind" }!
        let (client, transport) = self.client(.json(inbox))
        _ = try await client.updateInbox(id: inbox.id, patch: InboxPatch(trust: .suggest, paused: true))
        _ = try await client.connectInbox(
            ConnectInboxInput(name: "Acme", color: "#112233", provider: .imap, credentials: ["user": "a"]))
        try await client.removeInbox(id: inbox.id)
        try await client.syncInbox(id: inbox.id)
        let sent = transport.requests
        #expect(
            sent.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == [
                "PATCH /v1/inboxes/inb_northwind", "POST /v1/inboxes", "DELETE /v1/inboxes/inb_northwind",
                "POST /v1/inboxes/inb_northwind/sync",
            ])
        #expect(sent[0].jsonBody == json(#"{"paused":true,"trust":"suggest"}"#))
        #expect(
            sent[1].jsonBody
                == json(##"{"color":"#112233","credentials":{"user":"a"},"name":"Acme","provider":"imap"}"##))
        #expect(sent[2].httpBody == nil)

        let (list, _) = self.client(.json(sample.inboxes))
        #expect(try await list.listInboxes() == sample.inboxes)
    }

    @Test func newCredentialsGoInTheInboxPatch() async throws {
        let inbox = sample.inboxes.first { $0.id == "inb_personal" }!
        let (client, transport) = self.client(.json(inbox))
        // Made-up values in the shape of ImapCredentials; the server checks them with the provider first.
        let credentials: JSONValue = [
            "imap": ["host": "imap.home.example", "port": 993, "secure": true, "user": "me", "password": "not-real"],
            "smtp": ["host": "smtp.home.example", "port": 465, "secure": true, "user": "me", "password": "not-real"],
        ]
        _ = try await client.updateInbox(id: inbox.id, patch: InboxPatch(credentials: credentials))
        let sent = try #require(transport.lastRequest)
        #expect(sent.httpMethod == "PATCH" && sent.pathAndQuery == "/v1/inboxes/inb_personal")
        #expect(sent.jsonBody == ["credentials": credentials])
    }

    @Test func viewsTakeTheirQueryParameters() async throws {
        let page = Page(items: [sample.threads[0]], nextCursor: "c2")
        let (client, transport) = self.client(.json(page))
        #expect(try await client.home(ListQuery(inboxId: "inb_harbor", cursor: "c1", limit: 20)) == page)
        _ = try await client.category(.receipt)
        _ = try await client.category(.uncategorized, ListQuery(inboxId: "inb_personal", limit: 200))
        _ = try await client.category(.otp, ListQuery(cursor: "c/2"))
        _ = try await client.categories([.invoice, .receipt, .invoice, .unknown("later")], ListQuery(limit: 50))
        #expect(try await client.categories([.unknown("later")]).items.isEmpty)
        _ = try await client.stack(.replyLater, ListQuery(limit: 5))
        _ = try await client.waiting(ListQuery(inboxId: "inb_harbor"))
        _ = try await client.screening(ListQuery(cursor: "c3", limit: 10))
        #expect(
            transport.requests.map(\.pathAndQuery) == [
                "/v1/home?inboxId=inb_harbor&cursor=c1&limit=20",
                "/v1/categories/receipt",
                "/v1/categories/unknown?inboxId=inb_personal&limit=200",
                "/v1/categories/otp?cursor=c%2F2",
                "/v1/categories/invoice,receipt?limit=50",
                "/v1/stacks/reply_later?limit=5",
                "/v1/waiting?inboxId=inb_harbor",
                "/v1/screening?cursor=c3&limit=10",
            ])
        #expect(transport.requests.allSatisfy { $0.httpMethod == "GET" && $0.httpBody == nil })

        let items = sample.handledItems
        let (handled, handledTransport) = self.client(.json(Page(items: items)))
        #expect(try await handled.handled(HandledQuery(states: [.proposed, .undone])).items == items)
        #expect(handledTransport.lastRequest?.pathAndQuery == "/v1/handled?states=proposed%2Cundone")
        _ = try await handled.handled(HandledQuery(list: ListQuery(limit: 20), includeSilent: true))
        #expect(handledTransport.lastRequest?.pathAndQuery == "/v1/handled?limit=20&includeSilent=true")
        // What needs a look: every state unless states are named.
        _ = try await handled.handled(HandledQuery(attentionOnly: true))
        #expect(handledTransport.lastRequest?.pathAndQuery == "/v1/handled?attentionOnly=true")
        _ = try await handled.handled(HandledQuery(states: [.failed], attentionOnly: true))
        #expect(handledTransport.lastRequest?.pathAndQuery == "/v1/handled?states=failed&attentionOnly=true")

        let (detail, detailTransport) = self.client(.json(sample.detail(threadId: "thr_1")!))
        #expect(try await detail.thread(id: "thr_1").messages.map(\.id) == ["msg_1a", "msg_1b"])
        #expect(detailTransport.lastRequest?.pathAndQuery == "/v1/threads/thr_1")
    }

    @Test func attachmentsComeBackAsBytes() async throws {
        let transport = StubTransport { _ in
            StubReply(status: 200, body: Data([0x25, 0x50, 0x44, 0x46]), headers: ["Content-Type": "application/pdf"])
        }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        let file = try await client.attachment(messageId: "msg_1a", attachmentId: "att_1")
        #expect(file == AttachmentData(data: Data([0x25, 0x50, 0x44, 0x46]), mimeType: "application/pdf"))
        #expect(transport.lastRequest?.pathAndQuery == "/v1/messages/msg_1a/attachments/att_1")
    }

    @Test func actions() async throws {
        let record = sample.actions[3]
        let named = Array(sample.threads.prefix(2))
        let answer = ActResult(records: [record], threads: named)
        let (client, transport) = self.client(.json(answer))
        let result = try await client.act(
            ActInput(threadIds: ["thr_1", "thr_2"], action: .stack(.replyLater), reason: "later"))
        #expect(result == answer && result.threads.map(\.id) == ["thr_1", "thr_2"] && result.teach == nil)
        _ = try await client.undo(actionId: "act_4")
        var sent = transport.requests
        #expect(sent[0].httpMethod == "POST" && sent[0].pathAndQuery == "/v1/actions")
        #expect(
            sent[0].jsonBody
                == json(
                    #"{"action":{"kind":"stack","stack":"reply_later"},"reason":"later","threadIds":["thr_1","thr_2"]}"#
                ))
        #expect(sent[1].pathAndQuery == "/v1/actions/act_4/undo" && sent[1].httpBody == nil)

        let (answers, answerTransport) = self.client(.json(answer))
        #expect(try await answers.approve(actionIds: ["act_4"]) == answer)
        _ = try await answers.reject(actionIds: ["act_4", "act_9"])
        sent = answerTransport.requests
        #expect(sent.map(\.pathAndQuery) == ["/v1/actions/approve", "/v1/actions/reject"])
        #expect(sent[0].jsonBody == json(#"{"actionIds":["act_4"]}"#))
        #expect(sent[1].jsonBody == json(#"{"actionIds":["act_4","act_9"]}"#))
    }

    @Test func rulesAndTeaching() async throws {
        let rule = sample.rules[0]
        let (client, transport) = self.client(.json(rule))
        let draft = RuleDraft(inboxId: "inb_northwind", text: rule.text, match: rule.match, then: rule.then)
        #expect(try await client.createRule(draft) == rule)
        _ = try await client.updateRule(id: rule.id, patch: RulePatch(enabled: false))
        try await client.deleteRule(id: rule.id)
        #expect(try await client.answerTeach(id: "tch_1", accept: true) == rule)
        let sent = transport.requests
        #expect(
            sent.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == [
                "POST /v1/inboxes/inb_northwind/rules", "PATCH /v1/rules/rul_1", "DELETE /v1/rules/rul_1",
                "POST /v1/teach/tch_1",
            ])
        // The body is the draft without inboxId, which the path carries.
        #expect(
            sent[0].jsonBody
                == json(
                    #"{"match":{"domain":"paperloop.example"},"text":"\#(rule.text)","then":[{"category":"receipt","kind":"categorize"},{"kind":"done"}]}"#
                ))
        #expect(sent[1].jsonBody == json(#"{"enabled":false}"#))
        #expect(sent[3].jsonBody == json(#"{"accept":true}"#))

        let (declined, _) = self.client(.raw("null"))
        #expect(try await declined.answerTeach(id: "tch_1", accept: false) == nil)
        let (list, listTransport) = self.client(.json(sample.rules))
        #expect(try await list.listRules(inboxId: "inb_harbor").count == 4)
        #expect(listTransport.lastRequest?.pathAndQuery == "/v1/inboxes/inb_harbor/rules")
    }

    @Test func triage() async throws {
        let answer = ActResult(records: [sample.actions[0]], threads: [sample.threads[8]])
        let (client, transport) = self.client(.json(answer))
        let decisions = [TriageDecision(threadId: "thr_8", category: .newsletter, done: true, reason: "A newsletter")]
        #expect(try await client.decide(decisions) == answer)
        #expect(transport.lastRequest?.pathAndQuery == "/v1/triage/decisions")
        #expect(
            transport.lastRequest?.jsonBody
                == json(
                    #"{"decisions":[{"category":"newsletter","done":true,"reason":"A newsletter","threadId":"thr_8"}]}"#
                ))

        let item = TriageItem(thread: sample.threads[0], latest: sample.messages[1])
        let (queue, queueTransport) = self.client(.json([item]))
        #expect(try await queue.triageQueue(inboxId: "inb_northwind", limit: 10) == [item])
        #expect(queueTransport.lastRequest?.pathAndQuery == "/v1/triage?inboxId=inb_northwind&limit=10")
    }

    @Test func countsAndTheAI() async throws {
        let (counts, countsTransport) = self.client(.json(sample.counts))
        #expect(try await counts.counts() == sample.counts)
        #expect(countsTransport.lastRequest?.pathAndQuery == "/v1/counts")
        #expect(countsTransport.lastRequest?.httpMethod == "GET")

        let (status, statusTransport) = self.client(.json(sample.aiStatus))
        #expect(try await status.aiStatus() == sample.aiStatus)
        #expect(try await status.testAi() == sample.aiStatus)
        #expect(
            statusTransport.requests.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == [
                "GET /v1/ai/status", "POST /v1/ai/test",
            ])
        #expect(statusTransport.lastRequest?.httpBody == nil)

        let (settings, settingsTransport) = self.client(.json(sample.ai))
        #expect(try await settings.aiSettings() == sample.ai)
        let patch = AiSettingsPatch(credentials: .remove, paused: true)
        #expect(try await settings.updateAiSettings(patch) == sample.ai)
        let sent = settingsTransport.requests
        #expect(sent.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == ["GET /v1/ai", "PATCH /v1/ai"])
        #expect(sent[1].jsonBody == json(#"{"credentials":null,"paused":true}"#))
    }

    @Test func drafts() async throws {
        let draft = sample.drafts[0]
        let (client, transport) = self.client(.json(draft))
        _ = try await client.saveDraft(
            DraftInput(
                inboxId: "inb_northwind", threadId: "thr_1", to: [Address(email: "d@lumen.example")],
                subject: "Re", body: "Yes"))
        _ = try await client.sendDraft(id: draft.id)
        try await client.deleteDraft(id: draft.id)
        let sent = transport.requests
        #expect(
            sent.map { "\($0.httpMethod!) \($0.pathAndQuery)" } == [
                "POST /v1/drafts", "POST /v1/drafts/drf_1/send", "DELETE /v1/drafts/drf_1",
            ])
        #expect(
            sent[0].jsonBody
                == json(
                    #"{"body":"Yes","inboxId":"inb_northwind","subject":"Re","threadId":"thr_1","to":[{"email":"d@lumen.example"}]}"#
                ))

        let (list, listTransport) = self.client(.json(Page(items: [draft])))
        #expect(try await list.listDrafts(ListQuery(cursor: "x")).items == [draft])
        #expect(listTransport.lastRequest?.pathAndQuery == "/v1/drafts?cursor=x")
    }

    @Test func briefs() async throws {
        let (client, transport) = self.client(.json(sample.brief))
        #expect(try await client.latestBrief() == sample.brief)
        #expect(try await client.brief(id: "brf_1") == sample.brief)
        // A caller writes each highlight as a thread and a line; the server adds the subject.
        let input = BriefInput(
            from: time("2026-11-15T17:00:00Z"), to: time("2026-11-16T09:00:00Z"),
            sections: [
                .init(
                    inboxId: "inb_harbor", summary: "Quiet", highlights: [.init(threadId: "thr_6", line: "Due soon.")])
            ])
        _ = try await client.writeBrief(input)
        #expect(transport.requests.map(\.pathAndQuery) == ["/v1/briefs/latest", "/v1/briefs/brf_1", "/v1/briefs"])
        #expect(
            transport.lastRequest?.jsonBody
                == json(
                    #"{"from":"2026-11-15T17:00:00Z","sections":[{"highlights":[{"line":"Due soon.","threadId":"thr_6"}],"inboxId":"inb_harbor","summary":"Quiet"}],"to":"2026-11-16T09:00:00Z"}"#
                ))
        let (none, _) = self.client(.raw("null"))
        #expect(try await none.latestBrief() == nil)
    }

    @Test func theEventStreamRequest() throws {
        let client = APIClient(server: testServer, token: "tok_1", transport: StubTransport())
        let request = try client.eventsRequest()
        #expect(request.pathAndQuery == "/v1/events")
        #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_1")
    }

    @Test func routesThatNeedATokenRefuseWithoutOne() async throws {
        let transport = StubTransport()
        let client = APIClient(server: testServer, transport: transport)
        await #expect(throws: APIError.notPaired) { try await client.listInboxes() }
        #expect(transport.requests.isEmpty)
    }

    @Test func aPathPrefixIsKept() async throws {
        let transport = StubTransport { _ in .json([Inbox]()) }
        let server = try ServerAddress(parsing: "https://example.com/mail/")
        _ = try await APIClient(server: server, token: "t", transport: transport).listInboxes()
        #expect(transport.lastRequest?.url?.absoluteString == "https://example.com/mail/v1/inboxes")
    }
}

struct APIClientErrorTests {
    static let codes: [(String, Int, ErrorCode)] = [
        ("unauthorized", 401, .unauthorized),
        ("forbidden", 403, .forbidden),
        ("not_found", 404, .notFound),
        ("invalid", 400, .invalid),
        ("conflict", 409, .conflict),
        ("needs_person", 403, .needsPerson),
        ("provider_error", 502, .providerError),
        ("internal", 500, .internal),
        ("rate_limited", 429, .rateLimited),
    ]

    @Test(arguments: codes)
    func errorBodiesMapToTheirCode(_ code: String, _ status: Int, _ expected: ErrorCode) async throws {
        let transport = StubTransport { _ in .error(code, "Nope", status: status) }
        let client = APIClient(server: testServer, token: "t", transport: transport)
        await #expect(throws: APIError.server(code: expected, message: "Nope", status: status)) {
            try await client.act(ActInput(threadIds: ["thr_1"], action: .done))
        }
    }

    @Test func aRateLimitSaysToWait() {
        let error = APIError.server(code: .rateLimited, message: "Too many", status: 429)
        #expect(error.localizedDescription.contains("Wait a few minutes"))
        #expect(error.retryAfter == nil)
    }

    @Test func aRateLimitSaysHowLongFromRetryAfter() async throws {
        let transport = StubTransport { _ in
            var reply = StubReply.error("rate_limited", "Too many tries; wait 412 seconds", status: 429)
            reply.headers["Retry-After"] = "412"
            return reply
        }
        let client = APIClient(server: testServer, token: "t", transport: transport)
        do {
            _ = try await client.listInboxes()
            Issue.record("Expected an error")
        } catch let error as APIError {
            #expect(error.code == .rateLimited && error.retryAfter == 412)
            #expect(error.localizedDescription.contains("Wait 7 minutes, then try again"))
        }
        #expect(APIError.wait(seconds: 1) == "1 second" && APIError.wait(seconds: 45) == "45 seconds")
        #expect(APIError.wait(seconds: 60) == "1 minute" && APIError.wait(seconds: 61) == "2 minutes")
        // Anything but whole seconds is ignored.
        #expect(APIClient.error(status: 429, body: Data(), retryAfter: "soon").retryAfter == nil)
        #expect(APIClient.error(status: 429, body: Data(), retryAfter: "-3").retryAfter == nil)
    }

    @Test func aStatusWithoutABodyMapsByStatus() async throws {
        let transport = StubTransport { _ in .raw("<html>Bad gateway</html>", status: 502) }
        let client = APIClient(server: testServer, token: "t", transport: transport)
        do {
            _ = try await client.listInboxes()
            Issue.record("Expected an error")
        } catch let error as APIError {
            #expect(error.code == .providerError)
        }
    }

    @Test func anUnreadableSuccessIsUnexpected() async throws {
        let transport = StubTransport { _ in .raw(#"{"items":"nope"}"#) }
        let client = APIClient(server: testServer, token: "t", transport: transport)
        do {
            _ = try await client.home()
            Issue.record("Expected an error")
        } catch let error as APIError {
            guard case .unexpectedResponse(let status, _) = error else {
                Issue.record("Got \(error)")
                return
            }
            #expect(status == 200)
        }
    }

    @Test func anUnreachableServerSaysSo() async throws {
        let transport = StubTransport { _ in throw URLError(.cannotConnectToHost) }
        let client = APIClient(server: testServer, token: "t", transport: transport)
        do {
            _ = try await client.listInboxes()
            Issue.record("Expected an error")
        } catch let error as APIError {
            #expect(error.isOffline)
        }
    }

    @Test func noContentRoutesAcceptAnEmptyAnswer() async throws {
        let transport = StubTransport { _ in .noContent }
        let client = APIClient(server: testServer, token: "t", transport: transport)
        try await client.syncInbox(id: "inb_harbor")
        try await client.deleteDraft(id: "drf_1")
    }
}

struct ServerAddressTests {
    @Test func acceptsWhatAPersonTypes() throws {
        #expect(try ServerAddress(parsing: "mail.example.com").baseURL.absoluteString == "https://mail.example.com")
        #expect(try ServerAddress(parsing: "192.168.1.20:8787/").baseURL.absoluteString == "http://192.168.1.20:8787")
        #expect(try ServerAddress(parsing: " localhost:8787 ").baseURL.absoluteString == "http://localhost:8787")
        #expect(
            try ServerAddress(parsing: "box.tail1234.ts.net").baseURL.absoluteString == "http://box.tail1234.ts.net")
        #expect(try ServerAddress(parsing: "http://100.101.102.103:8787").displayName == "100.101.102.103:8787")
        #expect(
            try ServerAddress(parsing: "https://example.com/mail//").baseURL.absoluteString
                == "https://example.com/mail")
    }

    @Test func refusesWhatItShouldNot() {
        #expect(throws: ServerAddress.ParseError.empty) { try ServerAddress(parsing: "  ") }
        #expect(throws: ServerAddress.ParseError.insecureHTTP(host: "mail.example.com")) {
            try ServerAddress(parsing: "http://mail.example.com")
        }
        #expect(throws: ServerAddress.ParseError.invalid) { try ServerAddress(parsing: "ftp://mail.example.com") }
        #expect(throws: ServerAddress.ParseError.invalid) { try ServerAddress(parsing: "https://a@mail.example.com") }
    }
}
