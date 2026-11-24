import Foundation

/// Listens to `GET /v1/events` and reconnects when the connection drops, waiting longer after each
/// failure. The server doesn't replay what was missed, so `connected(isReconnect: true)` tells the
/// listener to reload its lists.
public struct EventStream: Sendable {
    public enum Update: Hashable, Sendable {
        /// The stream is open. After a reconnect, lists may have missed changes and should reload.
        case connected(isReconnect: Bool)
        case event(MailEvent)
        /// The connection dropped or couldn't be made; the next try comes after `retryIn`.
        case disconnected(reason: String, retryIn: Duration)
        /// The server refused the token. The stream stops; the device must pair again.
        case unauthorized
    }

    /// How long to wait before each new try: `initial`, doubling up to `maximum`. Resets once connected.
    public struct Backoff: Hashable, Sendable {
        public var initial: Duration
        public var maximum: Duration

        public init(initial: Duration = .seconds(1), maximum: Duration = .seconds(60)) {
            self.initial = initial
            self.maximum = maximum
        }

        public func delay(afterFailures failures: Int, initial override: Duration? = nil) -> Duration {
            let start = override ?? initial
            let factor = 1 << min(max(failures, 0), 16)
            return min(start * factor, maximum)
        }
    }

    private let client: APIClient
    private let backoff: Backoff
    private let sleep: @Sendable (Duration) async throws -> Void

    public init(
        client: APIClient, backoff: Backoff = Backoff(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.client = client
        self.backoff = backoff
        self.sleep = sleep
    }

    /// Connects and keeps reconnecting until the caller stops iterating or the token is refused.
    public func updates() -> AsyncStream<Update> {
        AsyncStream { continuation in
            let task = Task {
                await run(continuation)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ continuation: AsyncStream<Update>.Continuation) async {
        var failures = 0
        var hasConnected = false
        var serverRetry: Duration?
        while !Task.isCancelled {
            let reason: String
            do {
                let (response, chunks) = try await client.transport.stream(for: client.eventsRequest())
                if response.statusCode == 401 {
                    continuation.yield(.unauthorized)
                    return
                }
                guard (200..<300).contains(response.statusCode) else {
                    throw APIClient.error(status: response.statusCode, body: Data())
                }
                continuation.yield(.connected(isReconnect: hasConnected))
                hasConnected = true
                failures = 0
                var parser = SSEParser()
                for try await chunk in chunks {
                    for message in parser.feed(chunk) {
                        if let event = Self.decode(message) { continuation.yield(.event(event)) }
                    }
                    if let retry = parser.retry { serverRetry = .milliseconds(retry) }
                }
                parser.finish()
                reason = "The server closed the connection."
            } catch {
                if error is CancellationError || Task.isCancelled { return }
                let mapped = error is APIError ? error : APIClient.transportError(error)
                if mapped is CancellationError { return }
                if case .notPaired = mapped as? APIError {
                    continuation.yield(.unauthorized)
                    return
                }
                reason = (mapped as? APIError)?.localizedDescription ?? mapped.localizedDescription
            }
            let delay = backoff.delay(afterFailures: failures, initial: serverRetry)
            failures += 1
            continuation.yield(.disconnected(reason: reason, retryIn: delay))
            do {
                try await sleep(delay)
            } catch {
                return
            }
        }
    }

    /// The event in a message's data. A message that isn't a readable event is skipped, so one bad event
    /// doesn't close the stream.
    static func decode(_ message: ServerSentEvent) -> MailEvent? {
        try? MailJSON.decoder().decode(MailEvent.self, from: Data(message.data.utf8))
    }
}
