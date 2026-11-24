import Foundation
import Synchronization

@testable import UsualMailKit

/// An answer a stub gives to one request.
struct StubReply: Sendable {
    var status = 200
    var body = Data()
    var headers: [String: String] = ["Content-Type": "application/json"]

    static func json(_ value: some Encodable, status: Int = 200) -> StubReply {
        StubReply(status: status, body: try! MailJSON.encoder().encode(value))
    }

    static func raw(_ text: String, status: Int = 200) -> StubReply {
        StubReply(status: status, body: Data(text.utf8))
    }

    static let noContent = StubReply(status: 204)

    static func error(_ code: String, _ message: String, status: Int) -> StubReply {
        .raw(#"{"error":{"code":"\#(code)","message":"\#(message)"}}"#, status: status)
    }
}

/// A transport that records requests and answers them with a closure, without a network.
final class StubTransport: HTTPTransport {
    typealias Handler = @Sendable (URLRequest) async throws -> StubReply
    typealias StreamHandler = @Sendable (URLRequest, Int) async throws -> (Int, AsyncThrowingStream<Data, any Error>)

    private let recorded = Mutex<[URLRequest]>([])
    private let streams = Mutex(0)
    private let handler: Handler
    private let streamHandler: StreamHandler?

    init(handler: @escaping Handler = { _ in StubReply() }, stream: StreamHandler? = nil) {
        self.handler = handler
        self.streamHandler = stream
    }

    var requests: [URLRequest] { recorded.withLock { $0 } }
    var lastRequest: URLRequest? { requests.last }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        recorded.withLock { $0.append(request) }
        let reply = try await handler(request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        return (reply.body, response)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        recorded.withLock { $0.append(request) }
        let attempt = streams.withLock { count in
            count += 1
            return count
        }
        guard let streamHandler else { throw URLError(.unsupportedURL) }
        let (status, chunks) = try await streamHandler(request, attempt)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"])!
        return (response, chunks)
    }
}

extension URLRequest {
    /// The decoded JSON body, for comparing with what the contract expects.
    var jsonBody: JSONValue? {
        httpBody.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
    }

    /// The path and query as sent, for example `/v1/now?inboxId=a`.
    var pathAndQuery: String {
        guard let url else { return "" }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        return components.percentEncodedPath + (components.percentEncodedQuery.map { "?\($0)" } ?? "")
    }
}

/// A one-shot latch: tasks wait until it opens.
actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }
}

let testServer = try! ServerAddress(parsing: "http://mail.local:8787")

func json(_ text: String) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

func encodedJSON(_ value: some Encodable) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: MailJSON.encoder().encode(value))
}

func time(_ text: String) -> Date {
    MailJSON.parseTime(text)!
}
