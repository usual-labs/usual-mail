import Foundation

@testable import UsualMailKit

/// A stand-in for the store's search: it records what was asked and answers from closures, which may wait.
@MainActor
final class FakeSearch: SearchService {
    var queries: [SearchQuery] = []
    var remoteQueries: [SearchQuery] = []
    var opened: [String] = []
    var asks: [SearchAskInput] = []
    var answer: @MainActor (SearchQuery) async throws -> SearchResult
    var remoteAnswer: @MainActor (SearchQuery) async throws -> RemoteSearchResult = { _ in RemoteSearchResult(items: [])
    }
    var openAnswer: @MainActor (String) async throws -> ThreadDetail = { _ in
        throw APIError.server(code: .notFound, message: "Not found", status: 404)
    }

    var askAnswer: @MainActor (SearchAskInput) async throws -> SearchAskResult = { input in
        SearchAskResult(
            understood: SearchUnderstood(text: input.question), text: input.question, found: false, ai: .working)
    }

    init(answer: @escaping @MainActor (SearchQuery) async throws -> SearchResult = { _ in SearchResult(items: []) }) {
        self.answer = answer
    }

    /// The text of each query asked, in order ("" for none).
    var texts: [String] { queries.map { $0.text ?? "" } }

    func search(_ query: SearchQuery) async throws -> SearchResult {
        queries.append(query)
        return try await answer(query)
    }

    func searchRemote(_ query: SearchQuery) async throws -> RemoteSearchResult {
        remoteQueries.append(query)
        return try await remoteAnswer(query)
    }

    func openRemote(id: String) async throws -> ThreadDetail {
        opened.append(id)
        return try await openAnswer(id)
    }

    func askSearch(_ input: SearchAskInput) async throws -> SearchAskResult {
        asks.append(input)
        return try await askAnswer(input)
    }
}

/// A clock for waits: each sleep waits until the test lets it go, and a cancelled one ends at once.
@MainActor
final class Sleeper {
    private(set) var asked: [Duration] = []
    private var pending: [UUID: CheckedContinuation<Void, any Error>] = [:]

    var waiting: Int { pending.count }

    func sleep(_ duration: Duration) async throws {
        asked.append(duration)
        let id = UUID()
        try await withTaskCancellationHandler {
            try await wait(id)
        } onCancel: {
            Task { @MainActor in self.cancel(id) }
        }
    }

    private func wait(_ id: UUID) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            if Task.isCancelled {
                continuation.resume(throwing: CancellationError())
            } else {
                pending[id] = continuation
            }
        }
    }

    /// Ends every wait.
    func release() {
        let all = pending
        pending = [:]
        for continuation in all.values { continuation.resume() }
    }

    private func cancel(_ id: UUID) {
        pending.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}

/// Lets the main actor's waiting tasks run.
@MainActor
func settle() async {
    for _ in 0..<50 { await Task.yield() }
}

/// A thread for search results.
func searchThread(_ id: String, subject: String = "Subject", done: Bool = false) -> MailThread {
    MailThread(
        id: id, inboxId: "inb_northwind", subject: subject,
        participants: [Address(name: "Dana Whitfield", email: "dana@lumen.example")],
        lastMessageAt: time("2026-11-15T10:00:00Z"), category: .conversation, done: done)
}

/// A model searching `service` with no pause, in Berlin's time zone, at the sample's moment.
@MainActor
func searchModel(_ service: FakeSearch, sleeper: Sleeper? = nil) -> SearchModel {
    let now = SampleData.bundled.now
    let sleep: @Sendable (Duration) async throws -> Void =
        if let sleeper { { try await sleeper.sleep($0) } } else { { _ in } }
    return SearchModel(service: service, sleep: sleep, timeZone: { "Europe/Berlin" }, clock: { now })
}
