import Foundation
import Testing
import UsualMailKit

/// A store over `data` (the sample unless given) whose server takes every request and never answers, so what the
/// lists show is what the app shows at once, before the server answers. Its clock is the sample's moment. Cancel the
/// tasks that wait on it when done.
@MainActor
func heldStore(_ data: SampleData = .bundled) async throws -> MailStore {
    let client = APIClient(
        server: try ServerAddress(parsing: "mail.example.com"), token: "held", transport: HeldTransport())
    let now = data.now
    let store = MailStore(client: client, local: try await LocalStore.sample(data), clock: { now })
    await store.loadFromDisk()
    return store
}

/// Polls until `condition` holds, for what a task the test started reaches without telling it.
@MainActor
func waitUntil(_ what: String, timeout: Duration = .seconds(5), _ condition: () -> Bool) async throws {
    let start = ContinuousClock.now
    while !condition() {
        guard ContinuousClock.now - start < timeout else {
            Issue.record("Timed out waiting until \(what)")
            throw CancellationError()
        }
        try await Task.sleep(for: .milliseconds(5))
    }
}

/// A server that never answers: each request waits until its task is cancelled.
private struct HeldTransport: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await Task.sleep(for: .seconds(600))
        throw URLError(.timedOut)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        try await Task.sleep(for: .seconds(600))
        throw URLError(.timedOut)
    }
}
