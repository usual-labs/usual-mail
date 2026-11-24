import Foundation

// Search's routes (docs/contract-search.md): `search`, `searchRemote`, `openRemote` and `askSearch` in
// `core/src/api.ts`.

extension APIClient {
    /// `GET /v1/search`: threads the server holds that the text and filters find, with where they matched, what the
    /// server understood and, on a first page with text, the people whose name or address matches. A person or an
    /// agent, in the inboxes it may see.
    public func search(_ query: SearchQuery) async throws -> SearchResult {
        try await send(request(.get, "/v1/search", query: query.parameters))
    }

    /// `GET /v1/search/remote`: the same query sent to each inbox's mailbox, for older mail the server doesn't hold.
    /// Person only. Nothing found is stored; at most 10 remote searches and openings a minute per device
    /// (`rate_limited` with `Retry-After` beyond).
    public func searchRemote(_ query: SearchQuery) async throws -> RemoteSearchResult {
        try await send(request(.get, "/v1/search/remote", query: query.parameters))
    }

    /// `POST /v1/search/remote/:id/open`: brings that conversation in from the mailbox and answers its detail, placed as
    /// the mailbox has it (archived there is done here). Person only; the same thread when called again.
    public func openRemote(id: String) async throws -> ThreadDetail {
        try await send(request(.post, "/v1/search/remote/\(Self.segment(id))/open"))
    }

    /// `POST /v1/search/ask`: the server's AI turns a sentence into the filters and text a search takes; it searches
    /// nothing. Person only; only the sentence and today's date go to the AI. At most 10 sentences a minute per device
    /// (`rate_limited` with `Retry-After` beyond); the server answers within about 15 seconds.
    public func askSearch(_ input: SearchAskInput) async throws -> SearchAskResult {
        try await send(request(.post, "/v1/search/ask", body: input))
    }
}
