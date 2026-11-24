import Foundation

extension MailStore {
    /// A store showing the sample with no server behind it, for previews. It reads as offline, so an
    /// action shows and is then taken back, as it would be without a connection; only search answers, from the sample
    /// itself (`SampleSearch`).
    public static func sample(_ data: SampleData = .bundled, openThread: String? = nil) async throws -> MailStore {
        let client = APIClient(
            server: try ServerAddress(parsing: "mail.example.com"), token: "sample",
            transport: SampleTransport(data: data))
        let now = data.now
        let store = MailStore(client: client, local: try await LocalStore.sample(data), clock: { now })
        await store.loadFromDisk()
        // Not kept on disk, so given here as a person's device would fetch them.
        store.firstSyncWindow = data.firstSync
        store.aiUsage = data.aiUsage
        store.blockedSenders = BlockedSenderList(data.blockedSenders)
        store.isSample = true
        // Only looks: with no server, marking it read would be taken back at once.
        if let openThread { await store.open(threadID: openThread, markingRead: false) }
        return store
    }
}

/// A transport that is always offline.
struct OfflineTransport: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        throw URLError(.notConnectedToInternet)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        throw URLError(.notConnectedToInternet)
    }
}
