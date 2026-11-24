import Foundation

/// Sends requests to the server. `URLSessionTransport` uses the network; tests pass a stub.
public protocol HTTPTransport: Sendable {
    /// One request and its whole response.
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
    /// A request whose response body arrives in pieces, for the event stream. The stream ends when the
    /// server closes the connection and throws when it breaks.
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }

    public func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>)
    {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        // `AsyncBytes.lines` drops empty lines, which end each server-sent event, so this passes on raw
        // bytes, a line at a time.
        let chunks = AsyncThrowingStream<Data, any Error> { continuation in
            let reader = Task {
                var line = Data()
                do {
                    for try await byte in bytes {
                        line.append(byte)
                        if byte == 0x0A || line.count >= 16_384 {
                            continuation.yield(line)
                            line.removeAll(keepingCapacity: true)
                        }
                    }
                    if !line.isEmpty { continuation.yield(line) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in reader.cancel() }
        }
        return (http, chunks)
    }
}
