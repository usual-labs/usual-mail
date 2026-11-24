import Foundation
import Synchronization
import Testing

@testable import UsualMailKit

struct SSEParserTests {
    private func parse(_ chunks: [String]) -> [ServerSentEvent] {
        var parser = SSEParser()
        return chunks.flatMap { parser.feed(Data($0.utf8)) }
    }

    @Test func oneEventPerBlankLine() {
        let events = parse(["event: thread.changed\ndata: {\"a\":1}\n\nevent: brief.ready\ndata: {}\n\n"])
        #expect(
            events == [
                ServerSentEvent(event: "thread.changed", data: #"{"a":1}"#),
                ServerSentEvent(event: "brief.ready", data: "{}"),
            ])
    }

    @Test func chunksMaySplitAnywhere() {
        let stream =
            "event: inbox.removed\r\ndata: {\"inboxId\":\"caf\u{E9}\"}\r\n\r\n: keep-alive\n\ndata: x\r\rdata: y\n\n"
        let whole = parse([stream])
        let bytes = Array(stream.utf8)
        var parser = SSEParser()
        var byByte: [ServerSentEvent] = []
        for byte in bytes { byByte += parser.feed(Data([byte])) }
        #expect(byByte == whole)
        #expect(
            whole == [
                ServerSentEvent(event: "inbox.removed", data: #"{"inboxId":"café"}"#),
                ServerSentEvent(data: "x"),
                ServerSentEvent(data: "y"),
            ])
        // Split inside the CR LF pair and inside the two bytes of "é".
        let cut = bytes.firstIndex(of: 0xC3)! + 1
        var halves = SSEParser()
        let split = halves.feed(Data(bytes[..<cut])) + halves.feed(Data(bytes[cut...]))
        #expect(split == whole)
    }

    @Test func commentsAreIgnored() {
        #expect(parse([": ping\n\n", ":\n", "data: real\n\n"]) == [ServerSentEvent(data: "real")])
    }

    @Test func multiLineDataJoinsWithLineBreaks() {
        let events = parse(["data: {\n", "data:  \"a\": 1\n", "data:\n", "data: }\n\n"])
        #expect(events == [ServerSentEvent(data: "{\n \"a\": 1\n\n}")])
    }

    @Test func fieldsWithoutDataDispatchNothing() {
        #expect(parse(["event: thread.changed\n\n", "id: 7\nretry: 3000\n\n"]).isEmpty)
        var parser = SSEParser()
        _ = parser.feed(Data("id: 7\nretry: 3000\nretry: soon\n\n".utf8))
        #expect(parser.lastEventID == "7")
        #expect(parser.retry == 3000)
        #expect(parser.feed(Data("data: a\n\n".utf8)).first?.id == "7")
    }

    @Test func aLeadingByteOrderMarkIsDropped() {
        #expect(parse(["\u{FEFF}data: hi\n\n"]) == [ServerSentEvent(data: "hi")])
    }

    @Test func anUnfinishedEventIsDropped() {
        var parser = SSEParser()
        #expect(parser.feed(Data("data: half".utf8)).isEmpty)
        parser.finish()
        #expect(parser.feed(Data("\n\n".utf8)).isEmpty)
    }

    @Test func aLineWithoutAColonIsAFieldName() {
        #expect(parse(["data\n\n"]) == [ServerSentEvent(data: "")])
    }
}

struct EventStreamTests {
    /// The SSE text for a list of events, as the server sends it.
    private func frames(_ events: [MailEvent]) throws -> String {
        try events.map { event in
            "event: \(event.type)\ndata: \(String(decoding: try MailJSON.encoder().encode(event), as: UTF8.self))\n\n"
        }.joined()
    }

    private func chunks(_ text: String, size: Int = 7, thenFail: Bool = false) -> AsyncThrowingStream<Data, any Error> {
        let bytes = Array(text.utf8)
        return AsyncThrowingStream { continuation in
            var start = 0
            while start < bytes.count {
                continuation.yield(Data(bytes[start..<min(start + size, bytes.count)]))
                start += size
            }
            continuation.finish(throwing: thenFail ? URLError(.networkConnectionLost) : nil)
        }
    }

