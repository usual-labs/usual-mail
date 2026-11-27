import Foundation
import Testing

@testable import UsualMailKit

/// Unsubscribing from a sender (docs/contract.md, "Unsubscribing"; the owner's request of 2026-11-27), as core's
/// unsubscribe.ts shapes it: the request, the blocked sender carrying it, `unsubscribe.changed`, the browser agent in
/// the AI's settings and its patch, the route, and core's words before a key is saved.
struct UnsubscribeModelTests {
    /// A request as the server answers it, every field there.
    static let answered = #"""
        {"inboxId":"inb_harbor","address":"news@roastersmonthly.example","threadId":"thr_8","state":"needs_person",
         "way":"page","url":"https://roastersmonthly.example/unsubscribe?u=1","detail":"Their page needs you.",
         "askedAt":"2026-11-27T09:00:00Z","updatedAt":"2026-11-27T09:01:00Z","version":3}
        """#

    @Test func aRequestDecodesAndEncodesAsCoreHasIt() throws {
        let unsubscribe = try MailJSON.decoder().decode(Unsubscribe.self, from: Data(Self.answered.utf8))
        #expect(unsubscribe.state == .needsPerson && unsubscribe.way == .page && unsubscribe.version == 3)
        #expect(unsubscribe.key == SenderKey(inboxId: "inb_harbor", address: "News@RoastersMonthly.example"))
        #expect(unsubscribe.page?.absoluteString == "https://roastersmonthly.example/unsubscribe?u=1")
        #expect(try encodedJSON(unsubscribe) == json(Self.answered))
        // Working at first: no way yet, no page, no words; written without them.
        let working = Unsubscribe(
            inboxId: "inb_harbor", address: "news@roastersmonthly.example", threadId: "thr_8", state: .working,
            askedAt: time("2026-11-27T09:00:00Z"), updatedAt: time("2026-11-27T09:00:00Z"))
        #expect(
            try encodedJSON(working)
                == json(
                    #"{"inboxId":"inb_harbor","address":"news@roastersmonthly.example","threadId":"thr_8","state":"working","askedAt":"2026-11-27T09:00:00Z","updatedAt":"2026-11-27T09:00:00Z","version":1}"#
                ))
        // Every way and state core names, and one a newer server may send, kept as it came.
        #expect(UnsubscribeWay.known.map(\.rawValue) == ["one_click", "email", "browser_agent", "page"])
        #expect(UnsubscribeState.known.map(\.rawValue) == ["working", "done", "needs_person", "failed"])
        #expect(UnsubscribeState(rawValue: "queued") == .unknown("queued"))
    }

    /// The page comes from the sender's mail: only an https address with a host is ever offered to open.
    @Test func onlyAnHttpsPageIsOffered() {
        var unsubscribe = Unsubscribe(
            inboxId: "inb_harbor", address: "news@roastersmonthly.example", threadId: "thr_8", state: .needsPerson,
            askedAt: .now, updatedAt: .now)
        for url in [
            "http://roastersmonthly.example/u", "javascript:alert(1)", "mailto:u@roastersmonthly.example", "https://",
        ] {
            unsubscribe.url = url
            #expect(unsubscribe.page == nil, "\(url)")
        }
        unsubscribe.url = "HTTPS://roastersmonthly.example/u"
        #expect(unsubscribe.page != nil)
    }

    @Test func aBlockedSenderCarriesItOnlyWhenOneWasAsked() throws {
        let sender = SampleData.bundled.blockedSenders[0]
        let written = try encodedJSON(sender)
        #expect(sender.unsubscribe == nil && written["unsubscribe"] == nil)
        guard case .object(var fields) = written else { throw NotAnObject() }
        fields["unsubscribe"] = json(Self.answered)
        let decoded = try MailJSON.decoder().decode(BlockedSender.self, from: MailJSON.encoder().encode(fields))
        #expect(decoded.unsubscribe?.state == .needsPerson)
        #expect(try encodedJSON(decoded) == .object(fields), "written back as it came")
    }

    @Test func theEventDecodesAndEncodesAsCoreHasIt() throws {
        let event = try MailJSON.decoder().decode(
            MailEvent.self, from: Data(#"{"type":"unsubscribe.changed","unsubscribe":\#(Self.answered)}"#.utf8))
        guard case .unsubscribeChanged(let unsubscribe) = event else {
            Issue.record("Not an unsubscribe change: \(event)")
            return
        }
        #expect(unsubscribe.version == 3 && event.type == "unsubscribe.changed")
        #expect(try MailJSON.decoder().decode(MailEvent.self, from: MailJSON.encoder().encode(event)) == event)
    }

    @Test func theBrowserAgentInTheSettingsAndThePatch() throws {
        // Absent while none is set up, as the sample's settings have it.
        #expect(SampleData.bundled.ai.browserAgent == nil)
        guard case .object(var fields) = try encodedJSON(SampleData.bundled.ai) else { throw NotAnObject() }
        #expect(fields["browserAgent"] == nil)
        fields["browserAgent"] = json(
            #"{"service":"browser_use","state":"out_of_credit","detail":"Add credit at Browser Use."}"#)
        let settings = try MailJSON.decoder().decode(AiSettings.self, from: MailJSON.encoder().encode(fields))
        #expect(
            settings.browserAgent
                == BrowserAgentSettings(
                    service: .browserUse, state: .outOfCredit, detail: "Add credit at Browser Use."))
        // A key replaces the stored one whole; null removes it; the key is a secret to keep out of words.
        let set = AiSettingsPatch(browserAgent: .set(BrowserAgentCredentials(apiKey: "not-a-real-key")))
        #expect(try encodedJSON(set) == json(#"{"browserAgent":{"service":"browser_use","apiKey":"not-a-real-key"}}"#))
        #expect(set.secrets == ["not-a-real-key"])
        #expect(try encodedJSON(AiSettingsPatch(browserAgent: .remove)) == json(#"{"browserAgent":null}"#))
        #expect(try encodedJSON(AiSettingsPatch(paused: true)) == json(#"{"paused":true}"#))
        #expect(BrowserAgentState.known.map(\.rawValue) == ["working", "key_refused", "out_of_credit", "unavailable"])
    }

    @Test func theRouteAsCoreNamesIt() async throws {
        let transport = StubTransport { _ in .raw(Self.answered) }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        let answer = try await client.unsubscribe(threadId: "thr/8")
        #expect(answer.state == .needsPerson)
        let request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "POST" && request.pathAndQuery == "/v1/threads/thr%2F8/unsubscribe")
        #expect(request.httpBody == nil)
    }
}

/// The words shown before a Browser Use key is saved are core's `BROWSER_AGENT_DISCLOSURE`, word for word.
struct BrowserAgentDisclosureTests {
    /// core/src/unsubscribe.ts, found from this file: apps/Packages/UsualMailKit/Tests/UsualMailKitTests/.
    static let core = SampleFreshnessTests.coreSample
        .deletingLastPathComponent()  // fixtures
        .deletingLastPathComponent()  // core
        .appending(path: "src/unsubscribe.ts")

    @Test func theWordsAreCores() throws {
        let source = try String(contentsOf: Self.core, encoding: .utf8)
        #expect(source.contains(#"title: "\#(BrowserAgentDisclosure.title)""#))
        #expect(BrowserAgentDisclosure.lines.count == 4)
        for line in BrowserAgentDisclosure.lines {
            #expect(source.contains(#""\#(line)""#), "Not in core/src/unsubscribe.ts: \(line)")
        }
    }
}

/// The list keeps each sender's newest unsubscribe, whichever comes first: the row, or the event.
struct BlockedSenderUnsubscribeListTests {
    let sample = SampleData.bundled

    private func request(_ sender: BlockedSender, _ state: UnsubscribeState, version: Int) -> Unsubscribe {
        Unsubscribe(
            inboxId: sender.inboxId, address: sender.address, threadId: "thr_28", state: state,
            askedAt: sample.now, updatedAt: sample.now, version: version)
    }

    @Test func theHigherVersionWins() {
        let linkboost = sample.blockedSenders[0]
        var list = BlockedSenderList(sample.blockedSenders)
        list.apply(request(linkboost, .working, version: 2))
        #expect(list.items[0].unsubscribe?.state == .working)
        list.apply(request(linkboost, .done, version: 4))
        #expect(list.items[0].unsubscribe?.state == .done)
        // An older copy, arriving late, changes nothing; the others' rows are untouched.
        list.apply(request(linkboost, .working, version: 3))
        #expect(list.items[0].unsubscribe?.version == 4)
        #expect(list.items.dropFirst().allSatisfy { $0.unsubscribe == nil })
    }

    @Test func oneSeenBeforeItsRowIsGivenToTheRow() {
        var blocked = sample.blockedSenders[1]
        blocked.address = "news@roastersmonthly.example"
        var list = BlockedSenderList(sample.blockedSenders)
        list.apply(request(blocked, .working, version: 1))
        #expect(!list.contains(blocked.id))
        // The row comes without one (the event about the block was written before the asking).
        list.insert(blocked)
        #expect(list.items.first { $0.id == blocked.id }?.unsubscribe?.state == .working)
        // A row with a newer one keeps its own.
        blocked.unsubscribe = request(blocked, .failed, version: 5)
        list.insert(blocked)
        #expect(list.items.first { $0.id == blocked.id }?.unsubscribe?.state == .failed)
        blocked.unsubscribe = nil
        list.insert(blocked)
        #expect(list.items.first { $0.id == blocked.id }?.unsubscribe?.version == 5)
    }
}

/// A JSON value that should have been an object.
private struct NotAnObject: Error {}