    @Test func yieldsEventsAndReconnectsWithGrowingWaits() async throws {
        let sample = SampleData.bundled
        let first = try frames([.threadChanged(sample.threads[0]), .briefReady(briefId: "brf_2")]) + ": ping\n\n"
        let second = try frames([.triagePending(inboxId: "inb_harbor", count: 2)])
        let transport = StubTransport(stream: { _, attempt in
            switch attempt {
            case 1: (200, self.chunks(first, thenFail: true))
            case 2: throw URLError(.notConnectedToInternet)
            case 3: (503, self.chunks(""))
            case 4: (200, self.chunks(second))
            default: (401, self.chunks(""))
            }
        })
        let sleeps = Mutex<[Duration]>([])
        let stream = EventStream(
            client: APIClient(server: testServer, token: "t", transport: transport),
            backoff: .init(initial: .seconds(1), maximum: .seconds(3)),
            sleep: { duration in sleeps.withLock { $0.append(duration) } })

        var updates: [EventStream.Update] = []
        for await update in stream.updates() { updates.append(update) }

        let kinds = updates.map { update -> String in
            switch update {
            case .connected(let again): again ? "reconnected" : "connected"
            case .event(let event): event.type
            case .disconnected: "disconnected"
            case .unauthorized: "unauthorized"
            }
        }
        #expect(
            kinds == [
                "connected", "thread.changed", "brief.ready", "disconnected",
                "disconnected", "disconnected",
                "reconnected", "triage.pending", "disconnected",
                "unauthorized",
            ])
        #expect(updates[1] == .event(.threadChanged(sample.threads[0])))
        // 1 s, then doubling, capped at 3 s; reset after the fourth try connects.
        #expect(sleeps.withLock { $0 } == [.seconds(1), .seconds(2), .seconds(3), .seconds(1)])
        #expect(transport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer t" })
    }

    @Test func aBadEventDoesNotCloseTheStream() async throws {
        let good = try frames([.inboxRemoved(inboxId: "inb_personal")])
        let text = "event: thread.changed\ndata: {not json\n\n" + good
        let transport = StubTransport(stream: { _, attempt in
            attempt == 1 ? (200, self.chunks(text)) : (401, self.chunks(""))
        })
        let stream = EventStream(
            client: APIClient(server: testServer, token: "t", transport: transport), sleep: { _ in })
        var events: [MailEvent] = []
        for await update in stream.updates() {
            if case .event(let event) = update { events.append(event) }
        }
        #expect(events == [.inboxRemoved(inboxId: "inb_personal")])
    }

    @Test func theServersRetryTimeSetsTheFirstWait() async throws {
        let transport = StubTransport(stream: { _, attempt in
            attempt == 1 ? (200, self.chunks("retry: 250\n\n")) : (401, self.chunks(""))
        })
        let sleeps = Mutex<[Duration]>([])
        let stream = EventStream(
            client: APIClient(server: testServer, token: "t", transport: transport),
            sleep: { duration in sleeps.withLock { $0.append(duration) } })
        for await _ in stream.updates() {}
        #expect(sleeps.withLock { $0 } == [.milliseconds(250)])
    }

    @Test func stoppingTheListenerStopsTheStream() async throws {
        let transport = StubTransport(stream: { _, _ in
            // Never ends: the continuation is kept alive until the stream is cancelled.
            (
                200,
                AsyncThrowingStream<Data, any Error> { continuation in
                    continuation.onTermination = { _ in _ = continuation }
                }
            )
        })
        let stream = EventStream(client: APIClient(server: testServer, token: "t", transport: transport))
        for await update in stream.updates() {
            #expect(update == .connected(isReconnect: false))
            break
        }
        #expect(transport.requests.count == 1)
    }
}
